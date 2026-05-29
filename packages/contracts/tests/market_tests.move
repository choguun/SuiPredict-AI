#[test_only]
module suipredict_agent_policy::market_tests;

use sui::clock;
use sui::coin;
use sui::test_scenario::{Self as ts, Scenario};
use suipredict_agent_policy::clob::{Self, OrderBook};
use suipredict_agent_policy::market_factory::{Self, Market};
use suipredict_agent_policy::outcome_tokens;
use suipredict_agent_policy::registry::{Self, MarketRegistry};
use suipredict_agent_policy::settlement;
use suipredict_agent_policy::types;

public struct FakeUSDC has drop {}

fun setup(): Scenario {
    ts::begin(@0xA)
}

#[test]
fun test_split_merge_and_resolve() {
    let mut scenario = setup();
    let expiry = 999_999_999_999;

    ts::next_tx(&mut scenario, @0xA);
    {
        registry::create_registry(ts::ctx(&mut scenario));
    };

    ts::next_tx(&mut scenario, @0xA);
    {
        let mut registry = ts::take_shared<MarketRegistry>(&scenario);
        let clock = clock::create_for_testing(ts::ctx(&mut scenario));
        market_factory::create_market<FakeUSDC>(
            &mut registry,
            b"BTC above 70k?",
            b"Resolves on expiry spot",
            b"crypto",
            expiry,
            b"coingecko",
            &clock,
            ts::ctx(&mut scenario),
        );
        clock::destroy_for_testing(clock);
        ts::return_shared(registry);
    };

    ts::next_tx(&mut scenario, @0xB);
    {
        let mut market = ts::take_shared<Market<FakeUSDC>>(&scenario);
        let coin = coin::mint_for_testing<FakeUSDC>(1_000_000, ts::ctx(&mut scenario));
        outcome_tokens::split_collateral(&mut market, coin, ts::ctx(&mut scenario));
        assert!(outcome_tokens::yes_balance(&market, @0xB) == 1_000_000, 0);
        ts::return_shared(market);
    };

    ts::next_tx(&mut scenario, @0xA);
    {
        let mut market = ts::take_shared<Market<FakeUSDC>>(&scenario);
        let mut clock = clock::create_for_testing(ts::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, expiry + 1);
        settlement::resolve_market(&mut market, types::yes_wins(), &clock, ts::ctx(&mut scenario));
        clock::destroy_for_testing(clock);
        ts::return_shared(market);
    };

    ts::next_tx(&mut scenario, @0xB);
    {
        let mut market = ts::take_shared<Market<FakeUSDC>>(&scenario);
        let payout = settlement::redeem_winner(&mut market, ts::ctx(&mut scenario));
        assert!(coin::value(&payout) == 1_000_000, 1);
        coin::burn_for_testing(payout);
        ts::return_shared(market);
    };

    ts::end(scenario);
}

#[test]
fun test_place_limit_order() {
    let mut scenario = setup();
    let expiry = 999_999_999_999;

    ts::next_tx(&mut scenario, @0xA);
    {
        registry::create_registry(ts::ctx(&mut scenario));
    };

    ts::next_tx(&mut scenario, @0xA);
    {
        let mut registry = ts::take_shared<MarketRegistry>(&scenario);
        let clock = clock::create_for_testing(ts::ctx(&mut scenario));
        market_factory::create_market<FakeUSDC>(
            &mut registry,
            b"Test market",
            b"Desc",
            b"test",
            expiry,
            b"oracle",
            &clock,
            ts::ctx(&mut scenario),
        );
        clock::destroy_for_testing(clock);
        ts::return_shared(registry);
    };

    ts::next_tx(&mut scenario, @0xA);
    {
        let market = ts::take_shared<Market<FakeUSDC>>(&scenario);
        let book = clob::create_order_book(&market, ts::ctx(&mut scenario));
        clob::share_order_book(book);
        ts::return_shared(market);
    };

    ts::next_tx(&mut scenario, @0xB);
    {
        let mut market = ts::take_shared<Market<FakeUSDC>>(&scenario);
        let coin = coin::mint_for_testing<FakeUSDC>(1_000_000, ts::ctx(&mut scenario));
        outcome_tokens::split_collateral(&mut market, coin, ts::ctx(&mut scenario));
        ts::return_shared(market);
    };

    ts::next_tx(&mut scenario, @0xB);
    {
        let mut market = ts::take_shared<Market<FakeUSDC>>(&scenario);
        let mut book = ts::take_shared<OrderBook<FakeUSDC>>(&scenario);
        let clock = clock::create_for_testing(ts::ctx(&mut scenario));
        clob::place_limit_order(
            &mut market,
            &mut book,
            false,
            5200,
            100_000,
            &clock,
            ts::ctx(&mut scenario),
        );
        clock::destroy_for_testing(clock);
        ts::return_shared(market);
        ts::return_shared(book);
    };

    ts::end(scenario);
}
