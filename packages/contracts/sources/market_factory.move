/// Create and manage binary prediction markets.
module suipredict_agent_policy::market_factory;

use sui::balance::{Self, Balance};
use sui::clock::Clock;
use sui::coin::{Self, Coin};
use sui::event;
use sui::table::{Self, Table};
use suipredict_agent_policy::registry::{Self, MarketRegistry};
use suipredict_agent_policy::types::{Self, UserPosition};

public struct Market<phantom QuoteCoin> has key {
    id: UID,
    title: vector<u8>,
    description: vector<u8>,
    category: vector<u8>,
    expiry_ms: u64,
    resolution_source: vector<u8>,
    status: u8,
    outcome: u8,
    creator: address,
    collateral: Balance<QuoteCoin>,
    positions: Table<address, UserPosition>,
    pool_id: Option<ID>,
    next_order_id: u64,
    created_at_ms: u64,
}

public struct MarketCreated has copy, drop {
    market_id: ID,
    expiry_ms: u64,
    creator: address,
}

public struct PoolLinked has copy, drop {
    market_id: ID,
    pool_id: ID,
}

const ENotCreator: u64 = 0;
const EMarketNotActive: u64 = 1;
const EZeroAmount: u64 = 2;

public fun create_market<QuoteCoin>(
    registry: &mut MarketRegistry,
    title: vector<u8>,
    description: vector<u8>,
    category: vector<u8>,
    expiry_ms: u64,
    resolution_source: vector<u8>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    let creator = ctx.sender();
    let market = Market<QuoteCoin> {
        id: object::new(ctx),
        title,
        description,
        category,
        expiry_ms,
        resolution_source,
        status: types::active(),
        outcome: types::unset(),
        creator,
        collateral: balance::zero(),
        positions: table::new(ctx),
        pool_id: option::none(),
        next_order_id: 1,
        created_at_ms: clock.timestamp_ms(),
    };
    let market_id = object::id(&market);
    registry::register_market(registry, market_id, ctx);
    event::emit(MarketCreated {
        market_id,
        expiry_ms,
        creator,
    });
    transfer::share_object(market);
}

public fun link_pool<QuoteCoin>(
    market: &mut Market<QuoteCoin>,
    pool_id: ID,
    ctx: &TxContext,
) {
    assert!(ctx.sender() == market.creator, ENotCreator);
    assert!(market.status == types::active(), EMarketNotActive);
    market.pool_id = option::some(pool_id);
    event::emit(PoolLinked {
        market_id: object::id(market),
        pool_id,
    });
}

public fun deposit_collateral<QuoteCoin>(
    market: &mut Market<QuoteCoin>,
    coin: Coin<QuoteCoin>,
) {
    assert!(market.status == types::active(), EMarketNotActive);
    let amount = coin::value(&coin);
    assert!(amount > 0, EZeroAmount);
    balance::join(&mut market.collateral, coin::into_balance(coin));
}

public fun positions<QuoteCoin>(market: &Market<QuoteCoin>): &Table<address, UserPosition> {
    &market.positions
}

public fun positions_mut<QuoteCoin>(market: &mut Market<QuoteCoin>): &mut Table<address, UserPosition> {
    &mut market.positions
}

public fun collateral_mut<QuoteCoin>(market: &mut Market<QuoteCoin>): &mut Balance<QuoteCoin> {
    &mut market.collateral
}

public fun status<QuoteCoin>(market: &Market<QuoteCoin>): u8 { market.status }
public fun outcome<QuoteCoin>(market: &Market<QuoteCoin>): u8 { market.outcome }
public fun expiry_ms<QuoteCoin>(market: &Market<QuoteCoin>): u64 { market.expiry_ms }
public fun pool_id<QuoteCoin>(market: &Market<QuoteCoin>): Option<ID> { market.pool_id }

public fun next_order_id<QuoteCoin>(market: &mut Market<QuoteCoin>): u64 {
    let id = market.next_order_id;
    market.next_order_id = market.next_order_id + 1;
    id
}

public fun set_status<QuoteCoin>(market: &mut Market<QuoteCoin>, status: u8) {
    market.status = status;
}

public fun set_outcome<QuoteCoin>(market: &mut Market<QuoteCoin>, outcome: u8) {
    market.outcome = outcome;
}

public fun title<QuoteCoin>(market: &Market<QuoteCoin>): vector<u8> { market.title }
public fun category<QuoteCoin>(market: &Market<QuoteCoin>): vector<u8> { market.category }
public fun creator<QuoteCoin>(market: &Market<QuoteCoin>): address { market.creator }
