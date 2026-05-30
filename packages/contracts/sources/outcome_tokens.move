/// Split/merge collateral into YES/NO positions (Polymarket complement).
module suipredict_agent_policy::outcome_tokens;

use sui::balance::{Self, Balance};
use sui::coin::{Self, Coin};
use sui::event;
use suipredict_agent_policy::market_factory::{Self, Market};
use suipredict_agent_policy::types::{Self, UserPosition};

public struct SplitEvent has copy, drop {
    market_id: ID,
    user: address,
    amount: u64,
}

public struct MergeEvent has copy, drop {
    market_id: ID,
    user: address,
    amount: u64,
}

const EMarketNotActive: u64 = 0;
const EZeroAmount: u64 = 1;
const EInsufficientBalance: u64 = 2;

fun get_or_create_position<QuoteCoin>(
    market: &mut Market<QuoteCoin>,
    user: address,
): &mut UserPosition {
    let positions = market_factory::positions_mut(market);
    if (!positions.contains(user)) {
        positions.add(user, types::new_position());
    };
    positions.borrow_mut(user)
}

public fun split_collateral<QuoteCoin>(
    market: &mut Market<QuoteCoin>,
    coin: Coin<QuoteCoin>,
    ctx: &TxContext,
) {
    assert!(market_factory::status(market) == types::active(), EMarketNotActive);
    let amount = coin::value(&coin);
    assert!(amount > 0, EZeroAmount);
    let user = ctx.sender();
    balance::join(market_factory::collateral_mut(market), coin::into_balance(coin));
    let pos = get_or_create_position(market, user);
    types::add_yes(pos, amount);
    types::add_no(pos, amount);
    event::emit(SplitEvent {
        market_id: object::id(market),
        user,
        amount,
    });
}

public fun merge_collateral<QuoteCoin>(
    market: &mut Market<QuoteCoin>,
    amount: u64,
    ctx: &mut TxContext,
): Coin<QuoteCoin> {
    assert!(market_factory::status(market) == types::active(), EMarketNotActive);
    assert!(amount > 0, EZeroAmount);
    let user = ctx.sender();
    let positions = market_factory::positions_mut(market);
    assert!(positions.contains(user), EInsufficientBalance);
    let pos = positions.borrow_mut(user);
    assert!(types::yes_balance(pos) >= amount && types::no_balance(pos) >= amount, EInsufficientBalance);
    types::sub_yes(pos, amount);
    types::sub_no(pos, amount);
    let collateral = market_factory::collateral_mut(market);
    let out = balance::split(collateral, amount);
    event::emit(MergeEvent {
        market_id: object::id(market),
        user,
        amount,
    });
    coin::from_balance(out, ctx)
}

public fun yes_balance<QuoteCoin>(market: &Market<QuoteCoin>, user: address): u64 {
    let positions = market_factory::positions(market);
    if (!positions.contains(user)) return 0;
    types::yes_balance(positions.borrow(user))
}

public fun no_balance<QuoteCoin>(market: &Market<QuoteCoin>, user: address): u64 {
    let positions = market_factory::positions(market);
    if (!positions.contains(user)) return 0;
    types::no_balance(positions.borrow(user))
}

public(package) fun transfer_yes_internal<QuoteCoin>(
    market: &mut Market<QuoteCoin>,
    from: address,
    to: address,
    amount: u64,
) {
    debit_yes_internal(market, from, amount);
    credit_yes_internal(market, to, amount);
}

public(package) fun debit_yes_internal<QuoteCoin>(
    market: &mut Market<QuoteCoin>,
    user: address,
    amount: u64,
) {
    assert!(amount > 0, EZeroAmount);
    let positions = market_factory::positions_mut(market);
    assert!(positions.contains(user), EInsufficientBalance);
    let from_pos = positions.borrow_mut(user);
    assert!(types::yes_balance(from_pos) >= amount, EInsufficientBalance);
    types::sub_yes(from_pos, amount);
}

public(package) fun credit_yes_internal<QuoteCoin>(
    market: &mut Market<QuoteCoin>,
    user: address,
    amount: u64,
) {
    assert!(amount > 0, EZeroAmount);
    let positions = market_factory::positions_mut(market);
    if (!positions.contains(user)) {
        positions.add(user, types::new_position());
    };
    let to_pos = positions.borrow_mut(user);
    types::add_yes(to_pos, amount);
}

public(package) fun credit_no_internal<QuoteCoin>(
    market: &mut Market<QuoteCoin>,
    user: address,
    amount: u64,
) {
    assert!(amount > 0, EZeroAmount);
    let positions = market_factory::positions_mut(market);
    if (!positions.contains(user)) {
        positions.add(user, types::new_position());
    };
    let to_pos = positions.borrow_mut(user);
    types::add_no(to_pos, amount);
}

public fun transfer_yes<QuoteCoin>(
    market: &mut Market<QuoteCoin>,
    to: address,
    amount: u64,
    ctx: &TxContext,
) {
    transfer_yes_internal(market, ctx.sender(), to, amount);
}

public fun transfer_no<QuoteCoin>(
    market: &mut Market<QuoteCoin>,
    to: address,
    amount: u64,
    ctx: &TxContext,
) {
    assert!(amount > 0, EZeroAmount);
    let from = ctx.sender();
    let positions = market_factory::positions_mut(market);
    assert!(positions.contains(from), EInsufficientBalance);
    let from_pos = positions.borrow_mut(from);
    assert!(types::no_balance(from_pos) >= amount, EInsufficientBalance);
    types::sub_no(from_pos, amount);
    if (!positions.contains(to)) {
        positions.add(to, types::new_position());
    };
    let to_pos = positions.borrow_mut(to);
    types::add_no(to_pos, amount);
}
