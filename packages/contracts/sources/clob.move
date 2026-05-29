/// On-chain CLOB for YES token positions (price in basis points of $1).
module suipredict_agent_policy::clob;

use sui::clock::Clock;
use sui::event;
use sui::table::{Self, Table};
use suipredict_agent_policy::market_factory::{Self, Market};
use suipredict_agent_policy::outcome_tokens;
use suipredict_agent_policy::types::{Self, Order};

public struct OrderBook<phantom QuoteCoin> has key {
    id: UID,
    market_id: ID,
    orders: Table<u64, Order>,
    bids: vector<u64>,
    asks: vector<u64>,
}

public struct OrderPlaced has copy, drop {
    market_id: ID,
    order_id: u64,
    owner: address,
    is_bid: bool,
    price_bps: u64,
    quantity: u64,
}

public struct OrderCancelled has copy, drop {
    market_id: ID,
    order_id: u64,
}

public struct TradeExecuted has copy, drop {
    market_id: ID,
    order_id: u64,
    counterparty: address,
    price_bps: u64,
    quantity: u64,
    is_bid: bool,
}

const EMarketNotActive: u64 = 0;
const ENotOwner: u64 = 1;
const EInvalidPrice: u64 = 2;
const EZeroQuantity: u64 = 3;
const EInsufficientYes: u64 = 4;
const EOrderNotFound: u64 = 5;
const EOrderClosed: u64 = 6;

const MAX_BPS: u64 = 10000;

public fun create_order_book<QuoteCoin>(
    market: &Market<QuoteCoin>,
    ctx: &mut TxContext,
): OrderBook<QuoteCoin> {
    OrderBook {
        id: object::new(ctx),
        market_id: object::id(market),
        orders: table::new(ctx),
        bids: vector[],
        asks: vector[],
    }
}

public fun share_order_book<QuoteCoin>(book: OrderBook<QuoteCoin>) {
    transfer::share_object(book);
}

public fun place_limit_order<QuoteCoin>(
    market: &mut Market<QuoteCoin>,
    book: &mut OrderBook<QuoteCoin>,
    is_bid: bool,
    price_bps: u64,
    quantity: u64,
    clock: &Clock,
    ctx: &TxContext,
) {
    assert!(market_factory::status(market) == types::active(), EMarketNotActive);
    assert!(price_bps > 0 && price_bps < MAX_BPS, EInvalidPrice);
    assert!(quantity > 0, EZeroQuantity);
    let owner = ctx.sender();

    if (!is_bid) {
        let yes_bal = outcome_tokens::yes_balance(market, owner);
        assert!(yes_bal >= quantity, EInsufficientYes);
    };

    let order_id = market_factory::next_order_id(market);
    let order = types::new_order(
        order_id,
        owner,
        is_bid,
        price_bps,
        quantity,
        clock.timestamp_ms(),
    );
    table::add(&mut book.orders, order_id, order);
    if (is_bid) {
        book.bids.push_back(order_id);
    } else {
        book.asks.push_back(order_id);
    };
    event::emit(OrderPlaced {
        market_id: object::id(market),
        order_id,
        owner,
        is_bid,
        price_bps,
        quantity,
    });
    try_match_best<QuoteCoin>(market, book);
}

public fun cancel_order<QuoteCoin>(
    market: &Market<QuoteCoin>,
    book: &mut OrderBook<QuoteCoin>,
    order_id: u64,
    ctx: &TxContext,
) {
    assert!(table::contains(&book.orders, order_id), EOrderNotFound);
    let order = table::borrow(&book.orders, order_id);
    assert!(types::order_owner(order) == ctx.sender(), ENotOwner);
    assert!(types::is_open(order), EOrderClosed);
    event::emit(OrderCancelled {
        market_id: object::id(market),
        order_id,
    });
}

fun try_match_best<QuoteCoin>(
    market: &mut Market<QuoteCoin>,
    book: &mut OrderBook<QuoteCoin>,
) {
    while (book.bids.length() > 0 && book.asks.length() > 0) {
        let bid_id = *book.bids.borrow(0);
        let ask_id = *book.asks.borrow(0);
        let bid = table::borrow(&book.orders, bid_id);
        let ask = table::borrow(&book.orders, ask_id);
        if (types::order_price_bps(bid) < types::order_price_bps(ask)) break;
        let bid_owner = types::order_owner(bid);
        let ask_owner = types::order_owner(ask);
        let price_bps = types::order_price_bps(ask);
        let mut fill_qty = types::order_remaining(bid);
        let ask_remaining = types::order_remaining(ask);
        if (fill_qty > ask_remaining) fill_qty = ask_remaining;
        if (fill_qty == 0) break;

        outcome_tokens::transfer_yes_internal(market, ask_owner, bid_owner, fill_qty);
        let bid_mut = table::borrow_mut(&mut book.orders, bid_id);
        types::fill_order(bid_mut, fill_qty);
        let ask_mut = table::borrow_mut(&mut book.orders, ask_id);
        types::fill_order(ask_mut, fill_qty);

        event::emit(TradeExecuted {
            market_id: object::id(market),
            order_id: bid_id,
            counterparty: ask_owner,
            price_bps,
            quantity: fill_qty,
            is_bid: true,
        });
    };
}

public fun order_count<QuoteCoin>(book: &OrderBook<QuoteCoin>): u64 {
    book.orders.length()
}

public fun get_order<QuoteCoin>(book: &OrderBook<QuoteCoin>, order_id: u64): &Order {
    table::borrow(&book.orders, order_id)
}

public fun bids<QuoteCoin>(book: &OrderBook<QuoteCoin>): &vector<u64> {
    &book.bids
}

public fun asks<QuoteCoin>(book: &OrderBook<QuoteCoin>): &vector<u64> {
    &book.asks
}

public fun market_id<QuoteCoin>(book: &OrderBook<QuoteCoin>): ID {
    book.market_id
}
