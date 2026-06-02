/// Weekly prize pool for SuiPredict gamification.
///
/// Escrows prize funds in `PrizePool<PrizeCoin>`. The backend signs
/// `(week_index, user, rank, amount)` tuples with its agent key; the
/// on-chain `claim_prize` verifies the signature against a `PrizeAdmin`
/// capability and pays out.
///
/// Distribution is configurable per pool via `distribution_bps` (sum = 10_000).
/// Default: [5000, 3000, 1500, 500, 1000, 1000, 1000, 1000, 1000, 1000].
#[allow(unused_const)]
module suipredict_agent_policy::prize_pool;

use std::vector;
use sui::balance::{Self, Balance};
use sui::coin::{Self, Coin};
use sui::ed25519;
use sui::event;
use sui::hash;
use sui::object::{Self, ID, UID};
use sui::table::{Self, Table};
use sui::transfer;
use sui::tx_context::TxContext;
use suipredict_agent_policy::streak_system;

// ============================================================
// Constants
// ============================================================

const BPS: u64 = 10_000;
const MAX_RANK: u64 = 100;
const ED25519_FLAG: u8 = 0;

// Default distribution bps across top-10 ranks (must sum to 10_000).
// Top-4 takes the whole pot (50/30/15/5); ranks 5-10 receive 0 by default
// and must be funded by the deployer via `set_distribution` if desired.
// The previous default was `[5000, 3000, 1500, 500, 1000×6]` summing to
// 16_000 bps (160%) — `create_pool` did not assert the sum, so every
// freshly-deployed pool was broken: `claim_prize`'s 90% `EPrizeTooLarge`
// cap silently dropped rank-4 (5%) and every rank ≥ 5, and the backend
// still signed 16k-bps payloads that could never settle on-chain.
const DEFAULT_DISTRIBUTION_BPS: vector<u64> = vector[
    5_000, // rank 1: 50%
    3_000, // rank 2: 30%
    1_500, // rank 3: 15%
    500,   // rank 4: 5%
    0,     // rank 5: 0%
    0,     // rank 6: 0%
    0,     // rank 7: 0%
    0,     // rank 8: 0%
    0,     // rank 9: 0%
    0,     // rank 10: 0%
];

// ============================================================
// Error codes
// ============================================================

const ENotAdmin: u64 = 0;
const EInvalidAmount: u64 = 1;
const EInvalidRank: u64 = 2;
const ENotStreakOwner: u64 = 3;
const EAlreadyClaimed: u64 = 4;
const EPrizeTooLarge: u64 = 5;
const EInvalidSignature: u64 = 6;
const EPoolSettled: u64 = 7;
const EWrongPrizeCoin: u64 = 8;
const EInvalidDistribution: u64 = 9;

// ============================================================
// Capability
// ============================================================

/// Admin capability for prize operations. Held by the backend hot-wallet.
public struct PrizeAdmin has key {
    id: UID,
    admin: address,
    /// ed25519 public key bytes for signature verification.
    pubkey: vector<u8>,
}

// ============================================================
// Prize pool object
// ============================================================

/// Shared prize pool escrowing `PrizeCoin` and tracking per-week distribution.
public struct PrizePool<phantom PrizeCoin> has key {
    id: UID,
    admin: address,
    balance: Balance<PrizeCoin>,
    /// Per-rank bps; rank 1 -> distribution_bps[0], rank 2 -> [1], etc.
    distribution_bps: vector<u64>,
    /// Has week N been settled (no more claims allowed)?
    settled: Table<u64, bool>,
    /// Has (week, user) already claimed?
    claimed: Table<u64, Table<address, bool>>,
    /// Total prize funded for the current (most recently opened) week.
    weekly_prize: u64,
    /// The week index this pool is currently accepting funds for.
    current_week: u64,
}

// ============================================================
// Events
// ============================================================

public struct PrizePoolFunded has copy, drop {
    pool_id: ID,
    funder: address,
    amount: u64,
    week_index: u64,
}

public struct PoolSettled has copy, drop {
    pool_id: ID,
    week_index: u64,
}

public struct PrizeClaimed has copy, drop {
    pool_id: ID,
    week_index: u64,
    user: address,
    rank: u64,
    amount: u64,
}

// ============================================================
// Init
// ============================================================

/// Module init: creates and shares an empty prize pool + PrizeAdmin for `Q`.
/// `Q` is the witness used as a placeholder; the actual coin type is supplied
/// at `create_pool` time.
fun init(ctx: &mut TxContext) {
    let admin = PrizeAdmin {
        id: object::new(ctx),
        admin: ctx.sender(),
        pubkey: vector[],
    };
    transfer::share_object(admin);
}

// ============================================================
// Pool creation
// ============================================================

/// Create a new prize pool for `PrizeCoin`. Called by the deployer.
/// `initial_coin` seeds the pool with prize funds; can also be funded later.
public fun create_pool<PrizeCoin>(
    initial_coin: Coin<PrizeCoin>,
    initial_week: u64,
    ctx: &mut TxContext,
) {
    // Reject a malformed default at deploy time. The previous default
    // (sum 16_000 bps) slipped through this check and silently broke
    // every freshly-deployed pool. Mirrors the assertion in
    // `set_distribution` so a future change to the const can't regress
    // without aborting the publish tx.
    let mut default_sum = 0u64;
    let mut i = 0;
    let default_len = vector::length(&DEFAULT_DISTRIBUTION_BPS);
    while (i < default_len) {
        default_sum = default_sum + *vector::borrow(&DEFAULT_DISTRIBUTION_BPS, i);
        i = i + 1;
    };
    assert!(default_sum == BPS, EInvalidDistribution);
    let pool = PrizePool<PrizeCoin> {
        id: object::new(ctx),
        admin: ctx.sender(),
        balance: coin::into_balance(initial_coin),
        distribution_bps: copy_vector(&DEFAULT_DISTRIBUTION_BPS),
        settled: table::new<u64, bool>(ctx),
        claimed: table::new<u64, Table<address, bool>>(ctx),
        weekly_prize: 0,
        current_week: initial_week,
    };
    transfer::share_object(pool);
}

// ============================================================
// Pool funding
// ============================================================

/// Anyone can add funds to the pool. The funds go to the current week.
public fun fund_pool<PrizeCoin>(
    pool: &mut PrizePool<PrizeCoin>,
    coin: Coin<PrizeCoin>,
    ctx: &TxContext,
) {
    let amount = coin::value(&coin);
    assert!(amount > 0, EInvalidAmount);
    pool.balance.join(coin::into_balance(coin));
    pool.weekly_prize = pool.weekly_prize + amount;

    event::emit(PrizePoolFunded {
        pool_id: object::id(pool),
        funder: ctx.sender(),
        amount,
        week_index: pool.current_week,
    });
}

// ============================================================
// Pool admin: rotate week, settle, configure distribution
//
// These functions gate on the shared `PrizeAdmin` capability rather
// than the per-pool `admin` address field. The pool's `admin` field is
// retained for reference / event payloads but is no longer the
// authorization source. The deployer rotates the address via
// `rotate_admin` and the pubkey via `rotate_pubkey`.
// ============================================================

/// Rotate the pool to a new week. The previous week's `weekly_prize` is
/// captured and the new week starts at 0. Requires the `PrizeAdmin`
/// capability held by the deployer/backend hot-wallet.
public fun rotate_week<PrizeCoin>(
    pool: &mut PrizePool<PrizeCoin>,
    admin_cap: &PrizeAdmin,
    new_week: u64,
    ctx: &TxContext,
) {
    assert!(ctx.sender() == admin_cap.admin, ENotAdmin);
    pool.current_week = new_week;
    pool.weekly_prize = 0;
}

/// Mark `week_index` as settled. After this, `claim_prize` aborts for that week.
/// Requires the `PrizeAdmin` capability.
public fun settle_week<PrizeCoin>(
    pool: &mut PrizePool<PrizeCoin>,
    admin_cap: &PrizeAdmin,
    week_index: u64,
    ctx: &TxContext,
) {
    assert!(ctx.sender() == admin_cap.admin, ENotAdmin);
    if (!table::contains(&pool.settled, week_index)) {
        table::add(&mut pool.settled, week_index, true);
    } else {
        *table::borrow_mut(&mut pool.settled, week_index) = true;
    };

    event::emit(PoolSettled {
        pool_id: object::id(pool),
        week_index,
    });
}

/// Replace the distribution curve. The vector must sum to BPS.
/// Requires the `PrizeAdmin` capability.
public fun set_distribution<PrizeCoin>(
    pool: &mut PrizePool<PrizeCoin>,
    admin_cap: &PrizeAdmin,
    new_dist: vector<u64>,
    ctx: &TxContext,
) {
    assert!(ctx.sender() == admin_cap.admin, ENotAdmin);
    let mut sum = 0;
    let mut i = 0;
    let len = vector::length(&new_dist);
    while (i < len) {
        sum = sum + *vector::borrow(&new_dist, i);
        i = i + 1;
    };
    assert!(sum == BPS, EInvalidDistribution);
    pool.distribution_bps = new_dist;
}

/// Rotate the prize admin's ed25519 pubkey (e.g. after backend key rotation).
/// Requires the holder of the `PrizeAdmin` (i.e. the same address).
public fun rotate_pubkey(
    admin_cap: &mut PrizeAdmin,
    new_pubkey: vector<u8>,
    ctx: &TxContext,
) {
    assert!(ctx.sender() == admin_cap.admin, ENotAdmin);
    admin_cap.pubkey = new_pubkey;
}

/// Rotate the prize admin's address (e.g. when the backend hot-wallet
/// is moved to a new key). The pubkey is preserved; after the rotation
/// the new address must sign all subsequent admin operations and
/// `claim_prize` signatures. Requires the current `PrizeAdmin.admin`.
public fun rotate_admin(
    admin_cap: &mut PrizeAdmin,
    new_admin: address,
    ctx: &TxContext,
) {
    assert!(ctx.sender() == admin_cap.admin, ENotAdmin);
    admin_cap.admin = new_admin;
}

// ============================================================
// Prize claim
// ============================================================

/// User claims a prize for `(week_index, rank)`. The backend must have
/// signed `(pool_id || week_index || user || rank || amount)` with the
/// prize admin's ed25519 key.
///
/// `user_streak` is required to ensure only the streak owner can claim,
/// and to surface streak info in the event.
public fun claim_prize<PrizeCoin>(
    pool: &mut PrizePool<PrizeCoin>,
    admin_cap: &PrizeAdmin,
    user_streak: &streak_system::UserStreak,
    week_index: u64,
    rank: u64,
    amount: u64,
    signature: vector<u8>,
    pool_id_for_sig: ID,
    ctx: &mut TxContext,
) {
    let sender = ctx.sender();
    assert!(sender == streak_system::owner_of(user_streak), ENotStreakOwner);
    assert!(rank >= 1 && rank <= MAX_RANK, EInvalidRank);
    assert!(amount > 0, EInvalidAmount);
    // Sanity cap: a single claim can't drain more than 90% of the
    // pool. Tight enough to catch a runaway signed payload, loose
    // enough that rank-1 (50% bps) is claimable when the pool holds at
    // least the weekly prize. The pool should still be topped up each
    // week to cover all top-10 payouts.
    assert!(
        amount <= (balance::value(&pool.balance) * 9) / 10,
        EPrizeTooLarge,
    );

    if (table::contains(&pool.settled, week_index)) {
        let settled = *table::borrow(&pool.settled, week_index);
        assert!(!settled, EPoolSettled);
    };

    // Replay protection per (week, user).
    if (table::contains(&pool.claimed, week_index)) {
        let user_table = table::borrow(&pool.claimed, week_index);
        assert!(!table::contains(user_table, sender), EAlreadyClaimed);
    };

    // Verify ed25519 signature.
    let msg = build_claim_message(
        pool_id_for_sig,
        week_index,
        sender,
        rank,
        amount,
    );
    let pk = &admin_cap.pubkey;
    assert!(
        ed25519::ed25519_verify(&signature, pk, &msg),
        EInvalidSignature,
    );

    // Mark claimed.
    if (!table::contains(&pool.claimed, week_index)) {
        table::add(&mut pool.claimed, week_index, table::new<address, bool>(ctx));
    };
    let user_table = table::borrow_mut(&mut pool.claimed, week_index);
    table::add(user_table, sender, true);

    // Pay out.
    let out = balance::split(&mut pool.balance, amount);
    transfer::public_transfer(coin::from_balance(out, ctx), sender);

    event::emit(PrizeClaimed {
        pool_id: object::id(pool),
        week_index,
        user: sender,
        rank,
        amount,
    });
}

// ============================================================
// Read functions
// ============================================================

public fun balance_value<PrizeCoin>(pool: &PrizePool<PrizeCoin>): u64 {
    balance::value(&pool.balance)
}

public fun current_week<PrizeCoin>(pool: &PrizePool<PrizeCoin>): u64 {
    pool.current_week
}

public fun weekly_prize<PrizeCoin>(pool: &PrizePool<PrizeCoin>): u64 {
    pool.weekly_prize
}

public fun distribution<PrizeCoin>(pool: &PrizePool<PrizeCoin>): &vector<u64> {
    &pool.distribution_bps
}

public fun is_settled<PrizeCoin>(pool: &PrizePool<PrizeCoin>, week_index: u64): bool {
    if (!table::contains(&pool.settled, week_index)) return false;
    *table::borrow(&pool.settled, week_index)
}

public fun expected_amount<PrizeCoin>(
    pool: &PrizePool<PrizeCoin>,
    week_prize: u64,
    rank: u64,
): u64 {
    if (rank < 1) return 0;
    let idx = rank - 1;
    if (idx >= vector::length(&pool.distribution_bps)) return 0;
    (week_prize * *vector::borrow(&pool.distribution_bps, idx)) / BPS
}

public fun prize_admin_address(admin_cap: &PrizeAdmin): address {
    admin_cap.admin
}

// ============================================================
// Helpers
// ============================================================

fun copy_vector(src: &vector<u64>): vector<u64> {
    let mut out = vector::empty<u64>();
    let mut i = 0;
    let len = vector::length(src);
    while (i < len) {
        out.push_back(*vector::borrow(src, i));
        i = i + 1;
    };
    out
}

/// Build the canonical message bytes for ed25519 signature verification.
/// The signed payload is the BCS-encoding-like concatenation of:
///   pool_id (32 bytes) || week_index (8 LE) || user (32 bytes) ||
///   rank (8 LE) || amount (8 LE)
/// and a one-byte domain separator (0x00) prefix to avoid cross-protocol replay.
fun build_claim_message(
    pool_id: ID,
    week_index: u64,
    user: address,
    rank: u64,
    amount: u64,
): vector<u8> {
    let mut msg = vector::empty<u8>();
    msg.push_back(ED25519_FLAG);
    let pool_bytes = object::id_to_bytes(&pool_id);
    let mut i = 0;
    while (i < vector::length(&pool_bytes)) {
        msg.push_back(*vector::borrow(&pool_bytes, i));
        i = i + 1;
    };
    append_u64_le(&mut msg, week_index);
    let user_bytes = sui::address::to_bytes(user);
    let mut j = 0;
    while (j < vector::length(&user_bytes)) {
        msg.push_back(*vector::borrow(&user_bytes, j));
        j = j + 1;
    };
    append_u64_le(&mut msg, rank);
    append_u64_le(&mut msg, amount);

    // Hash the message so the signature is over a fixed-length digest.
    let digest = hash::keccak256(&msg);
    digest
}

fun append_u64_le(out: &mut vector<u8>, n: u64) {
    let mut i = 0;
    while (i < 8) {
        out.push_back(((n >> (i * 8)) & 0xff) as u8);
        i = i + 1;
    };
}

// ============================================================
// Tests
// ============================================================

#[test_only]
public fun init_for_testing(ctx: &mut TxContext) {
    init(ctx);
}

#[test_only]
public fun destroy_for_testing<PrizeCoin>(
    pool: PrizePool<PrizeCoin>,
    admin: PrizeAdmin,
) {
    let PrizePool {
        id,
        admin: _,
        balance,
        distribution_bps: _,
        settled,
        claimed,
        weekly_prize: _,
        current_week: _,
    } = pool;
    balance::destroy_zero(balance);
    table::destroy_empty(settled);
    table::destroy_empty(claimed);
    object::delete(id);

    let PrizeAdmin { id, admin: _, pubkey: _ } = admin;
    object::delete(id);
}
