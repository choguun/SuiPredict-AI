#[test_only]
module suipredict_agent_policy::registry_tests;

use sui::object;
use sui::test_scenario as ts;
use suipredict_agent_policy::registry::{
    Self,
    MarketRegistry,
};

const ADMIN: address = @0xA;
const STRANGER: address = @0xB;

fun fresh_registry(scenario: &mut ts::Scenario) {
    ts::next_tx(scenario, ADMIN);
    registry::create_registry(ts::ctx(scenario));
}

// ============================================================
// create_registry
// ============================================================

#[test]
fun create_registry_initializes_state() {
    let mut scenario = ts::begin(ADMIN);
    fresh_registry(&mut scenario);
    ts::next_tx(&mut scenario, ADMIN);
    let registry = ts::take_shared<MarketRegistry>(&scenario);
    assert!(registry::admin(&registry) == ADMIN, 0);
    assert!(registry::market_count(&registry) == 0, 0);
    ts::return_shared(registry);
    ts::end(scenario);
}

// ============================================================
// register_market
// ============================================================

#[test, expected_failure(abort_code = registry::ENotAdmin)]
fun register_market_not_admin_aborts() {
    let mut scenario = ts::begin(ADMIN);
    fresh_registry(&mut scenario);
    ts::next_tx(&mut scenario, STRANGER);
    let mut registry = ts::take_shared<MarketRegistry>(&scenario);
    let fake_market_id = object::id_from_address(@0x42);
    registry::register_market(&mut registry, fake_market_id, ts::ctx(&mut scenario));
    ts::return_shared(registry);
    abort 999
}

#[test]
fun register_market_increments_count() {
    let mut scenario = ts::begin(ADMIN);
    fresh_registry(&mut scenario);
    ts::next_tx(&mut scenario, ADMIN);
    let mut registry = ts::take_shared<MarketRegistry>(&scenario);
    let fake_market_id = object::id_from_address(@0x42);
    registry::register_market(&mut registry, fake_market_id, ts::ctx(&mut scenario));
    assert!(registry::market_count(&registry) == 1, 0);
    assert!(registry::get_market_id(&registry, 0) == fake_market_id, 0);
    // Register a second market.
    let fake_market_id2 = object::id_from_address(@0x43);
    registry::register_market(&mut registry, fake_market_id2, ts::ctx(&mut scenario));
    assert!(registry::market_count(&registry) == 2, 0);
    assert!(registry::get_market_id(&registry, 1) == fake_market_id2, 0);
    ts::return_shared(registry);
    ts::end(scenario);
}
