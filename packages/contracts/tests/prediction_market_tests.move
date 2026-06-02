#[test_only]
module suipredict_agent_policy::prediction_market_tests;

use sui::clock;
use sui::sui::SUI;
use sui::test_scenario as ts;
use suipredict_agent_policy::prediction_market;

const CREATOR: address = @0xCAFE;
const STRANGER: address = @0xBEEF;

const DISPUTE_WINDOW_MS: u64 = 60 * 60 * 1_000;

fun fresh_market(expiry_ms: u64, scenario: &mut ts::Scenario): prediction_market::PredictionMarket<SUI> {
    prediction_market::new_market_for_testing<SUI>(
        b"Will ETH flip BTC market cap in 2026?",
        b"CoinGecko market cap",
        expiry_ms,
        CREATOR,
        ts::ctx(scenario),
    )
}

fun fresh_clock(scenario: &mut ts::Scenario): clock::Clock {
    clock::create_for_testing(ts::ctx(scenario))
}

// ============================================================
// resolve_market
// ============================================================

#[test, expected_failure(abort_code = prediction_market::ENotCreator)]
fun resolve_market_not_creator_aborts() {
    let mut scenario = ts::begin(CREATOR);
    let mut market = fresh_market(0, &mut scenario);
    let clock = fresh_clock(&mut scenario);
    ts::next_tx(&mut scenario, STRANGER);
    prediction_market::resolve_market<SUI>(&mut market, 1, &clock, ts::ctx(&mut scenario));
    clock.destroy_for_testing();
    prediction_market::destroy_for_testing(market);
    abort 999
}

#[test, expected_failure(abort_code = prediction_market::EInvalidOutcome)]
fun resolve_market_invalid_outcome_aborts() {
    let mut scenario = ts::begin(CREATOR);
    let mut market = fresh_market(0, &mut scenario);
    let mut clock = fresh_clock(&mut scenario);
    ts::next_tx(&mut scenario, CREATOR);
    // outcome = 3 is invalid (only 1 = YES, 2 = NO are accepted).
    prediction_market::resolve_market<SUI>(&mut market, 3, &clock, ts::ctx(&mut scenario));
    clock.destroy_for_testing();
    prediction_market::destroy_for_testing(market);
    abort 999
}

#[test, expected_failure(abort_code = prediction_market::ENotExpired)]
fun resolve_market_before_expiry_aborts() {
    let mut scenario = ts::begin(CREATOR);
    let future_expiry = 1_000_000;
    let mut market = fresh_market(future_expiry, &mut scenario);
    let mut clock = fresh_clock(&mut scenario);
    clock.set_for_testing(future_expiry - 1);
    ts::next_tx(&mut scenario, CREATOR);
    prediction_market::resolve_market<SUI>(&mut market, 1, &clock, ts::ctx(&mut scenario));
    clock.destroy_for_testing();
    prediction_market::destroy_for_testing(market);
    abort 999
}

#[test]
fun resolve_market_sets_resolved_and_outcome() {
    let mut scenario = ts::begin(CREATOR);
    let now = 2_000_000;
    let mut market = fresh_market(now, &mut scenario);
    let mut clock = fresh_clock(&mut scenario);
    clock.set_for_testing(now);
    ts::next_tx(&mut scenario, CREATOR);
    prediction_market::resolve_market<SUI>(&mut market, 1, &clock, ts::ctx(&mut scenario));
    // Read back via the public getter (asserts the state actually
    // changed — bare `ts::take_shared` is too lossy to confirm).
    assert!(prediction_market::resolved_for_testing(&market));
    assert!(prediction_market::outcome_for_testing(&market) == 1);
    assert!(prediction_market::resolved_ms_for_testing(&market) == now);
    prediction_market::destroy_for_testing(market);
    clock.destroy_for_testing();
    ts::end(scenario);
}

#[test, expected_failure(abort_code = prediction_market::EAlreadyResolved)]
fun resolve_market_twice_aborts() {
    let mut scenario = ts::begin(CREATOR);
    let now = 2_000_000;
    let mut market = fresh_market(now, &mut scenario);
    let mut clock = fresh_clock(&mut scenario);
    clock.set_for_testing(now);
    ts::next_tx(&mut scenario, CREATOR);
    prediction_market::resolve_market<SUI>(&mut market, 1, &clock, ts::ctx(&mut scenario));
    prediction_market::resolve_market<SUI>(&mut market, 1, &clock, ts::ctx(&mut scenario));
    clock.destroy_for_testing();
    prediction_market::destroy_for_testing(market);
    abort 999
}

// ============================================================
// dispute_market
// ============================================================

#[test, expected_failure(abort_code = prediction_market::EMarketNotActive)]
fun dispute_unresolved_market_aborts() {
    let mut scenario = ts::begin(CREATOR);
    let mut market = fresh_market(0, &mut scenario);
    let clock = fresh_clock(&mut scenario);
    ts::next_tx(&mut scenario, STRANGER);
    prediction_market::dispute_market<SUI>(&mut market, b"https://example.com/evidence", &clock, ts::ctx(&mut scenario));
    clock.destroy_for_testing();
    prediction_market::destroy_for_testing(market);
    abort 999
}

#[test, expected_failure(abort_code = prediction_market::EZeroAmount)]
fun dispute_empty_evidence_aborts() {
    let mut scenario = ts::begin(CREATOR);
    let now = 2_000_000;
    let mut market = fresh_market(now, &mut scenario);
    let mut clock = fresh_clock(&mut scenario);
    clock.set_for_testing(now);
    ts::next_tx(&mut scenario, CREATOR);
    prediction_market::resolve_market<SUI>(&mut market, 1, &clock, ts::ctx(&mut scenario));
    ts::next_tx(&mut scenario, STRANGER);
    prediction_market::dispute_market<SUI>(&mut market, vector[], &clock, ts::ctx(&mut scenario));
    clock.destroy_for_testing();
    prediction_market::destroy_for_testing(market);
    abort 999
}

#[test, expected_failure(abort_code = prediction_market::EEvidenceUriTooLong)]
fun dispute_evidence_too_long_aborts() {
    let mut scenario = ts::begin(CREATOR);
    let now = 2_000_000;
    let mut market = fresh_market(now, &mut scenario);
    let mut clock = fresh_clock(&mut scenario);
    clock.set_for_testing(now);
    ts::next_tx(&mut scenario, CREATOR);
    prediction_market::resolve_market<SUI>(&mut market, 1, &clock, ts::ctx(&mut scenario));
    ts::next_tx(&mut scenario, STRANGER);
    // 257 bytes — one over the on-chain 256-byte cap.
    let mut too_long = vector[];
    let mut i: u64 = 0;
    while (i < 257) {
        too_long.push_back(0x78); // 'x'
        i = i + 1;
    };
    prediction_market::dispute_market<SUI>(&mut market, too_long, &clock, ts::ctx(&mut scenario));
    clock.destroy_for_testing();
    prediction_market::destroy_for_testing(market);
    abort 999
}

#[test, expected_failure(abort_code = prediction_market::EDisputeWindowExpired)]
fun dispute_after_window_expired_aborts() {
    let mut scenario = ts::begin(CREATOR);
    let now = 2_000_000;
    let mut market = fresh_market(now, &mut scenario);
    let mut clock = fresh_clock(&mut scenario);
    clock.set_for_testing(now);
    ts::next_tx(&mut scenario, CREATOR);
    prediction_market::resolve_market<SUI>(&mut market, 1, &clock, ts::ctx(&mut scenario));
    clock.set_for_testing(now + DISPUTE_WINDOW_MS + 1);
    ts::next_tx(&mut scenario, STRANGER);
    prediction_market::dispute_market<SUI>(&mut market, b"https://example.com/evidence", &clock, ts::ctx(&mut scenario));
    clock.destroy_for_testing();
    prediction_market::destroy_for_testing(market);
    abort 999
}

#[test]
fun dispute_freezes_market_and_increments_count() {
    let mut scenario = ts::begin(CREATOR);
    let now = 2_000_000;
    let mut market = fresh_market(now, &mut scenario);
    let mut clock = fresh_clock(&mut scenario);
    clock.set_for_testing(now);
    ts::next_tx(&mut scenario, CREATOR);
    prediction_market::resolve_market<SUI>(&mut market, 1, &clock, ts::ctx(&mut scenario));
    ts::next_tx(&mut scenario, STRANGER);
    prediction_market::dispute_market<SUI>(&mut market, b"https://example.com/evidence", &clock, ts::ctx(&mut scenario));
    assert!(prediction_market::disputed_for_testing(&market));
    assert!(prediction_market::dispute_count_for_testing(&market) == 1);
    prediction_market::destroy_for_testing(market);
    clock.destroy_for_testing();
    ts::end(scenario);
}
