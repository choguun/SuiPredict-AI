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

// ============================================================
// dispute_market — double-dispute guard
// ============================================================

/// Calling `dispute_market` twice on the same market must abort with
/// `EAlreadyDisputed`. Without this guard a re-dispute would re-freeze
/// the market and re-emit a `MarketDisputedEvent`, leaving the
/// /dispute page and the parlay worker (`record_leg`) to chase
/// contradictory state. Reachable from the web /dispute page if a
/// user submits twice (the UI is single-shot today, but a stale tab
/// or a refresh mid-submit could re-trigger the form). Round-24
/// audit finding.
#[test, expected_failure(abort_code = prediction_market::EAlreadyDisputed)]
fun dispute_market_twice_aborts() {
    let mut scenario = ts::begin(CREATOR);
    let now = 2_000_000;
    let mut market = fresh_market(now, &mut scenario);
    let mut clock = fresh_clock(&mut scenario);
    clock.set_for_testing(now);
    ts::next_tx(&mut scenario, CREATOR);
    prediction_market::resolve_market<SUI>(&mut market, 1, &clock, ts::ctx(&mut scenario));
    ts::next_tx(&mut scenario, STRANGER);
    prediction_market::dispute_market<SUI>(&mut market, b"https://example.com/evidence", &clock, ts::ctx(&mut scenario));
    // Second dispute must abort — `disputed_for_testing` is now true.
    prediction_market::dispute_market<SUI>(&mut market, b"https://example.com/evidence-2", &clock, ts::ctx(&mut scenario));
    clock.destroy_for_testing();
    prediction_market::destroy_for_testing(market);
    abort 999
}

// ============================================================
// resolve_dispute — not-disputed guard
// ============================================================

/// Calling `resolve_dispute` on a market that was never disputed
/// must abort with `ENotDisputed`. The /admin ResolveDisputeCard
/// calls this on a market-id the operator pastes in; if they paste
/// a non-disputed market the tx would silently no-op without this
/// check (the field is already false). Reachable from the admin
/// panel. Round-24 audit finding.
#[test, expected_failure(abort_code = prediction_market::ENotDisputed)]
fun resolve_dispute_on_unresolved_market_aborts() {
    // The on-chain entry point isn't reachable from this test file
    // because `resolve_dispute` is a public function that takes the
    // market and an outcome; calling it without a prior dispute
    // exercises the `ENotDisputed` guard. The full function takes a
    // `DisputeEvidence` reference — for the test we use the public
    // entry pattern. (`resolve_dispute` is declared as
    // `public fun resolve_dispute<Q>(market, outcome, ctx)`, with
    // the `assert!(market.disputed, ENotDisputed)` check at the top
    // — the dispute evidence struct is created by the
    // `dispute_market` caller and stored on the market.)
    //
    // NOTE: the assertion order in `resolve_dispute` is
    //   1. ENotCreator  (sender must equal market.creator)
    //   2. ENotDisputed (this test exercises this branch)
    //   3. EInvalidOutcome
    // so the test must run as the CREATOR (not a stranger) so the
    // creator check passes and we land on ENotDisputed.
    let mut scenario = ts::begin(CREATOR);
    let mut market = fresh_market(0, &mut scenario);
    // No resolve_market, no dispute_market — market is fresh and
    // never disputed. Calling resolve_dispute must abort with
    // ENotDisputed (the creator check passes).
    prediction_market::resolve_dispute<SUI>(&mut market, 1, ts::ctx(&mut scenario));
    prediction_market::destroy_for_testing(market);
    abort 999
}
