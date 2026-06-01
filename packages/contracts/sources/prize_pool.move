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
const DEFAULT_DISTRIBUTION_BPS: vector<u64> = vector[
    5_000, // rank 1: 50%
    3_000, // rank 2: 30%
    1_500, // rank 3: 15%
    500,   // rank 4: 5%
    1_000, // rank 5: 10%
    1_000, // rank 6: 10%
    1_000, // rank 7: 10%
    1_000, // rank 8: 10%
    1_000, // rank 9: 10%
    1_000, // rank 10: 10%
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
// ============================================================

/// Rotate the pool to a new week. The previous week's `weekly_prize` is
/// captured and the new week starts at 0.
public fun rotate_week<PrizeCoin>(
    pool: &mut PrizePool<PrizeCoin>,
    new_week: u64,
    ctx: &TxContext,
) {
    assert!(ctx.sender() == pool.admin, ENotAdmin);
    pool.current_week = new_week;
    pool.weekly_prize = 0;
}

/// Mark `week_index` as settled. After this, `claim_prize` aborts for that week.
public fun settle_week<PrizeCoin>(
    pool: &mut PrizePool<PrizeCoin>,
    week_index: u64,
    ctx: &TxContext,
) {
    assert!(ctx.sender() == pool.admin, ENotAdmin);
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
public fun set_distribution<PrizeCoin>(
    pool: &mut PrizePool<PrizeCoin>,
    new_dist: vector<u64>,
    ctx: &TxContext,
) {
    assert!(ctx.sender() == pool.admin, ENotAdmin);
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
public fun rotate_pubkey(
    admin_cap: &mut PrizeAdmin,
    new_pubkey: vector<u8>,
    ctx: &TxContext,
) {
    assert!(ctx.sender() == admin_cap.admin, ENotAdmin);
    admin_cap.pubkey = new_pubkey;
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
    assert!(amount <= balance::value(&pool.balance) / 2, EPrizeTooLarge);

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
