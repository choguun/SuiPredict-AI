/// Multi-leg parlay bets (PRD §4.4 / out-of-scope from plan-4).
///
/// A parlay is a single wager that resolves to "all win" or "any loss":
/// the user picks N market outcomes (YES/NO) and locks collateral
/// against a payout multiplier. If every leg resolves in the user's
/// favour the user receives `collateral * payout_bps / 10_000`, paid
/// out of a shared `ParlayPool<Q>`. If any leg loses, the collateral is
/// retained by the pool. Losing parlays are the funding source for
/// winning ones; the admin top-ups bridge the early imbalance.
///
/// Resolution is multi-step inside one PTB:
///   1. `create_parlay` locks collateral and mints the `Parlay<Q>`.
///   2. For each leg: `record_leg` reads the corresponding resolved
///      market and stamps the leg as won / lost. (One leg per call so
///      we don't need `vector<&PredictionMarket<Q>>`, which Move can't
///      construct.)
///   3. `finalize_parlay` consumes the `Parlay<Q>` and pays out from
///      the pool (or retains the collateral if any leg lost).
///
/// All steps are public — anyone can drive resolution, the on-chain
/// checks make the result deterministic.
#[allow(unused_const, lint(self_transfer))]
module suipredict_agent_policy::parlay;

use std::vector;
use sui::balance::{Self, Balance};
use sui::clock::{Self, Clock};
use sui::coin::{Self, Coin};
use sui::event;
use sui::object::{Self, ID, UID};
use sui::transfer;
use sui::tx_context::TxContext;
use suipredict::prediction_market::{Self, PredictionMarket};

// ============================================================
// Constants
// ============================================================

const BPS: u64 = 10_000;
const MAX_LEGS: u64 = 5;
const MIN_LEGS: u64 = 2;

/// Default payout cap (5x). The admin can override this when creating
/// the pool; individual `create_parlay` calls must stay <= the pool cap.
const DEFAULT_MAX_PAYOUT_BPS: u64 = 50_000;

const LEG_PENDING: u8 = 0;
const LEG_WON: u8 = 1;
const LEG_LOST: u8 = 2;

const PREDICT_YES: u8 = 1;
const PREDICT_NO: u8 = 2;

// ============================================================
// Errors
// ============================================================

const ENotAdmin: u64 = 0;
const EZeroAmount: u64 = 1;
const EInvalidLegCount: u64 = 2;
const ELegPredictionMismatch: u64 = 3;
const EPayoutTooLarge: u64 = 4;
const EPoolUnderfunded: u64 = 5;
const EMarketNotResolved: u64 = 6;
const EMarketDisputed: u64 = 7;
const ELegMismatch: u64 = 8;
const ELegAlreadyRecorded: u64 = 9;
const EParlayNotReady: u64 = 10;
const ENotOwner: u64 = 11;
const EParlayAlreadyFinalized: u64 = 12;
const EInvalidPayoutBps: u64 = 13;
const EInvalidNewAdmin: u64 = 14;

// ============================================================
// Shared funding pool
// ============================================================

public struct ParlayPool<phantom Q> has key {
    id: UID,
    admin: address,
    pool_balance: Balance<Q>,
    /// Maximum allowed `payout_bps` for any single parlay against this pool.
    max_payout_bps: u64,
    /// Lifetime stats (handy for the UI and risk dashboards).
    total_volume: u64,
    total_paid_out: u64,
}

// ============================================================
// Parlay objects
// ============================================================

public struct ParlayLeg has copy, drop, store {
    market_id: ID,
    predicted: u8,
    /// LEG_PENDING / LEG_WON / LEG_LOST
    status: u8,
}

public struct Parlay<phantom Q> has key {
    id: UID,
    owner: address,
    pool_id: ID,
    legs: vector<ParlayLeg>,
    /// Collateral was absorbed into the pool at create-time so we don't
    /// need to hold it twice; this is the snapshot used to compute
    /// the payout at finalize-time.
    collateral_amount: u64,
    /// Payout multiplier in bps (e.g. 30_000 = 3x). Applied to
    /// `collateral_amount` only if every leg wins.
    payout_bps: u64,
    /// Count of legs whose status != LEG_PENDING. When this equals
    /// `legs.length()` the parlay can be finalized.
    legs_recorded: u64,
    /// Snapshot of the count of LOST legs. Even one is enough to
    /// short-circuit the payout.
    legs_lost: u64,
    created_at_ms: u64,
    finalized: bool,
    won: bool,
}

// ============================================================
// Events
// ============================================================

public struct PoolFunded has copy, drop {
    pool_id: ID,
    by: address,
    amount: u64,
    new_balance: u64,
}

public struct ParlayCreated has copy, drop {
    parlay_id: ID,
    pool_id: ID,
    user: address,
    collateral: u64,
    leg_count: u64,
    payout_bps: u64,
}

public struct ParlayLegRecorded has copy, drop {
    parlay_id: ID,
    leg_index: u64,
    market_id: ID,
    predicted: u8,
    outcome: u8,
    won: bool,
}

public struct ParlayFinalized has copy, drop {
    parlay_id: ID,
    pool_id: ID,
    user: address,
    won: bool,
    payout: u64,
    legs_lost: u64,
}

// ============================================================
// Admin
// ============================================================

/// Create a fresh `ParlayPool` and share it. The deployer becomes the
/// initial admin; `rotate_admin` can hand off later.
public fun create_pool<Q>(
    max_payout_bps: u64,
    ctx: &mut TxContext,
) {
    assert!(max_payout_bps >= BPS, EInvalidPayoutBps);
    let pool = ParlayPool<Q> {
        id: object::new(ctx),
        admin: ctx.sender(),
        pool_balance: balance::zero<Q>(),
        max_payout_bps,
        total_volume: 0,
        total_paid_out: 0,
    };
    transfer::share_object(pool);
}

/// Top up the pool. Anyone can fund (think: protocol seeding, partner
/// donations, treasury sweeps). Emits a `PoolFunded` so the indexer
/// can track funding flows.
public fun fund_pool<Q>(
    pool: &mut ParlayPool<Q>,
    coin: Coin<Q>,
    ctx: &TxContext,
) {
    let amount = coin::value(&coin);
    assert!(amount > 0, EZeroAmount);
    balance::join(&mut pool.pool_balance, coin::into_balance(coin));

    event::emit(PoolFunded {
        pool_id: object::id(pool),
        by: ctx.sender(),
        amount,
        new_balance: balance::value(&pool.pool_balance),
    });
}

/// Admin withdraws from the pool (for sweeping fees or migrating).
public fun admin_withdraw<Q>(
    pool: &mut ParlayPool<Q>,
    amount: u64,
    ctx: &mut TxContext,
): Coin<Q> {
    assert!(ctx.sender() == pool.admin, ENotAdmin);
    assert!(amount > 0, EZeroAmount);
    assert!(balance::value(&pool.pool_balance) >= amount, EPoolUnderfunded);
    let out = balance::split(&mut pool.pool_balance, amount);
    coin::from_balance(out, ctx)
}

/// Rotate the pool admin (for backend key rotation).
public fun rotate_admin<Q>(
    pool: &mut ParlayPool<Q>,
    new_admin: address,
    ctx: &TxContext,
) {
    assert!(ctx.sender() == pool.admin, ENotAdmin);
    assert!(new_admin != @0x0, EInvalidNewAdmin);
    pool.admin = new_admin;
}

/// Update the max payout multiplier.
public fun set_max_payout_bps<Q>(
    pool: &mut ParlayPool<Q>,
    new_max_bps: u64,
    ctx: &TxContext,
) {
    assert!(ctx.sender() == pool.admin, ENotAdmin);
    assert!(new_max_bps >= BPS, EInvalidPayoutBps);
    pool.max_payout_bps = new_max_bps;
}

// ============================================================
// Parlay lifecycle
// ============================================================

/// Lock `coin` as collateral and create a new parlay. The caller
/// supplies the market IDs they want to bet on (same order as
/// `predictions`); both vectors must have the same length, between
/// `MIN_LEGS` and `MAX_LEGS`. The pool must have enough balance to
/// cover the worst-case payout at creation time.
public fun create_parlay<Q>(
    pool: &mut ParlayPool<Q>,
    coin: Coin<Q>,
    market_ids: vector<ID>,
    predictions: vector<u8>,
    payout_bps: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    let collateral_amount = coin::value(&coin);
    assert!(collateral_amount > 0, EZeroAmount);

    let leg_count = vector::length(&market_ids);
    assert!(leg_count == vector::length(&predictions), ELegPredictionMismatch);
    assert!(leg_count >= MIN_LEGS && leg_count <= MAX_LEGS, EInvalidLegCount);
    assert!(payout_bps > BPS && payout_bps <= pool.max_payout_bps, EPayoutTooLarge);

    // Worst-case payout must be coverable now. We only require the
    // payout minus the collateral (which we're about to absorb).
    let max_payout = mul_bps(collateral_amount, payout_bps);
    let pool_balance = balance::value(&pool.pool_balance);
    assert!(
        pool_balance + collateral_amount >= max_payout,
        EPoolUnderfunded,
    );

    // Build the legs vector.
    let mut legs = vector::empty<ParlayLeg>();
    let mut i: u64 = 0;
    while (i < leg_count) {
        let mid = *vector::borrow(&market_ids, i);
        let pred = *vector::borrow(&predictions, i);
        assert!(pred == PREDICT_YES || pred == PREDICT_NO, ELegPredictionMismatch);
        vector::push_back(&mut legs, ParlayLeg {
            market_id: mid,
            predicted: pred,
            status: LEG_PENDING,
        });
        i = i + 1;
    };

    // Absorb collateral.
    balance::join(&mut pool.pool_balance, coin::into_balance(coin));
    pool.total_volume = pool.total_volume + collateral_amount;

    let parlay = Parlay<Q> {
        id: object::new(ctx),
        owner: ctx.sender(),
        pool_id: object::id(pool),
        legs,
        collateral_amount,
        payout_bps,
        legs_recorded: 0,
        legs_lost: 0,
        created_at_ms: clock::timestamp_ms(clock),
        finalized: false,
        won: false,
    };
    let parlay_id = object::id(&parlay);

    event::emit(ParlayCreated {
        parlay_id,
        pool_id: object::id(pool),
        user: ctx.sender(),
        collateral: collateral_amount,
        leg_count,
        payout_bps,
    });

    transfer::transfer(parlay, ctx.sender());
}

/// Record the outcome of one leg by passing in the resolved market.
/// Validations:
///   - leg index must be in range and previously LEG_PENDING
///   - market_id must equal the leg's saved `market_id`
///   - the market must be `resolved == true` and not currently disputed
///
/// The leg's status flips to LEG_WON or LEG_LOST based on whether the
/// market outcome matched the user's prediction.
public fun record_leg<Q, M>(
    parlay: &mut Parlay<Q>,
    market: &PredictionMarket<Q, M>,
    leg_index: u64,
    _ctx: &TxContext,
) {
    assert!(!parlay.finalized, EParlayAlreadyFinalized);
    assert!(leg_index < vector::length(&parlay.legs), ELegMismatch);
    let leg_ref = vector::borrow_mut(&mut parlay.legs, leg_index);
    assert!(leg_ref.status == LEG_PENDING, ELegAlreadyRecorded);
    assert!(object::id(market) == leg_ref.market_id, ELegMismatch);
    assert!(prediction_market::is_resolved(market), EMarketNotResolved);
    assert!(!prediction_market::is_disputed(market), EMarketDisputed);

    let actual = prediction_market::market_outcome(market);
    let won = actual == leg_ref.predicted;
    leg_ref.status = if (won) LEG_WON else LEG_LOST;

    let leg_market_id = leg_ref.market_id;
    let leg_predicted = leg_ref.predicted;

    parlay.legs_recorded = parlay.legs_recorded + 1;
    if (!won) parlay.legs_lost = parlay.legs_lost + 1;

    event::emit(ParlayLegRecorded {
        parlay_id: object::id(parlay),
        leg_index,
        market_id: leg_market_id,
        predicted: leg_predicted,
        outcome: actual,
        won,
    });
}

/// Consume the parlay and pay out. Aborts if not every leg has been
/// recorded. The parlay's `won` flag is derived from `legs_lost == 0`;
/// payout = `collateral * payout_bps / 10_000` if won, else 0 (the
/// collateral is already in the pool, so losing requires no transfer).
public fun finalize_parlay<Q>(
    parlay: Parlay<Q>,
    pool: &mut ParlayPool<Q>,
    ctx: &mut TxContext,
) {
    // Drain the parlay into local bindings so we can move out of it.
    let Parlay {
        id,
        owner,
        pool_id,
        legs,
        collateral_amount,
        payout_bps,
        legs_recorded,
        legs_lost,
        created_at_ms: _,
        finalized: _,
        won: _,
    } = parlay;

    let leg_count = vector::length(&legs);
    assert!(legs_recorded == leg_count, EParlayNotReady);
    assert!(pool_id == object::id(pool), ELegMismatch);

    let won = legs_lost == 0;
    let payout = if (won) mul_bps(collateral_amount, payout_bps) else 0;

    if (won) {
        assert!(
            balance::value(&pool.pool_balance) >= payout,
            EPoolUnderfunded,
        );
        let out = balance::split(&mut pool.pool_balance, payout);
        pool.total_paid_out = pool.total_paid_out + payout;
        transfer::public_transfer(coin::from_balance(out, ctx), owner);
    };

    event::emit(ParlayFinalized {
        parlay_id: object::uid_to_inner(&id),
        pool_id,
        user: owner,
        won,
        payout,
        legs_lost,
    });

    // Done with the legs vector (drop-only types).
    let _ = legs;
    object::delete(id);
}

// ============================================================
// Reads
// ============================================================

public fun pool_balance<Q>(pool: &ParlayPool<Q>): u64 {
    balance::value(&pool.pool_balance)
}
public fun pool_admin<Q>(pool: &ParlayPool<Q>): address { pool.admin }
public fun pool_max_payout_bps<Q>(pool: &ParlayPool<Q>): u64 {
    pool.max_payout_bps
}
public fun pool_total_volume<Q>(pool: &ParlayPool<Q>): u64 {
    pool.total_volume
}
public fun pool_total_paid_out<Q>(pool: &ParlayPool<Q>): u64 {
    pool.total_paid_out
}

public fun parlay_owner<Q>(parlay: &Parlay<Q>): address { parlay.owner }
public fun parlay_legs_recorded<Q>(parlay: &Parlay<Q>): u64 {
    parlay.legs_recorded
}
public fun parlay_legs_lost<Q>(parlay: &Parlay<Q>): u64 { parlay.legs_lost }
public fun parlay_leg_count<Q>(parlay: &Parlay<Q>): u64 {
    vector::length(&parlay.legs)
}
public fun parlay_leg_status<Q>(parlay: &Parlay<Q>, idx: u64): u8 {
    vector::borrow(&parlay.legs, idx).status
}
public fun parlay_leg_market<Q>(parlay: &Parlay<Q>, idx: u64): ID {
    vector::borrow(&parlay.legs, idx).market_id
}
public fun parlay_leg_predicted<Q>(parlay: &Parlay<Q>, idx: u64): u8 {
    vector::borrow(&parlay.legs, idx).predicted
}
public fun parlay_payout_bps<Q>(parlay: &Parlay<Q>): u64 { parlay.payout_bps }
public fun parlay_pool_id<Q>(parlay: &Parlay<Q>): ID { parlay.pool_id }

// ============================================================
// Helpers
// ============================================================

fun mul_bps(amount: u64, bps: u64): u64 {
    let big = (amount as u128) * (bps as u128) / (BPS as u128);
    (big as u64)
}

// ============================================================
// Test helpers
// ============================================================

#[test_only]
public fun leg_status_pending_for_testing(): u8 { LEG_PENDING }
#[test_only]
public fun leg_status_won_for_testing(): u8 { LEG_WON }
#[test_only]
public fun leg_status_lost_for_testing(): u8 { LEG_LOST }

#[test_only]
public fun destroy_parlay_for_testing<Q>(parlay: Parlay<Q>) {
    let Parlay {
        id,
        owner: _,
        pool_id: _,
        legs,
        collateral_amount: _,
        payout_bps: _,
        legs_recorded: _,
        legs_lost: _,
        created_at_ms: _,
        finalized: _,
        won: _,
    } = parlay;
    let _ = legs;
    object::delete(id);
}

#[test_only]
public fun destroy_pool_for_testing<Q>(pool: ParlayPool<Q>) {
    let ParlayPool {
        id,
        admin: _,
        pool_balance,
        max_payout_bps: _,
        total_volume: _,
        total_paid_out: _,
    } = pool;
    balance::destroy_for_testing(pool_balance);
    object::delete(id);
}
