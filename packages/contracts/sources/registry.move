/// Global registry of prediction markets.
module suipredict_agent_policy::registry;

use sui::table::{Self, Table};
use sui::event;

public struct MarketRegistry has key {
    id: UID,
    admin: address,
    market_count: u64,
    markets: Table<u64, ID>,
}

public struct RegistryCreated has copy, drop {
    registry_id: ID,
    admin: address,
}

public struct MarketRegistered has copy, drop {
    market_id: ID,
    market_index: u64,
}

const ENotAdmin: u64 = 0;
const EMarketExists: u64 = 1;

public fun create_registry(ctx: &mut TxContext) {
    let admin = ctx.sender();
    let registry = MarketRegistry {
        id: object::new(ctx),
        admin,
        market_count: 0,
        markets: table::new(ctx),
    };
    let registry_id = object::id(&registry);
    event::emit(RegistryCreated { registry_id, admin });
    transfer::share_object(registry);
}

public fun register_market(
    registry: &mut MarketRegistry,
    market_object_id: ID,
    ctx: &TxContext,
) {
    assert!(ctx.sender() == registry.admin, ENotAdmin);
    let index = registry.market_count;
    assert!(!table::contains(&registry.markets, index), EMarketExists);
    table::add(&mut registry.markets, index, market_object_id);
    registry.market_count = registry.market_count + 1;
    event::emit(MarketRegistered {
        market_id: market_object_id,
        market_index: index,
    });
}

public fun market_count(registry: &MarketRegistry): u64 {
    registry.market_count
}

public fun get_market_id(registry: &MarketRegistry, index: u64): ID {
    *table::borrow(&registry.markets, index)
}

public fun admin(registry: &MarketRegistry): address {
    registry.admin
}
