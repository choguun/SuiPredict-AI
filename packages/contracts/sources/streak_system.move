/// Daily streak system for SuiPredict gamification.
///
/// Tracks per-user participation across daily prediction rounds, applies
/// yield multipliers at streak thresholds, and tracks earned badge tiers
/// (as a flag list — no NFT/Kiosk for MVP; v2 migration documented).
///
/// `StreakAdmin` is a shared capability gating backend writes. The user
/// owns their own `UserStreak` and can read it freely.
#[allow(unused_const, unused_field)]
module suipredict_agent_policy::streak_system;

use std::option::{Self, Option};
use std::vector;
use sui::clock::{Self, Clock};
use sui::event;
use sui::object::{Self, ID, UID};
use sui::table::{Self, Table};
use sui::transfer;
use sui::tx_context::TxContext;

// ============================================================
// Day & outcome constants
// ============================================================

const MILLISECONDS_PER_DAY: u64 = 86_400_000;

/// Outcome the backend writes for a user-day.
const OUTCOME_NOT_SUBMITTED: u8 = 0;
const OUTCOME_ALL_CORRECT: u8 = 1;
const OUTCOME_SOME_WRONG: u8 = 2;

/// Multiplier tiers (0..4) — index into `TIER_THRESHOLDS` / `TIER_MULTIPLIER_BPS`.
const TIER_NONE: u8 = 0;
const TIER_BRONZE: u8 = 1; // 3d
const TIER_SILVER: u8 = 2; // 7d
const TIER_GOLD: u8 = 3; // 14d
const TIER_PLATINUM: u8 = 4; // 30d
const TIER_DIAMOND: u8 = 5; // 100d

/// Streak thresholds (in days) for each tier; index 0 = tier 1.
const TIER_THRESHOLDS: vector<u64> = vector[3, 7, 14, 30, 100];

/// Multiplier bps for each tier; index 0 = tier 1.
const TIER_MULTIPLIER_BPS: vector<u64> = vector[11_000, 13_000, 17_000, 25_000, 30_000];

// ============================================================
// Error codes
// ============================================================

const ENotAdmin: u64 = 0;
const EStreakExists: u64 = 1;
const EStreakBroken: u64 = 2;
const EAlreadyRecordedToday: u64 = 3;
const EInvalidOutcome: u64 = 4;
const EInvalidTier: u64 = 5;
const EBadgeAlreadyClaimed: u64 = 6;
const EBadgeNotReached: u64 = 7;
const EInvalidNewAdmin: u64 = 8;

// ============================================================
// Capability: shared StreakAdmin gates backend writes
// ============================================================

/// Capability created at module init. Backend address holds this and is
/// the only allowed writer to `record_participation`.
public struct StreakAdmin has key {
    id: UID,
    admin: address,
}

/// Lightweight per-user lookup table mapping `user -> UserStreak` ID.
/// Allows the backend to look up a user's streak by address without
/// requiring the user to pass it as a transaction argument.
public struct StreakRegistry has key {
    id: UID,
    streaks: Table<address, ID>,
}

// ============================================================
// User streak object
// ============================================================

/// Per-user streak state. Owned by the user.
public struct UserStreak has key {
    id: UID,
    owner: address,
    current_streak: u64,
    longest_streak: u64,
    /// Day index of the most recent participation (or 0 if never).
    last_participation_day: u64,
    /// True once the user has ever recorded a participation.
    /// Used to disambiguate "first time" from a real day_index == 0.
    has_participated: bool,
    total_participated: u64,
    total_correct: u64,
    multiplier_tier: u8,
    /// Length-5 vector<bool> indexed by tier - 1.
    /// tier 1 = bronze (3d), 2 = silver (7d), 3 = gold (14d),
    /// 4 = platinum (30d), 5 = diamond (100d).
    claimed_tiers: vector<bool>,
    /// 0 = no category (legacy / non-categorised), 1 = AI news,
    /// 2 = crypto price, 3 = other. Set by the backend per market.
    market_category: u8,
}

// ============================================================
// Events
// ============================================================

public struct StreakUpdated has copy, drop {
    user: address,
    new_streak: u64,
    longest_streak: u64,
    multiplier_tier: u8,
    day_index: u64,
}

public struct StreakBroken has copy, drop {
    user: address,
    final_streak: u64,
    day_index: u64,
}

public struct MilestoneReached has copy, drop {
    user: address,
    milestone: u8,
    day_index: u64,
}

// ============================================================
// Init
// ============================================================

fun init(ctx: &mut TxContext) {
    let admin = StreakAdmin {
        id: object::new(ctx),
        admin: ctx.sender(),
    };
    transfer::share_object(admin);

    let registry = StreakRegistry {
        id: object::new(ctx),
        streaks: table::new(ctx),
    };
    transfer::share_object(registry);
}

// ============================================================
// Streak creation
// ============================================================

/// Create a new UserStreak for the sender. Idempotent: aborts if sender
/// already has one in the registry.
public fun create_streak(registry: &mut StreakRegistry, ctx: &mut TxContext) {
    let owner = ctx.sender();
    assert!(!table::contains(&registry.streaks, owner), EStreakExists);

    let streak = UserStreak {
        id: object::new(ctx),
        owner,
        current_streak: 0,
        longest_streak: 0,
        last_participation_day: 0,
        has_participated: false,
        total_participated: 0,
        total_correct: 0,
        multiplier_tier: TIER_NONE,
        claimed_tiers: build_empty_tiers(),
        market_category: 0,
    };
    let streak_id = object::id(&streak);
    table::add(&mut registry.streaks, owner, streak_id);
    transfer::transfer(streak, owner);
}

fun build_empty_tiers(): vector<bool> {
    vector[false, false, false, false, false]
}

// ============================================================
// Streak update (backend only)
// ============================================================

/// Backend writes the outcome for a user-day. Aborts if not called by
/// the registered `StreakAdmin.admin`.
///
/// `outcome` is one of: OUTCOME_NOT_SUBMITTED (0), OUTCOME_ALL_CORRECT (1),
/// OUTCOME_SOME_WRONG (2). `day_index` should equal
/// `clock::timestamp_ms(clock) / 86_400_000` at call time.
/// `category` is a per-market category tag the leaderboard worker filters on:
/// 0 = none, 1 = AI news, 2 = crypto price, 3 = other.
public fun record_participation(
    admin_cap: &StreakAdmin,
    registry: &mut StreakRegistry,
    streak: &mut UserStreak,
    day_index: u64,
    outcome: u8,
    category: u8,
    clock: &Clock,
    ctx: &TxContext,
) {
    assert!(ctx.sender() == admin_cap.admin, ENotAdmin);
    assert!(
        outcome == OUTCOME_NOT_SUBMITTED ||
            outcome == OUTCOME_ALL_CORRECT ||
            outcome == OUTCOME_SOME_WRONG,
        EInvalidOutcome,
    );
    let _ = clock; // explicit no-op to keep param required

    // Replay protection first: if already recorded for this day, abort.
    // (Test the day_index equality before the gap check so a same-day
    // call is reported as a replay, not a gap break.)
    if (streak.has_participated) {
        assert!(day_index != streak.last_participation_day, EAlreadyRecordedToday);
    };

    // First-ever participation: has_participated == false is allowed.
    // Otherwise require the next consecutive day.
    if (streak.has_participated) {
        assert!(
            day_index == streak.last_participation_day + 1,
            EStreakBroken,
        );
    };

    let prev_streak = streak.current_streak;
    streak.market_category = category;

    if (outcome == OUTCOME_ALL_CORRECT) {
        streak.current_streak = streak.current_streak + 1;
        streak.longest_streak = max(
            streak.longest_streak,
            streak.current_streak,
        );
        streak.total_participated = streak.total_participated + 1;
        streak.total_correct = streak.total_correct + 1;
        streak.last_participation_day = day_index;
        streak.has_participated = true;

        let new_tier = compute_tier(streak.current_streak);
        let tier_changed = new_tier != streak.multiplier_tier;
        streak.multiplier_tier = new_tier;

        event::emit(StreakUpdated {
            user: streak.owner,
            new_streak: streak.current_streak,
            longest_streak: streak.longest_streak,
            multiplier_tier: streak.multiplier_tier,
            day_index,
        });

        if (tier_changed) {
            emit_milestone_if_new(streak, new_tier, day_index);
        }
    } else {
        // OUTCOME_SOME_WRONG or OUTCOME_NOT_SUBMITTED.
        if (outcome == OUTCOME_SOME_WRONG) {
            streak.total_participated = streak.total_participated + 1;
            streak.last_participation_day = day_index;
            streak.has_participated = true;
        };
        // For OUTCOME_NOT_SUBMITTED, last_participation_day is unchanged so a
        // user who mints late still gets credit if they submitted, and a
        // user who never minted will be detected by the sweep.

        if (streak.current_streak > 0) {
            event::emit(StreakBroken {
                user: streak.owner,
                final_streak: streak.current_streak,
                day_index,
            });
        };
        streak.current_streak = 0;
        // multiplier_tier reflects the new (broken) streak; recompute.
        streak.multiplier_tier = compute_tier(streak.current_streak);

        // Emit StreakUpdated so off-chain indexers can keep the table fresh.
        event::emit(StreakUpdated {
            user: streak.owner,
            new_streak: streak.current_streak,
            longest_streak: streak.longest_streak,
            multiplier_tier: streak.multiplier_tier,
            day_index,
        });
    };

    // Keep registry in sync (so off-chain readers can find by address).
    let _ = registry;
    let _ = prev_streak;
}

// ============================================================
// Admin rotation
// ============================================================

/// Rotate the streak admin (used when the backend hot-wallet rotates).
/// `admin_cap` is the shared `StreakAdmin`; only its current `admin`
/// can call this. The admin is updated in place so subsequent calls to
/// `record_participation` from the new backend address succeed.
public fun rotate_admin(admin_cap: &mut StreakAdmin, new_admin: address, ctx: &TxContext) {
    // Only the current admin can rotate.
    assert!(ctx.sender() == admin_cap.admin, ENotAdmin);
    assert!(new_admin != @0x0, EInvalidNewAdmin);
    admin_cap.admin = new_admin;
}

// ============================================================
// Badge flag list (MVP: no NFT, just flags)
// ============================================================

/// Returns true if the user has reached this tier (per `longest_streak`)
/// but has not yet recorded it in `claimed_tiers`.
public fun can_claim_badge(streak: &UserStreak, tier: u8): bool {
    if (tier < 1 || tier > 5) return false;
    let idx = (tier - 1) as u64;
    if (*vector::borrow(&streak.claimed_tiers, idx)) return false;
    let threshold = *vector::borrow(&TIER_THRESHOLDS, idx);
    streak.longest_streak >= threshold
}

/// Mark a tier as claimed. Idempotent against double-call.
public fun claim_badge(streak: &mut UserStreak, tier: u8, _ctx: &TxContext) {
    assert!(tier >= 1 && tier <= 5, EInvalidTier);
    let idx = (tier - 1) as u64;
    let threshold = *vector::borrow(&TIER_THRESHOLDS, idx);
    assert!(streak.longest_streak >= threshold, EBadgeNotReached);
    assert!(
        !*vector::borrow(&streak.claimed_tiers, idx),
        EBadgeAlreadyClaimed,
    );
    *vector::borrow_mut(&mut streak.claimed_tiers, idx) = true;
}

/// List the tiers the user has earned (returns e.g. `[1, 2, 4]`).
public fun badges_earned(streak: &UserStreak): vector<u8> {
    let mut out: vector<u8> = vector[];
    let mut i: u64 = 0;
    while (i < vector::length(&streak.claimed_tiers)) {
        if (*vector::borrow(&streak.claimed_tiers, i)) {
            out.push_back((i + 1) as u8);
        };
        i = i + 1;
    };
    out
}

// ============================================================
// Read functions
// ============================================================

public fun get_multiplier_bps(streak: &UserStreak): u64 {
    let tier = streak.multiplier_tier;
    if (tier == 0) return 10_000;
    let idx = (tier - 1) as u64;
    let len = vector::length(&TIER_MULTIPLIER_BPS);
    if (idx >= len) return 10_000;
    *vector::borrow(&TIER_MULTIPLIER_BPS, idx)
}

public fun streak_info(
    streak: &UserStreak,
): (u64, u64, u64, u64, u8) {
    (
        streak.current_streak,
        streak.longest_streak,
        streak.last_participation_day,
        streak.total_correct,
        streak.multiplier_tier,
    )
}

public fun owner_of(streak: &UserStreak): address { streak.owner }
public fun current_streak(streak: &UserStreak): u64 { streak.current_streak }
public fun longest_streak(streak: &UserStreak): u64 { streak.longest_streak }
public fun last_participation_day(streak: &UserStreak): u64 { streak.last_participation_day }
public fun total_participated(streak: &UserStreak): u64 { streak.total_participated }
public fun total_correct(streak: &UserStreak): u64 { streak.total_correct }
public fun multiplier_tier(streak: &UserStreak): u8 { streak.multiplier_tier }
public fun streak_admin_address(admin_cap: &StreakAdmin): address { admin_cap.admin }

public fun streak_id_for(registry: &StreakRegistry, user: address): Option<ID> {
    if (table::contains(&registry.streaks, user)) {
        option::some(*table::borrow(&registry.streaks, user))
    } else {
        option::none()
    }
}

// ============================================================
// Internal helpers
// ============================================================

fun max(a: u64, b: u64): u64 {
    if (a >= b) a else b
}

fun compute_tier(streak_days: u64): u8 {
    let len = vector::length(&TIER_THRESHOLDS);
    let mut i = len;
    let mut best: u8 = 0;
    while (i > 0) {
        i = i - 1;
        if (streak_days >= *vector::borrow(&TIER_THRESHOLDS, i)) {
            best = (i + 1) as u8;
            break
        };
    };
    best
}

fun emit_milestone_if_new(streak: &UserStreak, tier: u8, day_index: u64) {
    if (tier < 1 || tier > 5) return;
    let idx = (tier - 1) as u64;
    if (*vector::borrow(&streak.claimed_tiers, idx)) return; // already claimed
    event::emit(MilestoneReached {
        user: streak.owner,
        milestone: tier,
        day_index,
    });
}

// ============================================================
// Tests
// ============================================================

#[test_only]
public fun init_for_testing(ctx: &mut TxContext) {
    init(ctx);
}

#[test_only]
public fun destroy_for_testing(admin: StreakAdmin, registry: StreakRegistry) {
    let StreakAdmin { id, admin: _ } = admin;
    object::delete(id);
    let StreakRegistry { id, streaks } = registry;
    table::destroy_empty(streaks);
    object::delete(id);
}
