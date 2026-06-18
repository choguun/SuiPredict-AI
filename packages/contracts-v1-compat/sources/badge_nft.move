/// Kiosk-compatible badge NFTs for streak milestones (PRD §4.2).
///
/// Each tier (3d / 7d / 14d / 30d / 100d) mints a `StreakBadge` owned
/// by the user. The badge is `key + store` so it can live in a Kiosk;
/// the module also publishes a default `TransferPolicy<StreakBadge>`
/// so the badges can be listed on TradePort or any kiosk-aware market.
///
/// Eligibility is gated by `streak_system::claim_badge`, which checks
/// the per-tier threshold against `longest_streak` and aborts on
/// double-claim. The badge NFT is therefore the *visual* representation
/// of the on-chain flag — the `claimed_tiers` vector inside `UserStreak`
/// remains the source of truth.
#[allow(unused_const, lint(self_transfer, share_owned))]
module suipredict_agent_policy::badge_nft;

use std::string::{Self, String};
use sui::clock::{Self, Clock};
use sui::event;
use sui::kiosk::{Self, Kiosk, KioskOwnerCap};
use sui::object::{Self, ID, UID};
use sui::package;
use sui::transfer;
use sui::transfer_policy;
use sui::tx_context::TxContext;
use suipredict_agent_policy::streak_system::{Self, UserStreak};

// ============================================================
// One-time witness
// ============================================================

/// OTW must match the module name in uppercase. Consumed exactly once
/// in `init` to claim a `Publisher` for the badge type.
public struct BADGE_NFT has drop {}

// ============================================================
// Error codes
// ============================================================

const ENotStreakOwner: u64 = 0;
const EInvalidTier: u64 = 1;

// ============================================================
// Tier metadata
// ============================================================

/// Human-readable name for each tier. Index `tier - 1` into this array.
/// Embedded in the badge so wallets can render it without an off-chain
/// metadata service.
fun tier_name(tier: u8): String {
    if (tier == 1) string::utf8(b"Bronze Predictor")
    else if (tier == 2) string::utf8(b"Silver Predictor")
    else if (tier == 3) string::utf8(b"Gold Predictor")
    else if (tier == 4) string::utf8(b"Platinum Predictor")
    else if (tier == 5) string::utf8(b"Diamond Predictor")
    else string::utf8(b"Unknown")
}

fun tier_threshold(tier: u8): u64 {
    if (tier == 1) 3
    else if (tier == 2) 7
    else if (tier == 3) 14
    else if (tier == 4) 30
    else if (tier == 5) 100
    else 0
}

// ============================================================
// Badge object
// ============================================================

/// `key + store` so the badge can be placed in a Kiosk. The fields are
/// frozen at mint time — the badge is a memento of *when* the streak
/// crossed the threshold, not a live readout of the current streak.
public struct StreakBadge has key, store {
    id: UID,
    owner: address,
    tier: u8,
    name: String,
    threshold_days: u64,
    /// Snapshot of `longest_streak` at mint time (so the badge keeps the
    /// "earned at 42 days" pedigree even if the user's streak resets).
    longest_streak_at_mint: u64,
    minted_at_ms: u64,
}

// ============================================================
// Events
// ============================================================

public struct BadgeMinted has copy, drop {
    user: address,
    tier: u8,
    badge_id: ID,
    longest_streak_at_mint: u64,
    minted_at_ms: u64,
}

public struct BadgePlacedInKiosk has copy, drop {
    user: address,
    badge_id: ID,
    kiosk_id: ID,
}

// ============================================================
// Init — claim Publisher, share default TransferPolicy
// ============================================================

/// `init` runs once at publish. It claims a `Publisher` for the badge
/// type, creates a default empty `TransferPolicy<StreakBadge>` (no
/// royalty / no rules — anyone can trade), shares the policy, and
/// transfers the `Publisher` + `TransferPolicyCap` to the deployer for
/// future policy edits (royalty rules, allowlists, etc.).
fun init(otw: BADGE_NFT, ctx: &mut TxContext) {
    let publisher = package::claim(otw, ctx);
    let (policy, cap) = transfer_policy::new<StreakBadge>(&publisher, ctx);
    transfer::public_share_object(policy);
    transfer::public_transfer(cap, ctx.sender());
    transfer::public_transfer(publisher, ctx.sender());
}

// ============================================================
// Mint paths
// ============================================================

/// Mint a badge for the calling user's streak. Aborts if:
///   - sender doesn't own the streak,
///   - tier is not 1..5,
///   - `longest_streak < tier_threshold` (delegated to
///     `streak_system::claim_badge`),
///   - the tier has already been claimed (delegated to same).
///
/// The badge is transferred directly to the sender. To place it in a
/// kiosk in the same tx, use `mint_badge_to_kiosk`.
public fun mint_badge(
    streak: &mut UserStreak,
    tier: u8,
    clock: &Clock,
    ctx: &mut TxContext,
): ID {
    assert_eligible(streak, tier, ctx);
    // Mark claimed in streak_system. This aborts on double-claim and
    // on insufficient `longest_streak`, so the badge can only be minted
    // once per (user, tier).
    streak_system::claim_badge(streak, tier, ctx);

    let snapshot = streak_system::longest_streak(streak);
    let badge = build_badge(snapshot, tier, clock, ctx);
    let badge_id = object::id(&badge);

    event::emit(BadgeMinted {
        user: ctx.sender(),
        tier,
        badge_id,
        longest_streak_at_mint: snapshot,
        minted_at_ms: clock::timestamp_ms(clock),
    });

    transfer::transfer(badge, ctx.sender());
    badge_id
}

/// Mint a badge straight into the user's kiosk. Skips the transfer-to-sender
/// hop, so the badge is immediately listable / displayable on TradePort.
public fun mint_badge_to_kiosk(
    streak: &mut UserStreak,
    tier: u8,
    kiosk: &mut Kiosk,
    kiosk_cap: &KioskOwnerCap,
    clock: &Clock,
    ctx: &mut TxContext,
): ID {
    assert_eligible(streak, tier, ctx);
    streak_system::claim_badge(streak, tier, ctx);

    let snapshot = streak_system::longest_streak(streak);
    let badge = build_badge(snapshot, tier, clock, ctx);
    let badge_id = object::id(&badge);
    let kiosk_id = object::id(kiosk);

    event::emit(BadgeMinted {
        user: ctx.sender(),
        tier,
        badge_id,
        longest_streak_at_mint: snapshot,
        minted_at_ms: clock::timestamp_ms(clock),
    });
    event::emit(BadgePlacedInKiosk { user: ctx.sender(), badge_id, kiosk_id });

    kiosk::place(kiosk, kiosk_cap, badge);
    badge_id
}

// ============================================================
// Reads
// ============================================================

public fun owner_of(badge: &StreakBadge): address { badge.owner }
public fun tier_of(badge: &StreakBadge): u8 { badge.tier }
public fun name_of(badge: &StreakBadge): &String { &badge.name }
public fun threshold_days(badge: &StreakBadge): u64 { badge.threshold_days }
public fun longest_streak_at_mint(badge: &StreakBadge): u64 {
    badge.longest_streak_at_mint
}
public fun minted_at_ms(badge: &StreakBadge): u64 { badge.minted_at_ms }

// ============================================================
// Internal
// ============================================================

fun assert_eligible(streak: &UserStreak, tier: u8, ctx: &TxContext) {
    assert!(ctx.sender() == streak_system::owner_of(streak), ENotStreakOwner);
    assert!(tier >= 1 && tier <= 5, EInvalidTier);
}

fun build_badge(
    longest: u64,
    tier: u8,
    clock: &Clock,
    ctx: &mut TxContext,
): StreakBadge {
    StreakBadge {
        id: object::new(ctx),
        owner: ctx.sender(),
        tier,
        name: tier_name(tier),
        threshold_days: tier_threshold(tier),
        longest_streak_at_mint: longest,
        minted_at_ms: clock::timestamp_ms(clock),
    }
}

// ============================================================
// Test helpers
// ============================================================

#[test_only]
public fun init_for_testing(ctx: &mut TxContext) {
    init(BADGE_NFT {}, ctx);
}

#[test_only]
public fun destroy_badge_for_testing(badge: StreakBadge) {
    let StreakBadge {
        id, owner: _, tier: _, name: _, threshold_days: _,
        longest_streak_at_mint: _, minted_at_ms: _,
    } = badge;
    object::delete(id);
}
