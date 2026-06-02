#[test_only]
module suipredict_agent_policy::parlay_tests;

use sui::coin;
use sui::sui::SUI;
use sui::test_scenario as ts;
use sui::test_utils;
use sui::object;
use suipredict_agent_policy::parlay::{Self, Parlay, ParlayPool};
use suipredict_agent_policy::prediction_market;

const ADMIN: address = @0xA;
const USER: address = @0xB;
const CREATOR: address = @0xCAFE;
const BPS: u64 = 10_000;

const PREDICT_YES: u8 = 1;
const PREDICT_NO: u8 = 2;

/// 3x payout multiplier.
const PAYOUT_3X_BPS: u64 = 30_000;
/// 2x payout multiplier.
const PAYOUT_2X_BPS: u64 = 20_000;
/// Cap used at pool creation time.
const MAX_PAYOUT_BPS: u64 = 50_000;

/// Initial pool funding — covers the 3x worst-case on a 100 SUI
/// collateral plus a small buffer for the second leg.
const POOL_SEED: u64 = 1_000;

fun fresh_clock(scenario: &mut ts::Scenario): sui::clock::Clock {
    sui::clock::create_for_testing(ts::ctx(scenario))
}

fun fresh_market(scenario: &mut ts::Scenario): prediction_market::PredictionMarket<SUI> {
    prediction_market::new_market_for_testing<SUI>(
        b"parlay test market",
        b"test source",
        0, // expires immediately
        CREATOR,
        ts::ctx(scenario),
    )
}

fun create_pool(scenario: &mut ts::Scenario) {
    ts::next_tx(scenario, ADMIN);
    parlay::create_pool<SUI>(MAX_PAYOUT_BPS, ts::ctx(scenario));
}

fun fund_pool(scenario: &mut ts::Scenario, amount: u64) {
    ts::next_tx(scenario, ADMIN);
    let seed = coin::mint_for_testing<SUI>(amount, ts::ctx(scenario));
    let mut pool = ts::take_shared<ParlayPool<SUI>>(scenario);
    parlay::fund_pool(&mut pool, seed, ts::ctx(scenario));
    ts::return_shared(pool);
}

fun setup_pool(scenario: &mut ts::Scenario) {
    create_pool(scenario);
    fund_pool(scenario, POOL_SEED);
}

/// Resolve `market` to `outcome`. Convenience wrapper that handles
/// the `ts::next_tx` and the `&mut` borrows for the test author.
fun resolve_yes(market: &mut prediction_market::PredictionMarket<SUI>, scenario: &mut ts::Scenario, clock: &sui::clock::Clock) {
    ts::next_tx(scenario, CREATOR);
    prediction_market::resolve_market<SUI>(market, PREDICT_YES, clock, ts::ctx(scenario));
}

fun resolve_no(market: &mut prediction_market::PredictionMarket<SUI>, scenario: &mut ts::Scenario, clock: &sui::clock::Clock) {
    ts::next_tx(scenario, CREATOR);
    prediction_market::resolve_market<SUI>(market, PREDICT_NO, clock, ts::ctx(scenario));
}

// ============================================================
// Pool admin
// ============================================================

#[test]
fun pool_init_has_zero_balance_and_admin() {
    let mut scenario = ts::begin(ADMIN);
    create_pool(&mut scenario);

    ts::next_tx(&mut scenario, ADMIN);
    let pool = ts::take_shared<ParlayPool<SUI>>(&scenario);
    assert!(parlay::pool_balance(&pool) == 0, 0);
    assert!(parlay::pool_admin(&pool) == ADMIN, 1);
    assert!(parlay::pool_max_payout_bps(&pool) == MAX_PAYOUT_BPS, 2);
    assert!(parlay::pool_total_volume(&pool) == 0, 3);
    assert!(parlay::pool_total_paid_out(&pool) == 0, 4);
    ts::return_shared(pool);
    ts::end(scenario);
}

#[test, expected_failure(abort_code = suipredict_agent_policy::parlay::EInvalidPayoutBps)]
fun create_pool_zero_cap_aborts() {
    let mut scenario = ts::begin(ADMIN);
    ts::next_tx(&mut scenario, ADMIN);
    parlay::create_pool<SUI>(0, ts::ctx(&mut scenario));
    ts::end(scenario);
}

#[test]
fun fund_pool_credits_balance() {
    let mut scenario = ts::begin(ADMIN);
    create_pool(&mut scenario);
    fund_pool(&mut scenario, POOL_SEED);

    ts::next_tx(&mut scenario, ADMIN);
    let pool = ts::take_shared<ParlayPool<SUI>>(&scenario);
    assert!(parlay::pool_balance(&pool) == POOL_SEED, 0);
    ts::return_shared(pool);
    ts::end(scenario);
}

#[test, expected_failure(abort_code = suipredict_agent_policy::parlay::EZeroAmount)]
fun fund_pool_zero_aborts() {
    let mut scenario = ts::begin(ADMIN);
    create_pool(&mut scenario);

    ts::next_tx(&mut scenario, ADMIN);
    let zero = coin::mint_for_testing<SUI>(0, ts::ctx(&mut scenario));
    let mut pool = ts::take_shared<ParlayPool<SUI>>(&scenario);
    parlay::fund_pool(&mut pool, zero, ts::ctx(&mut scenario));
    abort 999
}

#[test, expected_failure(abort_code = suipredict_agent_policy::parlay::ENotAdmin)]
fun admin_withdraw_by_stranger_aborts() {
    let mut scenario = ts::begin(ADMIN);
    create_pool(&mut scenario);
    fund_pool(&mut scenario, 100);

    ts::next_tx(&mut scenario, USER);
    let mut pool = ts::take_shared<ParlayPool<SUI>>(&scenario);
    let _coin = parlay::admin_withdraw(&mut pool, 10, ts::ctx(&mut scenario));
    abort 999
}

#[test]
fun admin_withdraw_by_admin_succeeds() {
    let mut scenario = ts::begin(ADMIN);
    create_pool(&mut scenario);
    fund_pool(&mut scenario, 100);

    ts::next_tx(&mut scenario, ADMIN);
    let mut pool = ts::take_shared<ParlayPool<SUI>>(&scenario);
    let out = parlay::admin_withdraw(&mut pool, 40, ts::ctx(&mut scenario));
    assert!(coin::value(&out) == 40, 0);
    assert!(parlay::pool_balance(&pool) == 60, 1);
    test_utils::destroy(out);
    ts::return_shared(pool);
    ts::end(scenario);
}

#[test, expected_failure(abort_code = suipredict_agent_policy::parlay::EInvalidNewAdmin)]
fun rotate_admin_to_zero_aborts() {
    let mut scenario = ts::begin(ADMIN);
    create_pool(&mut scenario);

    ts::next_tx(&mut scenario, ADMIN);
    let mut pool = ts::take_shared<ParlayPool<SUI>>(&scenario);
    parlay::rotate_admin(&mut pool, @0x0, ts::ctx(&mut scenario));
    abort 999
}

#[test]
fun rotate_admin_to_new_address_succeeds() {
    let mut scenario = ts::begin(ADMIN);
    create_pool(&mut scenario);

    ts::next_tx(&mut scenario, ADMIN);
    let new_admin: address = @0xD;
    let mut pool = ts::take_shared<ParlayPool<SUI>>(&scenario);
    parlay::rotate_admin(&mut pool, new_admin, ts::ctx(&mut scenario));
    assert!(parlay::pool_admin(&pool) == new_admin, 0);
    ts::return_shared(pool);
    ts::end(scenario);
}

#[test]
/// set_max_payout_bps should update the cap to any valid value
/// (>= BPS, i.e. >= 10_000) and reject anything below. The on-chain
/// check is `new_max_bps >= BPS` — a value of 9_999 must abort
/// with EInvalidPayoutBps. The SDK exposes buildSetMaxPayoutBpsTx
/// for the rotate_admin / set_max_payout_bps surface; the round-19
/// audit found this function was reachable but uncovered by tests.
fun set_max_payout_bps_updates_cap() {
    let mut scenario = ts::begin(ADMIN);
    create_pool(&mut scenario);

    ts::next_tx(&mut scenario, ADMIN);
    let mut pool = ts::take_shared<ParlayPool<SUI>>(&scenario);
    // Lower the cap from 5x to 2.5x.
    parlay::set_max_payout_bps(&mut pool, 25_000, ts::ctx(&mut scenario));
    assert!(parlay::pool_max_payout_bps(&pool) == 25_000, 0);
    // Raise it back above 1x.
    parlay::set_max_payout_bps(&mut pool, 100_000, ts::ctx(&mut scenario));
    assert!(parlay::pool_max_payout_bps(&pool) == 100_000, 1);
    // Setting to exactly BPS (1x) is the minimum allowed.
    parlay::set_max_payout_bps(&mut pool, 10_000, ts::ctx(&mut scenario));
    assert!(parlay::pool_max_payout_bps(&pool) == 10_000, 2);
    ts::return_shared(pool);
    ts::end(scenario);
}

#[test, expected_failure(abort_code = suipredict_agent_policy::parlay::EInvalidPayoutBps)]
/// Setting the cap below 1x must abort. The contract asserts
/// `new_max_bps >= BPS` (10_000) — passing 9_999 violates that and
/// the on-chain check fires EInvalidPayoutBps (= 13). A regression
/// in either the assertion or the abort code would let an admin
/// silently break the on-chain invariant that `payout_bps >=
/// max_payout_bps` implies a valid multiplier.
fun set_max_payout_bps_below_one_x_aborts() {
    let mut scenario = ts::begin(ADMIN);
    create_pool(&mut scenario);

    ts::next_tx(&mut scenario, ADMIN);
    let mut pool = ts::take_shared<ParlayPool<SUI>>(&scenario);
    parlay::set_max_payout_bps(&mut pool, 9_999, ts::ctx(&mut scenario));
    ts::return_shared(pool);
    ts::end(scenario);
}

#[test, expected_failure(abort_code = suipredict_agent_policy::parlay::ENotAdmin)]
/// set_max_payout_bps is admin-gated by `ctx.sender() == pool.admin`.
/// A non-admin call must abort with ENotAdmin (= 0). Catches a
/// regression where the admin check gets dropped.
fun set_max_payout_bps_by_stranger_aborts() {
    let mut scenario = ts::begin(ADMIN);
    create_pool(&mut scenario);

    ts::next_tx(&mut scenario, USER);
    let mut pool = ts::take_shared<ParlayPool<SUI>>(&scenario);
    parlay::set_max_payout_bps(&mut pool, 25_000, ts::ctx(&mut scenario));
    ts::return_shared(pool);
    ts::end(scenario);
}

// ============================================================
// create_parlay
// ============================================================

#[test, expected_failure(abort_code = suipredict_agent_policy::parlay::EInvalidLegCount)]
fun create_parlay_with_one_leg_aborts() {
    let mut scenario = ts::begin(ADMIN);
    setup_pool(&mut scenario);

    let mut market = fresh_market(&mut scenario);
    let clock = fresh_clock(&mut scenario);
    let market_id = object::id(&market);

    ts::next_tx(&mut scenario, USER);
    let mut pool = ts::take_shared<ParlayPool<SUI>>(&scenario);
    let coin = coin::mint_for_testing<SUI>(10, ts::ctx(&mut scenario));
    parlay::create_parlay(
        &mut pool,
        coin,
        vector[market_id],
        vector[PREDICT_YES],
        PAYOUT_2X_BPS,
        &clock,
        ts::ctx(&mut scenario),
    );
    abort 999
}

#[test, expected_failure(abort_code = suipredict_agent_policy::parlay::EInvalidLegCount)]
fun create_parlay_with_six_legs_aborts() {
    let mut scenario = ts::begin(ADMIN);
    setup_pool(&mut scenario);

    // Build six markets to push past MAX_LEGS.
    let mut market_ids = vector[];
    let mut preds = vector[];
    let mut i: u64 = 0;
    while (i < 6) {
        let m = fresh_market(&mut scenario);
        market_ids.push_back(object::id(&m));
        preds.push_back(PREDICT_YES);
        prediction_market::destroy_for_testing(m);
        i = i + 1;
    };
    let clock = fresh_clock(&mut scenario);

    ts::next_tx(&mut scenario, USER);
    let mut pool = ts::take_shared<ParlayPool<SUI>>(&scenario);
    let coin = coin::mint_for_testing<SUI>(10, ts::ctx(&mut scenario));
    parlay::create_parlay(
        &mut pool,
        coin,
        market_ids,
        preds,
        PAYOUT_2X_BPS,
        &clock,
        ts::ctx(&mut scenario),
    );
    abort 999
}

#[test, expected_failure(abort_code = suipredict_agent_policy::parlay::ELegPredictionMismatch)]
fun create_parlay_length_mismatch_aborts() {
    let mut scenario = ts::begin(ADMIN);
    setup_pool(&mut scenario);

    let mut m1 = fresh_market(&mut scenario);
    let mut m2 = fresh_market(&mut scenario);
    let clock = fresh_clock(&mut scenario);

    ts::next_tx(&mut scenario, USER);
    let mut pool = ts::take_shared<ParlayPool<SUI>>(&scenario);
    let coin = coin::mint_for_testing<SUI>(10, ts::ctx(&mut scenario));
    // 2 markets, 1 prediction.
    parlay::create_parlay(
        &mut pool,
        coin,
        vector[object::id(&m1), object::id(&m2)],
        vector[PREDICT_YES],
        PAYOUT_2X_BPS,
        &clock,
        ts::ctx(&mut scenario),
    );
    test_utils::destroy(m1);
    test_utils::destroy(m2);
    abort 999
}

#[test, expected_failure(abort_code = suipredict_agent_policy::parlay::EPayoutTooLarge)]
fun create_parlay_with_payout_above_pool_cap_aborts() {
    let mut scenario = ts::begin(ADMIN);
    setup_pool(&mut scenario);

    let mut m1 = fresh_market(&mut scenario);
    let mut m2 = fresh_market(&mut scenario);
    let clock = fresh_clock(&mut scenario);

    ts::next_tx(&mut scenario, USER);
    let mut pool = ts::take_shared<ParlayPool<SUI>>(&scenario);
    let coin = coin::mint_for_testing<SUI>(10, ts::ctx(&mut scenario));
    // 60_000 bps = 6x, above the pool's 5x cap.
    parlay::create_parlay(
        &mut pool,
        coin,
        vector[object::id(&m1), object::id(&m2)],
        vector[PREDICT_YES, PREDICT_YES],
        60_000,
        &clock,
        ts::ctx(&mut scenario),
    );
    test_utils::destroy(m1);
    test_utils::destroy(m2);
    abort 999
}

#[test, expected_failure(abort_code = suipredict_agent_policy::parlay::EPoolUnderfunded)]
fun create_parlay_underfunded_aborts() {
    let mut scenario = ts::begin(ADMIN);
    create_pool(&mut scenario);
    fund_pool(&mut scenario, 10); // tiny pool

    let mut m1 = fresh_market(&mut scenario);
    let mut m2 = fresh_market(&mut scenario);
    let clock = fresh_clock(&mut scenario);

    ts::next_tx(&mut scenario, USER);
    let mut pool = ts::take_shared<ParlayPool<SUI>>(&scenario);
    // 100 SUI collateral * 5x cap = 500 SUI worst case, but pool has 10.
    let coin = coin::mint_for_testing<SUI>(100, ts::ctx(&mut scenario));
    parlay::create_parlay(
        &mut pool,
        coin,
        vector[object::id(&m1), object::id(&m2)],
        vector[PREDICT_YES, PREDICT_YES],
        MAX_PAYOUT_BPS,
        &clock,
        ts::ctx(&mut scenario),
    );
    test_utils::destroy(m1);
    test_utils::destroy(m2);
    abort 999
}

#[test]
fun create_parlay_absorbs_collateral_and_bumps_volume() {
    let mut scenario = ts::begin(ADMIN);
    setup_pool(&mut scenario);

    let mut m1 = fresh_market(&mut scenario);
    let mut m2 = fresh_market(&mut scenario);
    let clock = fresh_clock(&mut scenario);

    ts::next_tx(&mut scenario, USER);
    let mut pool = ts::take_shared<ParlayPool<SUI>>(&scenario);
    let coin = coin::mint_for_testing<SUI>(10, ts::ctx(&mut scenario));
    parlay::create_parlay(
        &mut pool,
        coin,
        vector[object::id(&m1), object::id(&m2)],
        vector[PREDICT_YES, PREDICT_NO],
        PAYOUT_2X_BPS,
        &clock,
        ts::ctx(&mut scenario),
    );
    assert!(parlay::pool_balance(&pool) == POOL_SEED + 10, 0);
    assert!(parlay::pool_total_volume(&pool) == 10, 1);
    ts::return_shared(pool);

    // Parlay is owned by USER. New tx so the create_parlay effects
    // (the transfer) are visible to take_from_address.
    ts::next_tx(&mut scenario, USER);
    let parlay = ts::take_from_address<Parlay<SUI>>(&scenario, USER);
    assert!(parlay::parlay_owner(&parlay) == USER, 2);
    assert!(parlay::parlay_leg_count(&parlay) == 2, 3);
    assert!(parlay::parlay_payout_bps(&parlay) == PAYOUT_2X_BPS, 4);
    assert!(parlay::parlay_legs_recorded(&parlay) == 0, 5);
    assert!(parlay::parlay_legs_lost(&parlay) == 0, 6);
    assert!(parlay::parlay_leg_market(&parlay, 0) == object::id(&m1), 7);
    assert!(parlay::parlay_leg_predicted(&parlay, 0) == PREDICT_YES, 8);
    assert!(parlay::parlay_leg_market(&parlay, 1) == object::id(&m2), 9);
    assert!(parlay::parlay_leg_predicted(&parlay, 1) == PREDICT_NO, 10);
    assert!(parlay::parlay_leg_status(&parlay, 0) == parlay::leg_status_pending_for_testing(), 11);

    parlay::destroy_parlay_for_testing(parlay);
    prediction_market::destroy_for_testing(m1);
    prediction_market::destroy_for_testing(m2);
    clock.destroy_for_testing();
    ts::end(scenario);
}

// ============================================================
// record_leg
// ============================================================

#[test, expected_failure(abort_code = suipredict_agent_policy::parlay::EMarketNotResolved)]
fun record_leg_unresolved_market_aborts() {
    let mut scenario = ts::begin(ADMIN);
    setup_pool(&mut scenario);

    let mut m1 = fresh_market(&mut scenario);
    let mut m2 = fresh_market(&mut scenario);
    let clock = fresh_clock(&mut scenario);

    ts::next_tx(&mut scenario, USER);
    let mut pool = ts::take_shared<ParlayPool<SUI>>(&scenario);
    let coin = coin::mint_for_testing<SUI>(10, ts::ctx(&mut scenario));
    parlay::create_parlay(
        &mut pool,
        coin,
        vector[object::id(&m1), object::id(&m2)],
        vector[PREDICT_YES, PREDICT_NO],
        PAYOUT_2X_BPS,
        &clock,
        ts::ctx(&mut scenario),
    );
    ts::return_shared(pool);

    ts::next_tx(&mut scenario, USER);
    let mut parlay = ts::take_from_address<Parlay<SUI>>(&scenario, USER);
    parlay::record_leg<SUI>(&mut parlay, &m1, 0, ts::ctx(&mut scenario));
    abort 999
}

#[test, expected_failure(abort_code = suipredict_agent_policy::parlay::ELegMismatch)]
fun record_leg_market_mismatch_aborts() {
    let mut scenario = ts::begin(ADMIN);
    setup_pool(&mut scenario);

    let mut m1 = fresh_market(&mut scenario);
    let mut m2 = fresh_market(&mut scenario);
    let m_rogue = fresh_market(&mut scenario);
    let clock = fresh_clock(&mut scenario);

    ts::next_tx(&mut scenario, USER);
    let mut pool = ts::take_shared<ParlayPool<SUI>>(&scenario);
    let coin = coin::mint_for_testing<SUI>(10, ts::ctx(&mut scenario));
    parlay::create_parlay(
        &mut pool,
        coin,
        vector[object::id(&m1), object::id(&m2)],
        vector[PREDICT_YES, PREDICT_NO],
        PAYOUT_2X_BPS,
        &clock,
        ts::ctx(&mut scenario),
    );
    ts::return_shared(pool);

    ts::next_tx(&mut scenario, USER);
    let mut parlay = ts::take_from_address<Parlay<SUI>>(&scenario, USER);
    resolve_yes(&mut m1, &mut scenario, &clock);
    resolve_yes(&mut m2, &mut scenario, &clock);
    // leg 0 expects m1, but we pass m_rogue.
    parlay::record_leg<SUI>(&mut parlay, &m_rogue, 0, ts::ctx(&mut scenario));
    abort 999
}

#[test, expected_failure(abort_code = suipredict_agent_policy::parlay::ELegAlreadyRecorded)]
fun record_leg_twice_aborts() {
    let mut scenario = ts::begin(ADMIN);
    setup_pool(&mut scenario);

    let mut m1 = fresh_market(&mut scenario);
    let mut m2 = fresh_market(&mut scenario);
    let clock = fresh_clock(&mut scenario);

    ts::next_tx(&mut scenario, USER);
    let mut pool = ts::take_shared<ParlayPool<SUI>>(&scenario);
    let coin = coin::mint_for_testing<SUI>(10, ts::ctx(&mut scenario));
    parlay::create_parlay(
        &mut pool,
        coin,
        vector[object::id(&m1), object::id(&m2)],
        vector[PREDICT_YES, PREDICT_NO],
        PAYOUT_2X_BPS,
        &clock,
        ts::ctx(&mut scenario),
    );
    ts::return_shared(pool);

    ts::next_tx(&mut scenario, USER);
    let mut parlay = ts::take_from_address<Parlay<SUI>>(&scenario, USER);
    resolve_yes(&mut m1, &mut scenario, &clock);
    resolve_yes(&mut m2, &mut scenario, &clock);
    parlay::record_leg<SUI>(&mut parlay, &m1, 0, ts::ctx(&mut scenario));
    parlay::record_leg<SUI>(&mut parlay, &m1, 0, ts::ctx(&mut scenario));
    abort 999
}

#[test, expected_failure(abort_code = suipredict_agent_policy::parlay::ELegMismatch)]
fun record_leg_out_of_range_aborts() {
    let mut scenario = ts::begin(ADMIN);
    setup_pool(&mut scenario);

    let mut m1 = fresh_market(&mut scenario);
    let mut m2 = fresh_market(&mut scenario);
    let clock = fresh_clock(&mut scenario);

    ts::next_tx(&mut scenario, USER);
    let mut pool = ts::take_shared<ParlayPool<SUI>>(&scenario);
    let coin = coin::mint_for_testing<SUI>(10, ts::ctx(&mut scenario));
    parlay::create_parlay(
        &mut pool,
        coin,
        vector[object::id(&m1), object::id(&m2)],
        vector[PREDICT_YES, PREDICT_NO],
        PAYOUT_2X_BPS,
        &clock,
        ts::ctx(&mut scenario),
    );
    ts::return_shared(pool);

    ts::next_tx(&mut scenario, USER);
    let mut parlay = ts::take_from_address<Parlay<SUI>>(&scenario, USER);
    parlay::record_leg<SUI>(&mut parlay, &m1, 7, ts::ctx(&mut scenario));
    abort 999
}

// ============================================================
// finalize_parlay — happy path
// ============================================================

#[test]
fun finalize_all_won_pays_out_to_owner() {
    let mut scenario = ts::begin(ADMIN);
    setup_pool(&mut scenario);

    let mut m1 = fresh_market(&mut scenario);
    let mut m2 = fresh_market(&mut scenario);
    let clock = fresh_clock(&mut scenario);

    ts::next_tx(&mut scenario, USER);
    let mut pool = ts::take_shared<ParlayPool<SUI>>(&scenario);
    let coin = coin::mint_for_testing<SUI>(100, ts::ctx(&mut scenario));
    parlay::create_parlay(
        &mut pool,
        coin,
        vector[object::id(&m1), object::id(&m2)],
        vector[PREDICT_YES, PREDICT_NO],
        PAYOUT_2X_BPS,
        &clock,
        ts::ctx(&mut scenario),
    );
    let pool_balance_after_create = parlay::pool_balance(&pool);
    ts::return_shared(pool);

    ts::next_tx(&mut scenario, USER);
    let mut parlay = ts::take_from_address<Parlay<SUI>>(&scenario, USER);
    resolve_yes(&mut m1, &mut scenario, &clock);
    resolve_no(&mut m2, &mut scenario, &clock);
    parlay::record_leg<SUI>(&mut parlay, &m1, 0, ts::ctx(&mut scenario));
    parlay::record_leg<SUI>(&mut parlay, &m2, 1, ts::ctx(&mut scenario));
    assert!(parlay::parlay_legs_recorded(&parlay) == 2, 0);
    assert!(parlay::parlay_legs_lost(&parlay) == 0, 1);

    ts::next_tx(&mut scenario, USER);
    let mut pool = ts::take_shared<ParlayPool<SUI>>(&scenario);
    parlay::finalize_parlay(parlay, &mut pool, ts::ctx(&mut scenario));

    // Payout: 100 SUI * 2x = 200 SUI.
    let expected_payout: u64 = 200;
    assert!(
        parlay::pool_balance(&pool) == pool_balance_after_create - expected_payout,
        2,
    );
    assert!(parlay::pool_total_paid_out(&pool) == expected_payout, 3);
    assert!(parlay::pool_total_volume(&pool) == 100, 4);
    ts::return_shared(pool);

    // Finalize transferred the payout coin to USER — advance one tx so
    // take_from_address can see it.
    ts::next_tx(&mut scenario, USER);
    let payout_coin = ts::take_from_address<sui::coin::Coin<SUI>>(&scenario, USER);
    assert!(coin::value(&payout_coin) == expected_payout, 5);
    test_utils::destroy(payout_coin);

    prediction_market::destroy_for_testing(m1);
    prediction_market::destroy_for_testing(m2);
    clock.destroy_for_testing();
    ts::end(scenario);
}

#[test]
fun finalize_one_lost_pays_zero() {
    let mut scenario = ts::begin(ADMIN);
    setup_pool(&mut scenario);

    let mut m1 = fresh_market(&mut scenario);
    let mut m2 = fresh_market(&mut scenario);
    let clock = fresh_clock(&mut scenario);

    ts::next_tx(&mut scenario, USER);
    let mut pool = ts::take_shared<ParlayPool<SUI>>(&scenario);
    let coin = coin::mint_for_testing<SUI>(50, ts::ctx(&mut scenario));
    parlay::create_parlay(
        &mut pool,
        coin,
        vector[object::id(&m1), object::id(&m2)],
        vector[PREDICT_YES, PREDICT_NO],
        PAYOUT_3X_BPS,
        &clock,
        ts::ctx(&mut scenario),
    );
    let pool_balance_after_create = parlay::pool_balance(&pool);
    ts::return_shared(pool);

    ts::next_tx(&mut scenario, USER);
    let mut parlay = ts::take_from_address<Parlay<SUI>>(&scenario, USER);
    // Leg 0 wins (YES resolves to YES), leg 1 loses (user predicted NO,
    // market resolves to YES).
    resolve_yes(&mut m1, &mut scenario, &clock);
    resolve_yes(&mut m2, &mut scenario, &clock);
    parlay::record_leg<SUI>(&mut parlay, &m1, 0, ts::ctx(&mut scenario));
    parlay::record_leg<SUI>(&mut parlay, &m2, 1, ts::ctx(&mut scenario));
    assert!(parlay::parlay_legs_lost(&parlay) == 1, 0);

    ts::next_tx(&mut scenario, USER);
    let mut pool = ts::take_shared<ParlayPool<SUI>>(&scenario);
    parlay::finalize_parlay(parlay, &mut pool, ts::ctx(&mut scenario));

    // Collateral stays in the pool (loser pays the winners). Pool
    // balance should be unchanged from the post-create value.
    assert!(parlay::pool_balance(&pool) == pool_balance_after_create, 1);
    assert!(parlay::pool_total_paid_out(&pool) == 0, 2);
    ts::return_shared(pool);

    prediction_market::destroy_for_testing(m1);
    prediction_market::destroy_for_testing(m2);
    clock.destroy_for_testing();
    ts::end(scenario);
}

#[test, expected_failure(abort_code = suipredict_agent_policy::parlay::EParlayNotReady)]
fun finalize_before_all_legs_recorded_aborts() {
    let mut scenario = ts::begin(ADMIN);
    setup_pool(&mut scenario);

    let mut m1 = fresh_market(&mut scenario);
    let mut m2 = fresh_market(&mut scenario);
    let clock = fresh_clock(&mut scenario);

    ts::next_tx(&mut scenario, USER);
    let mut pool = ts::take_shared<ParlayPool<SUI>>(&scenario);
    let coin = coin::mint_for_testing<SUI>(10, ts::ctx(&mut scenario));
    parlay::create_parlay(
        &mut pool,
        coin,
        vector[object::id(&m1), object::id(&m2)],
        vector[PREDICT_YES, PREDICT_NO],
        PAYOUT_2X_BPS,
        &clock,
        ts::ctx(&mut scenario),
    );
    ts::return_shared(pool);

    ts::next_tx(&mut scenario, USER);
    let mut parlay = ts::take_from_address<Parlay<SUI>>(&scenario, USER);
    resolve_yes(&mut m1, &mut scenario, &clock);
    resolve_yes(&mut m2, &mut scenario, &clock);
    // Only record leg 0 — leave leg 1 pending.
    parlay::record_leg<SUI>(&mut parlay, &m1, 0, ts::ctx(&mut scenario));

    ts::next_tx(&mut scenario, USER);
    let mut pool = ts::take_shared<ParlayPool<SUI>>(&scenario);
    parlay::finalize_parlay(parlay, &mut pool, ts::ctx(&mut scenario));
    abort 999
}

// ============================================================
// Stats getters
// ============================================================

#[test]
fun parlay_reads_reflect_recorded_state() {
    let mut scenario = ts::begin(ADMIN);
    setup_pool(&mut scenario);

    let mut m1 = fresh_market(&mut scenario);
    let mut m2 = fresh_market(&mut scenario);
    let clock = fresh_clock(&mut scenario);

    ts::next_tx(&mut scenario, USER);
    let mut pool = ts::take_shared<ParlayPool<SUI>>(&scenario);
    let coin = coin::mint_for_testing<SUI>(10, ts::ctx(&mut scenario));
    parlay::create_parlay(
        &mut pool,
        coin,
        vector[object::id(&m1), object::id(&m2)],
        vector[PREDICT_YES, PREDICT_NO],
        PAYOUT_2X_BPS,
        &clock,
        ts::ctx(&mut scenario),
    );
    ts::return_shared(pool);

    ts::next_tx(&mut scenario, USER);
    let mut parlay = ts::take_from_address<Parlay<SUI>>(&scenario, USER);
    resolve_yes(&mut m1, &mut scenario, &clock);
    resolve_no(&mut m2, &mut scenario, &clock);
    parlay::record_leg<SUI>(&mut parlay, &m1, 0, ts::ctx(&mut scenario));
    parlay::record_leg<SUI>(&mut parlay, &m2, 1, ts::ctx(&mut scenario));

    // Status flips match outcome:
    assert!(parlay::parlay_leg_status(&parlay, 0) == parlay::leg_status_won_for_testing(), 0);
    assert!(parlay::parlay_leg_status(&parlay, 1) == parlay::leg_status_won_for_testing(), 1);

    parlay::destroy_parlay_for_testing(parlay);
    prediction_market::destroy_for_testing(m1);
    prediction_market::destroy_for_testing(m2);
    clock.destroy_for_testing();
    ts::end(scenario);
}

#[test]
fun parlay_status_reflects_loss() {
    let mut scenario = ts::begin(ADMIN);
    setup_pool(&mut scenario);

    let mut m1 = fresh_market(&mut scenario);
    let mut m2 = fresh_market(&mut scenario);
    let clock = fresh_clock(&mut scenario);

    ts::next_tx(&mut scenario, USER);
    let mut pool = ts::take_shared<ParlayPool<SUI>>(&scenario);
    let coin = coin::mint_for_testing<SUI>(10, ts::ctx(&mut scenario));
    parlay::create_parlay(
        &mut pool,
        coin,
        vector[object::id(&m1), object::id(&m2)],
        vector[PREDICT_YES, PREDICT_NO],
        PAYOUT_2X_BPS,
        &clock,
        ts::ctx(&mut scenario),
    );
    ts::return_shared(pool);

    ts::next_tx(&mut scenario, USER);
    let mut parlay = ts::take_from_address<Parlay<SUI>>(&scenario, USER);
    resolve_yes(&mut m1, &mut scenario, &clock);
    resolve_yes(&mut m2, &mut scenario, &clock);
    parlay::record_leg<SUI>(&mut parlay, &m1, 0, ts::ctx(&mut scenario));
    parlay::record_leg<SUI>(&mut parlay, &m2, 1, ts::ctx(&mut scenario));

    assert!(parlay::parlay_leg_status(&parlay, 0) == parlay::leg_status_won_for_testing(), 0);
    assert!(parlay::parlay_leg_status(&parlay, 1) == parlay::leg_status_lost_for_testing(), 1);
    assert!(parlay::parlay_legs_lost(&parlay) == 1, 2);

    parlay::destroy_parlay_for_testing(parlay);
    prediction_market::destroy_for_testing(m1);
    prediction_market::destroy_for_testing(m2);
    clock.destroy_for_testing();
    ts::end(scenario);
}
