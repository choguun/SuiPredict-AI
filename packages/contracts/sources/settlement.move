/// Resolve markets and redeem winning positions.
module suipredict_agent_policy::settlement;

use sui::balance::{Self, Balance};
use sui::clock::Clock;
use sui::coin::{Self, Coin};
use sui::event;
use suipredict_agent_policy::market_factory::{Self, Market};
use suipredict_agent_policy::types;

public struct MarketResolved has copy, drop {
    market_id: ID,
    outcome: u8,
    resolver: address,
}

public struct Redeemed has copy, drop {
    market_id: ID,
    user: address,
    amount: u64,
    outcome: u8,
}

const ENotCreator: u64 = 0;
const ENotResolved: u64 = 1;
const EAlreadyResolved: u64 = 2;
const ENotExpired: u64 = 3;
const EZeroAmount: u64 = 4;
const EInsufficientBalance: u64 = 5;

public fun resolve_market<QuoteCoin>(
    market: &mut Market<QuoteCoin>,
    outcome: u8,
    clock: &Clock,
    ctx: &TxContext,
) {
    assert!(ctx.sender() == market_factory::creator(market), ENotCreator);
    assert!(market_factory::status(market) == types::active(), EAlreadyResolved);
    assert!(clock.timestamp_ms() >= market_factory::expiry_ms(market), ENotExpired);
    assert!(outcome == types::yes_wins() || outcome == types::no_wins(), ENotResolved);
    market_factory::set_outcome(market, outcome);
    market_factory::set_status(market, types::resolved());
    event::emit(MarketResolved {
        market_id: object::id(market),
        outcome,
        resolver: ctx.sender(),
    });
}

public fun redeem_winner<QuoteCoin>(
    market: &mut Market<QuoteCoin>,
    ctx: &mut TxContext,
): Coin<QuoteCoin> {
    assert!(market_factory::status(market) == types::resolved(), ENotResolved);
    let outcome = market_factory::outcome(market);
    assert!(outcome != types::unset(), ENotResolved);
    let user = ctx.sender();
    let positions = market_factory::positions_mut(market);
    assert!(positions.contains(user), EInsufficientBalance);
    let pos = positions.borrow_mut(user);
    let amount = if (outcome == types::yes_wins()) {
        types::yes_balance(pos)
    } else {
        types::no_balance(pos)
    };
    assert!(amount > 0, EZeroAmount);
    if (outcome == types::yes_wins()) {
        types::clear_yes(pos);
    } else {
        types::clear_no(pos);
    };
    let collateral = market_factory::collateral_mut(market);
    let out = balance::split(collateral, amount);
    event::emit(Redeemed {
        market_id: object::id(market),
        user,
        amount,
        outcome,
    });
    coin::from_balance(out, ctx)
}
