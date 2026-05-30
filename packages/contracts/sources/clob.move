/// On-chain CLOB for YES token positions (price in basis points of $1).
module suipredict_agent_policy::clob;

use sui::balance::{Self, Balance};
use sui::clock::Clock;
use sui::coin::{Self, Coin};
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
    bid_escrow: Balance<QuoteCoin>,
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
    bid_order_id: u64,
    ask_order_id: u64,
    buyer: address,
    seller: address,
    price_bps: u64,
    quantity: u64,
    quote_paid: u64,
}

const EMarketNotActive: u64 = 0;
const ENotOwner: u64 = 1;
const EInvalidPrice: u64 = 2;
const EZeroQuantity: u64 = 3;
const EInsufficientYes: u64 = 4;
const EOrderNotFound: u64 = 5;
const EOrderClosed: u64 = 6;
const EWrongMarket: u64 = 7;
const EInsufficientQuote: u64 = 8;
const EBidNeedsCollateral: u64 = 9;
const EQuoteOverflow: u64 = 10;
const EInvalidLot: u64 = 11;

const MAX_BPS: u64 = 10000;

public(package) fun create_order_book<QuoteCoin>(
    market: &Market<QuoteCoin>,
    ctx: &mut TxContext,
): OrderBook<QuoteCoin> {
    OrderBook {
        id: object::new(ctx),
        market_id: object::id(market),
        orders: table::new(ctx),
        bids: vector[],
        asks: vector[],
        bid_escrow: balance::zero(),
    }
}

public(package) fun share_order_book<QuoteCoin>(book: OrderBook<QuoteCoin>) {
    transfer::share_object(book);
}

public fun create_and_link_order_book<QuoteCoin>(
    market: &mut Market<QuoteCoin>,
    ctx: &mut TxContext,
) {
    let book = create_order_book(market, ctx);
    let book_id = object::id(&book);
    market_factory::link_pool(market, book_id, ctx);
    transfer::share_object(book);
}

public fun place_bid_order<QuoteCoin>(
    market: &mut Market<QuoteCoin>,
    book: &mut OrderBook<QuoteCoin>,
    quote: Coin<QuoteCoin>,
    price_bps: u64,
    quantity: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert_active_book(market, book);
    assert!(price_bps > 0 && price_bps < MAX_BPS, EInvalidPrice);
    assert!(quantity > 0, EZeroQuantity);
    let required_quote = quote_for(quantity, price_bps);
    assert!(required_quote > 0, EInsufficientQuote);
    assert!(coin::value(&quote) == required_quote, EInsufficientQuote);

    balance::join(&mut book.bid_escrow, coin::into_balance(quote));
    add_order(market, book, true, price_bps, quantity, clock, ctx);
    try_match_best(market, book, ctx);
}

public fun place_ask_order<QuoteCoin>(
    market: &mut Market<QuoteCoin>,
    book: &mut OrderBook<QuoteCoin>,
    price_bps: u64,
    quantity: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert_active_book(market, book);
    assert!(price_bps > 0 && price_bps < MAX_BPS, EInvalidPrice);
    assert!(quantity > 0, EZeroQuantity);
    let owner = ctx.sender();
    let yes_bal = outcome_tokens::yes_balance(market, owner);
    assert!(yes_bal >= quantity, EInsufficientYes);
    outcome_tokens::debit_yes_internal(market, owner, quantity);

    add_order(market, book, false, price_bps, quantity, clock, ctx);
    try_match_best(market, book, ctx);
}

public fun place_limit_order<QuoteCoin>(
    market: &mut Market<QuoteCoin>,
    book: &mut OrderBook<QuoteCoin>,
    is_bid: bool,
    price_bps: u64,
    quantity: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(!is_bid, EBidNeedsCollateral);
    place_ask_order(market, book, price_bps, quantity, clock, ctx);
}

public fun cancel_order<QuoteCoin>(
    market: &mut Market<QuoteCoin>,
    book: &mut OrderBook<QuoteCoin>,
    order_id: u64,
    ctx: &mut TxContext,
) {
    assert!(book.market_id == object::id(market), EWrongMarket);
    assert!(market_factory::is_linked_pool(market, object::id(book)), EWrongMarket);
    assert!(table::contains(&book.orders, order_id), EOrderNotFound);
    let order = table::borrow(&book.orders, order_id);
    assert!(types::order_owner(order) == ctx.sender(), ENotOwner);
    assert!(types::is_open(order), EOrderClosed);

    let owner = types::order_owner(order);
    let remaining = types::order_remaining(order);
    let is_bid = types::order_is_bid(order);
    let price_bps = types::order_price_bps(order);

    if (is_bid) {
        let refund = quote_for(remaining, price_bps);
        let refund_balance = balance::split(&mut book.bid_escrow, refund);
        transfer::public_transfer(coin::from_balance(refund_balance, ctx), owner);
        remove_order_id(&mut book.bids, order_id);
    } else {
        outcome_tokens::credit_yes_internal(market, owner, remaining);
        remove_order_id(&mut book.asks, order_id);
    };
    let order_mut = table::borrow_mut(&mut book.orders, order_id);
    types::fill_order(order_mut, remaining);

    event::emit(OrderCancelled {
        market_id: object::id(market),
        order_id,
    });
}

fun add_order<QuoteCoin>(
    market: &mut Market<QuoteCoin>,
    book: &mut OrderBook<QuoteCoin>,
    is_bid: bool,
    price_bps: u64,
    quantity: u64,
    clock: &Clock,
    ctx: &TxContext,
) {
    let owner = ctx.sender();
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
        insert_bid_order(book, order_id, price_bps);
    } else {
        insert_ask_order(book, order_id, price_bps);
    };
    event::emit(OrderPlaced {
        market_id: object::id(market),
        order_id,
        owner,
        is_bid,
        price_bps,
        quantity,
    });
}

fun insert_bid_order<QuoteCoin>(
    book: &mut OrderBook<QuoteCoin>,
    order_id: u64,
    price_bps: u64,
) {
    let mut i = 0;
    while (i < book.bids.length()) {
        let existing_id = *book.bids.borrow(i);
        let existing = table::borrow(&book.orders, existing_id);
        if (price_bps > types::order_price_bps(existing)) {
            book.bids.insert(i, order_id);
            return
        };
        i = i + 1;
    };
    book.bids.push_back(order_id);
}

fun insert_ask_order<QuoteCoin>(
    book: &mut OrderBook<QuoteCoin>,
    order_id: u64,
    price_bps: u64,
) {
    let mut i = 0;
    while (i < book.asks.length()) {
        let existing_id = *book.asks.borrow(i);
        let existing = table::borrow(&book.orders, existing_id);
        if (price_bps < types::order_price_bps(existing)) {
            book.asks.insert(i, order_id);
            return
        };
        i = i + 1;
    };
    book.asks.push_back(order_id);
}

fun try_match_best<QuoteCoin>(
    market: &mut Market<QuoteCoin>,
    book: &mut OrderBook<QuoteCoin>,
    ctx: &mut TxContext,
) {
    while (book.bids.length() > 0 && book.asks.length() > 0) {
        let bid_id = *book.bids.borrow(0);
        let ask_id = *book.asks.borrow(0);
        let bid = table::borrow(&book.orders, bid_id);
        let ask = table::borrow(&book.orders, ask_id);
        if (types::order_price_bps(bid) < types::order_price_bps(ask)) break;
        let bid_owner = types::order_owner(bid);
        let ask_owner = types::order_owner(ask);
        let bid_price_bps = types::order_price_bps(bid);
        let price_bps = types::order_price_bps(ask);
        let mut fill_qty = types::order_remaining(bid);
        let ask_remaining = types::order_remaining(ask);
        if (fill_qty > ask_remaining) fill_qty = ask_remaining;
        if (fill_qty == 0) break;

        let quote_paid = quote_for(fill_qty, price_bps);
        let quote_reserved = quote_for(fill_qty, bid_price_bps);
        let buyer_refund = quote_reserved - quote_paid;
        outcome_tokens::credit_yes_internal(market, bid_owner, fill_qty);
        let seller_proceeds = balance::split(&mut book.bid_escrow, quote_paid);
        transfer::public_transfer(coin::from_balance(seller_proceeds, ctx), ask_owner);
        if (buyer_refund > 0) {
            let refund_balance = balance::split(&mut book.bid_escrow, buyer_refund);
            transfer::public_transfer(coin::from_balance(refund_balance, ctx), bid_owner);
        };

        let bid_mut = table::borrow_mut(&mut book.orders, bid_id);
        types::fill_order(bid_mut, fill_qty);
        let ask_mut = table::borrow_mut(&mut book.orders, ask_id);
        types::fill_order(ask_mut, fill_qty);

        event::emit(TradeExecuted {
            market_id: object::id(market),
            bid_order_id: bid_id,
            ask_order_id: ask_id,
            buyer: bid_owner,
            seller: ask_owner,
            price_bps,
            quantity: fill_qty,
            quote_paid,
        });

        let bid_after = table::borrow(&book.orders, bid_id);
        if (!types::is_open(bid_after)) {
            book.bids.remove(0);
        };
        let ask_after = table::borrow(&book.orders, ask_id);
        if (!types::is_open(ask_after)) {
            book.asks.remove(0);
        };
    };
}

fun assert_active_book<QuoteCoin>(
    market: &Market<QuoteCoin>,
    book: &OrderBook<QuoteCoin>,
) {
    assert!(market_factory::status(market) == types::active(), EMarketNotActive);
    let book_id = object::id(book);
    assert!(book.market_id == object::id(market), EWrongMarket);
    assert!(market_factory::is_linked_pool(market, book_id), EWrongMarket);
}

fun quote_for(quantity: u64, price_bps: u64): u64 {
    let product = (quantity as u128) * (price_bps as u128);
    let divisor = MAX_BPS as u128;
    assert!(product % divisor == 0, EInvalidLot);
    let maybe_quote = std::u128::try_as_u64(product / divisor);
    assert!(option::is_some(&maybe_quote), EQuoteOverflow);
    option::destroy_some(maybe_quote)
}

fun remove_order_id(ids: &mut vector<u64>, order_id: u64) {
    let mut i = 0;
    while (i < ids.length()) {
        if (*ids.borrow(i) == order_id) {
            ids.remove(i);
            return
        };
        i = i + 1;
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
