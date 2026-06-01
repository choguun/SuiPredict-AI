/// DeepBook V3-integrated prediction market.
/// Uses DeepBook Pool<YES<Q>, Q> as the orderbook CLOB.
/// YES/NO are TreasuryCap-backed Sui coins with 1:1 collateral backing.
#[allow(deprecated_usage, unused_const, lint(self_transfer))]
module suipredict::prediction_market;

// ============================================================
// Imports
// ============================================================

use deepbook::balance_manager::{
    Self,
    BalanceManager,
    TradeProof,
    DeepBookPoolReferral,
    deposit,
};
use deepbook::order_info;
use deepbook::pool::{Self, Pool};
use deepbook::registry::Registry;
use token::deep::DEEP;
use sui::balance::{Self, Balance};
use sui::clock::Clock;
use sui::coin::{Self, Coin, TreasuryCap};
use sui::event;
use sui::object::{Self, ID, UID};
use sui::transfer;
use sui::tx_context::TxContext;
use suipredict_agent_policy::streak_system;

// ============================================================
// Fee constants (basis points)
// ============================================================

/// 1% mint fee  (100 bps / 10_000)
const MINT_FEE_BPS: u64 = 100;
/// 0.5% redeem fee (50 bps / 10_000)
const REDEEM_FEE_BPS: u64 = 50;
const BPS: u64 = 10_000;

// ============================================================
// Error constants
// ============================================================

const ENotCreator: u64 = 0;
const EMarketNotActive: u64 = 1;
const EAlreadyResolved: u64 = 2;
const ENotExpired: u64 = 3;
const EInvalidOutcome: u64 = 4;
const EZeroAmount: u64 = 5;
const EReferralAlreadySet: u64 = 6;
const ENotAdmin: u64 = 7;
const EInvalidPrice: u64 = 8;
const EInvalidQuantity: u64 = 9;
const EWrongOutcome: u64 = 10;
const ENotDisputed: u64 = 11;
const EAlreadyDisputed: u64 = 12;
const EWrongStreakOwner: u64 = 13;

// ============================================================
// DeepBook order type constants (for reference)
// ============================================================

/// Immediate-or-cancel: fill what you can, cancel rest
const ORDER_TYPE_IOC: u8 = 2;
/// Good-for-time: active for duration, then cancel
const ORDER_TYPE_GFT: u8 = 3;
/// Fill-or-kill: execute fully or not at all
const ORDER_TYPE_FOK: u8 = 1;
/// Post-only: only add liquidity, reject if would take
const ORDER_TYPE_POST_ONLY: u8 = 0;

/// Disallow self-matching (safe default)
const SELF_MATCHING_DISALLOW: u8 = 1;

/// Default expiry for limit orders: max u64 (no expiry)
const DEFAULT_EXPIRY: u64 = 18446744073709551615;

// ============================================================
// Coin witness types
//
// YES/NO are TreasuryCap-backed Sui coin types scoped to a quote
// coin Q. This keeps YES/NO pools isolated per quote-asset (e.g.
// DBUSDC) while reusing one DeepBook Pool<YES<Q>, Q> per market.
// ============================================================

/// Marker type for YES outcome tokens (base asset on DeepBook).
public struct YES<phantom Q> has drop, store {}

/// Marker type for NO outcome tokens (held but not traded on DeepBook).
public struct NO<phantom Q> has drop, store {}

// ============================================================
// Market state
// ============================================================

/// A binary prediction market.
/// - Q: the quote-coin type (e.g. DBUSDC) used as collateral
/// - YES<Q> / NO<Q>: the outcome token types for this market
public struct PredictionMarket<phantom Q> has key {
    id: UID,
    /// Human-readable question / title
    title: vector<u8>,
    /// TreasuryCap for YES<Q> - mints and burns YES tokens
    yes_cap: TreasuryCap<YES<Q>>,
    /// TreasuryCap for NO<Q> - mints and burns NO tokens
    no_cap: TreasuryCap<NO<Q>>,
    /// All collateral backing this market's positions
    collateral: Balance<Q>,
    /// Accumulated mint/redeem protocol fees (in quote coin)
    fee_balance: Balance<Q>,
    /// Whether the market has been resolved
    resolved: bool,
    /// 0 = unset, 1 = YES won, 2 = NO won
    outcome: u8,
    /// Unix timestamp (ms) after which resolution is allowed
    expiry_ms: u64,
    /// URL / description of the resolution source
    resolution_source: vector<u8>,
    /// Market creator address
    creator: address,
    /// ID of the DeepBook Pool<YES<Q>, Q> for this market
    pool_id: ID,
    /// BalanceManager ID for this market's DeepBook trading
    /// The BalanceManager must be passed separately to trading functions
    balance_manager_id: ID,
    /// Optional DeepBook referral ID for this market's pool
    referral_id: Option<ID>,
    /// Timestamp (ms) when the market was created
    created_ms: u64,
    /// Has this market been disputed? (PRD §7: 1-hour dispute window)
    disputed: bool,
    /// URI/URL of the dispute evidence (e.g. IPFS link)
    dispute_evidence_uri: vector<u8>,
    /// Number of disputes filed against this market
    dispute_count: u64,
}

// ============================================================
// Fee vault (admin-claimed protocol revenue)
// ============================================================

/// Holds accumulated protocol revenue in quote coin for admin withdrawal.
/// Q is the quote-coin type for the fee_balance field.
public struct FeeVault<phantom Q> has key {
    id: UID,
    admin: address,
    /// Accumulated quote-coin (DBUSDC) fees
    fee_balance: Balance<Q>,
}

// ============================================================
// Events
// ============================================================

public struct MarketCreatedEvent has copy, drop {
    market_id: ID,
    pool_id: ID,
    balance_manager_id: ID,
    title: vector<u8>,
    expiry_ms: u64,
    creator: address,
}

public struct MarketResolvedEvent has copy, drop {
    market_id: ID,
    outcome: u8,
    resolver: address,
}

public struct MintedEvent has copy, drop {
    market_id: ID,
    user: address,
    collateral_amount: u64,
    fee: u64,
    yes_minted: u64,
    no_minted: u64,
}

public struct RedeemedEvent has copy, drop {
    market_id: ID,
    user: address,
    winning_amount: u64,
    fee: u64,
    collateral_returned: u64,
}

public struct OrderPlacedEvent has copy, drop {
    market_id: ID,
    pool_id: ID,
    client_order_id: u64,
    is_bid: bool,
    price: u64,
    quantity: u64,
    order_id: u128,
}

public struct OrderCancelledEvent has copy, drop {
    market_id: ID,
    pool_id: ID,
    order_id: u128,
}

public struct OrdersBatchCancelledEvent has copy, drop {
    market_id: ID,
    pool_id: ID,
    order_ids: vector<u128>,
}

public struct SettledEvent has copy, drop {
    market_id: ID,
    pool_id: ID,
    trader: address,
}

public struct ReferralSetEvent has copy, drop {
    market_id: ID,
    referral_id: ID,
}

public struct FeesWithdrawnEvent has copy, drop {
    admin: address,
    amount: u64,
}

public struct MarketDisputedEvent has copy, drop {
    market_id: ID,
    disputer: address,
    evidence_uri: vector<u8>,
    dispute_count: u64,
}

public struct MarketUndisputedEvent has copy, drop {
    market_id: ID,
    final_outcome: u8,
    resolver: address,
}

// ============================================================
// initializer
// ============================================================

/// Creates the FeeVault for Q and shares it. Called once at publish time.
public struct Q has drop {}

fun init(ctx: &mut TxContext) {
    let vault = FeeVault<Q> {
        id: object::new(ctx),
        admin: ctx.sender(),
        fee_balance: balance::zero(),
    };
    transfer::share_object(vault);
}

// ============================================================
// Market creation
// ============================================================

/// Creates a new prediction market, its YES/NO coin types, a DeepBook pool,
/// and a BalanceManager for trading.
///
/// Returns (market_id, pool_id, balance_manager_id).
///
/// This function handles everything in one PTB:
///   1. Call pool_creation_fee() to get the 500M MIST creation fee
///   2. Create the DeepBook Pool<YES<Q>, Q> via create_permissionless_pool
///   3. Create a BalanceManager for this market's trading (shared object)
///   4. Create PredictionMarket<Q> with YES/NO TreasuryCaps
///
/// Arguments:
///   registry         - DeepBook registry (must be shared)
///   title            - Market question / title
///   resolution_source - URL or description of how resolution occurs
///   expiry_ms        - Unix timestamp (ms) after which market can be resolved
///   tick_size        - Price tick in quote units (e.g. 1_000_000 = 0.001 with 6 decimals)
///   lot_size         - Minimum base-asset quantity per order (in YES * 10^decimals)
///   min_size         - Minimum order size in base units
///   deep_coin        - Coin<DEEP> for pool creation fee (500M MIST = 0.5 SUI)
///   ctx
public fun create_market<Q>(
    registry: &mut Registry,
    title: vector<u8>,
    resolution_source: vector<u8>,
    expiry_ms: u64,
    tick_size: u64,
    lot_size: u64,
    min_size: u64,
    deep_coin: Coin<DEEP>,
    ctx: &mut TxContext,
): (ID, ID, ID) {
    let creator = ctx.sender();

    // 1. Create the DeepBook permissionless pool
    //    Pool type: Pool<YES<Q>, Q>
    let pool_id = pool::create_permissionless_pool<YES<Q>, Q>(
        registry,
        tick_size,
        lot_size,
        min_size,
        deep_coin,
        ctx,
    );

    // 2. Create BalanceManager for this market (shared object)
    //    The BM must be created and shared so it can be used across PTBs
    let balance_manager = balance_manager::new_with_custom_owner(
        creator,
        ctx,
    );
    let balance_manager_id = object::id(&balance_manager);
    transfer::public_share_object(balance_manager);

    // 3. Create YES and NO coin currencies
    let (yes_cap, yes_meta) = coin::create_currency(
        YES<Q> {},
        0,
        b"YES",
        b"YES",
        b"YES outcome token",
        option::none(),
        ctx,
    );
    transfer::public_freeze_object(yes_meta);
    let (no_cap, no_meta) = coin::create_currency(
        NO<Q> {},
        0,
        b"NO",
        b"NO",
        b"NO outcome token",
        option::none(),
        ctx,
    );
    transfer::public_freeze_object(no_meta);

    // 4. Create the PredictionMarket with YES/NO TreasuryCaps
    let market = PredictionMarket<Q> {
        id: object::new(ctx),
        title,
        yes_cap,
        no_cap,
        collateral: balance::zero(),
        fee_balance: balance::zero(),
        resolved: false,
        outcome: 0,
        expiry_ms,
        resolution_source,
        creator,
        pool_id: pool_id,
        balance_manager_id,
        referral_id: option::none(),
        created_ms: ctx.epoch_timestamp_ms(),
        disputed: false,
        dispute_evidence_uri: vector[],
        dispute_count: 0,
    };

    let market_id = object::id(&market);
    event::emit(MarketCreatedEvent {
        market_id,
        pool_id: pool_id,
        balance_manager_id,
        title: market.title,
        expiry_ms,
        creator,
    });

    transfer::share_object(market);
    (market_id, pool_id, balance_manager_id)
}

// ============================================================
// BalanceManager helpers
// ============================================================

/// Get the BalanceManager ID for a market (read-only).
public fun balance_manager_id<Q>(market: &PredictionMarket<Q>): ID {
    market.balance_manager_id
}

// ============================================================
// Minting - entry (1% fee)
// ============================================================

/// User deposits collateral and receives equal YES and NO tokens.
/// The protocol takes a 1% fee in quote coin.
public fun mint_shares<Q>(
    market: &mut PredictionMarket<Q>,
    quote_in: Coin<Q>,
    ctx: &mut TxContext,
) {
    assert!(!market.resolved, EMarketNotActive);
    let total = coin::value(&quote_in);
    assert!(total > 0, EZeroAmount);

    // 1% mint fee
    let fee = (total * MINT_FEE_BPS) / BPS;
    let net = total - fee;

    // Split fee off before joining collateral
    let mut bal = coin::into_balance(quote_in);
    market.fee_balance.join(bal.split(fee));
    market.collateral.join(bal);

    // Mint equal YES and NO
    let yes = coin::mint(&mut market.yes_cap, net, ctx);
    let no = coin::mint(&mut market.no_cap, net, ctx);

    event::emit(MintedEvent {
        market_id: object::id(market),
        user: ctx.sender(),
        collateral_amount: total,
        fee,
        yes_minted: net,
        no_minted: net,
    });

    transfer::public_transfer(yes, ctx.sender());
    transfer::public_transfer(no, ctx.sender());
}

// ============================================================
// Settlement - resolve market (no fee)
// ============================================================

/// Resolve the market to YES or NO. Only callable by creator after expiry.
public fun resolve_market<Q>(
    market: &mut PredictionMarket<Q>,
    outcome: u8,  // 1 = YES won, 2 = NO won
    clock: &Clock,
    ctx: &TxContext,
) {
    assert!(ctx.sender() == market.creator, ENotCreator);
    assert!(!market.resolved, EAlreadyResolved);
    assert!(clock.timestamp_ms() >= market.expiry_ms, ENotExpired);
    assert!(outcome == 1 || outcome == 2, EInvalidOutcome);

    market.resolved = true;
    market.outcome = outcome;

    event::emit(MarketResolvedEvent {
        market_id: object::id(market),
        outcome,
        resolver: ctx.sender(),
    });
}

/// File a dispute against a resolved market. Anyone can dispute (within the
/// off-chain 1-hour window). Freezes the market so `redeem` aborts until
/// `resolve_dispute` is called.
public fun dispute_market<Q>(
    market: &mut PredictionMarket<Q>,
    evidence_uri: vector<u8>,
    ctx: &TxContext,
) {
    assert!(market.resolved, EMarketNotActive);
    assert!(vector::length(&evidence_uri) > 0, EZeroAmount);
    market.disputed = true;
    market.dispute_count = market.dispute_count + 1;
    market.dispute_evidence_uri = evidence_uri;

    event::emit(MarketDisputedEvent {
        market_id: object::id(market),
        disputer: ctx.sender(),
        evidence_uri: market.dispute_evidence_uri,
        dispute_count: market.dispute_count,
    });
}

/// Settle a disputed market. Only the creator can resolve the dispute.
public fun resolve_dispute<Q>(
    market: &mut PredictionMarket<Q>,
    final_outcome: u8,
    ctx: &TxContext,
) {
    assert!(ctx.sender() == market.creator, ENotCreator);
    assert!(market.disputed, ENotDisputed);
    assert!(final_outcome == 1 || final_outcome == 2, EInvalidOutcome);

    market.resolved = true;
    market.outcome = final_outcome;
    market.disputed = false;

    event::emit(MarketUndisputedEvent {
        market_id: object::id(market),
        final_outcome,
        resolver: ctx.sender(),
    });
}

// ============================================================
// Settlement - redeem YES winning position (0.5% fee)
// ============================================================

/// Redeem YES winning position for quote collateral.
/// The protocol takes a 0.5% redemption fee.
public fun redeem<Q>(
    market: &mut PredictionMarket<Q>,
    winning_coin: Coin<YES<Q>>,
    ctx: &mut TxContext,
) {
    assert!(market.resolved, EMarketNotActive);
    assert!(!market.disputed, EAlreadyDisputed);
    let gross = coin::value(&winning_coin);
    assert!(gross > 0, EZeroAmount);

    // 0.5% redeem fee
    let fee = (gross * REDEEM_FEE_BPS) / BPS;
    let net = gross - fee;

    // Burn the winning YES tokens
    coin::burn(&mut market.yes_cap, winning_coin);

    // Split fee and return net collateral
    market.fee_balance.join(market.collateral.split(fee));
    let out = balance::split(&mut market.collateral, net);

    event::emit(RedeemedEvent {
        market_id: object::id(market),
        user: ctx.sender(),
        winning_amount: gross,
        fee,
        collateral_returned: net,
    });

    transfer::public_transfer(coin::from_balance(out, ctx), ctx.sender());
}

/// Redeem NO winning position for quote collateral.
/// The protocol takes a 0.5% redemption fee.
/// Only valid when the market resolved to NO (outcome = 2).
public fun redeem_no<Q>(
    market: &mut PredictionMarket<Q>,
    winning_coin: Coin<NO<Q>>,
    ctx: &mut TxContext,
) {
    assert!(market.resolved, EMarketNotActive);
    assert!(market.outcome == 2, EWrongOutcome);
    assert!(!market.disputed, EAlreadyDisputed);
    let gross = coin::value(&winning_coin);
    assert!(gross > 0, EZeroAmount);

    let fee = (gross * REDEEM_FEE_BPS) / BPS;
    let net = gross - fee;

    coin::burn(&mut market.no_cap, winning_coin);

    market.fee_balance.join(market.collateral.split(fee));
    let out = balance::split(&mut market.collateral, net);

    event::emit(RedeemedEvent {
        market_id: object::id(market),
        user: ctx.sender(),
        winning_amount: gross,
        fee,
        collateral_returned: net,
    });

    transfer::public_transfer(coin::from_balance(out, ctx), ctx.sender());
}

/// Redeem YES winning position with a streak multiplier applied. The
/// sender's `UserStreak` must belong to the sender. The multiplier is
/// sourced from `streak_system::get_multiplier_bps`.
public fun redeem_with_streak<Q>(
    market: &mut PredictionMarket<Q>,
    winning_coin: Coin<YES<Q>>,
    user_streak: &streak_system::UserStreak,
    ctx: &mut TxContext,
) {
    assert!(market.resolved, EMarketNotActive);
    assert!(!market.disputed, EAlreadyDisputed);
    assert!(ctx.sender() == streak_system::owner_of(user_streak), EWrongStreakOwner);

    let gross = coin::value(&winning_coin);
    assert!(gross > 0, EZeroAmount);

    // Apply streak multiplier first, then take the fee on the boosted amount.
    let multiplier = streak_system::get_multiplier_bps(user_streak);
    let boosted = (gross * multiplier) / 10_000;
    let fee = (boosted * REDEEM_FEE_BPS) / BPS;
    let net = boosted - fee;

    coin::burn(&mut market.yes_cap, winning_coin);

    market.fee_balance.join(market.collateral.split(fee));
    let out = balance::split(&mut market.collateral, net);

    event::emit(RedeemedEvent {
        market_id: object::id(market),
        user: ctx.sender(),
        winning_amount: gross,
        fee,
        collateral_returned: net,
    });

    transfer::public_transfer(coin::from_balance(out, ctx), ctx.sender());
}

/// Redeem NO winning position with a streak multiplier applied.
public fun redeem_no_with_streak<Q>(
    market: &mut PredictionMarket<Q>,
    winning_coin: Coin<NO<Q>>,
    user_streak: &streak_system::UserStreak,
    ctx: &mut TxContext,
) {
    assert!(market.resolved, EMarketNotActive);
    assert!(market.outcome == 2, EWrongOutcome);
    assert!(!market.disputed, EAlreadyDisputed);
    assert!(ctx.sender() == streak_system::owner_of(user_streak), EWrongStreakOwner);

    let gross = coin::value(&winning_coin);
    assert!(gross > 0, EZeroAmount);

    let multiplier = streak_system::get_multiplier_bps(user_streak);
    let boosted = (gross * multiplier) / 10_000;
    let fee = (boosted * REDEEM_FEE_BPS) / BPS;
    let net = boosted - fee;

    coin::burn(&mut market.no_cap, winning_coin);

    market.fee_balance.join(market.collateral.split(fee));
    let out = balance::split(&mut market.collateral, net);

    event::emit(RedeemedEvent {
        market_id: object::id(market),
        user: ctx.sender(),
        winning_amount: gross,
        fee,
        collateral_returned: net,
    });

    transfer::public_transfer(coin::from_balance(out, ctx), ctx.sender());
}

// ============================================================
// DeepBook Trading - place limit order
//
// Trading requires BOTH the PredictionMarket (shared) AND the
// BalanceManager (shared) to be passed as arguments. The caller
// fetches the BalanceManager using balance_manager_id from the market.
// ============================================================

/// Place a limit order on the DeepBook pool for YES tokens.
/// Uses the market's BalanceManager for funds and trading.
/// Price is in quote units (e.g. 500_000_000 = 0.5 Q with 9 decimals).
///
/// Arguments:
///   market          - PredictionMarket<Q> (shared)
///   pool            - Pool<YES<Q>, Q> (shared, mutable)
///   balance_manager - BalanceManager for this market (shared, mutable)
///   client_order_id - Client-supplied order ID for tracking
///   price           - Price in quote units (e.g. 500_000_000 = 0.5 Q)
///   quantity        - Base asset quantity (in YES * 10^decimals)
///   is_bid          - true = buy YES (bid), false = sell YES (ask)
///   order_type      - IOC=2, GFT=3, FOK=1, POST_ONLY=0
///   clock           - Clock for timestamping
///   ctx
public fun place_order<Q>(
    market: &mut PredictionMarket<Q>,
    pool: &mut Pool<YES<Q>, Q>,
    balance_manager: &mut BalanceManager,
    client_order_id: u64,
    price: u64,
    quantity: u64,
    is_bid: bool,
    order_type: u8,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(!market.resolved, EMarketNotActive);
    assert!(price > 0, EInvalidPrice);
    assert!(quantity > 0, EInvalidQuantity);

    // Generate trade proof as the BM owner
    let proof = balance_manager::generate_proof_as_owner(balance_manager, ctx);

    // Place the order
    let order_info = pool::place_limit_order<YES<Q>, Q>(
        pool,
        balance_manager,
        &proof,
        client_order_id,
        order_type,
        SELF_MATCHING_DISALLOW,
        price,
        quantity,
        is_bid,
        true,   // pay_with_deep = true (fee in DEEP)
        DEFAULT_EXPIRY,
        clock,
        ctx,
    );

    event::emit(OrderPlacedEvent {
        market_id: object::id(market),
        pool_id: market.pool_id,
        client_order_id,
        is_bid,
        price,
        quantity,
        order_id: order_info::order_id(&order_info),
    });
}

/// Place a market order (immediately executable at best price).
public fun place_market_order<Q>(
    market: &mut PredictionMarket<Q>,
    pool: &mut Pool<YES<Q>, Q>,
    balance_manager: &mut BalanceManager,
    client_order_id: u64,
    quantity: u64,
    is_bid: bool,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(!market.resolved, EMarketNotActive);
    assert!(quantity > 0, EInvalidQuantity);

    let proof = balance_manager::generate_proof_as_owner(balance_manager, ctx);

    let order_info = pool::place_market_order<YES<Q>, Q>(
        pool,
        balance_manager,
        &proof,
        client_order_id,
        SELF_MATCHING_DISALLOW,
        quantity,
        is_bid,
        true,
        clock,
        ctx,
    );

    event::emit(OrderPlacedEvent {
        market_id: object::id(market),
        pool_id: market.pool_id,
        client_order_id,
        is_bid,
        price: 0,
        quantity,
        order_id: order_info::order_id(&order_info),
    });
}

// ============================================================
// DeepBook Trading - cancel orders
// ============================================================

/// Cancel a single order on the DeepBook pool.
public fun cancel_order<Q>(
    market: &mut PredictionMarket<Q>,
    pool: &mut Pool<YES<Q>, Q>,
    balance_manager: &mut BalanceManager,
    order_id: u128,
    clock: &Clock,
    ctx: &TxContext,
) {
    assert!(!market.resolved, EMarketNotActive);

    let proof = balance_manager::generate_proof_as_owner(balance_manager, ctx);

    pool::cancel_live_order<YES<Q>, Q>(pool, balance_manager, &proof, order_id, clock, ctx);

    event::emit(OrderCancelledEvent {
        market_id: object::id(market),
        pool_id: market.pool_id,
        order_id,
    });
}

/// Cancel multiple orders on the DeepBook pool.
public fun cancel_orders<Q>(
    market: &mut PredictionMarket<Q>,
    pool: &mut Pool<YES<Q>, Q>,
    balance_manager: &mut BalanceManager,
    order_ids: vector<u128>,
    clock: &Clock,
    ctx: &TxContext,
) {
    assert!(!market.resolved, EMarketNotActive);

    let proof = balance_manager::generate_proof_as_owner(balance_manager, ctx);

    pool::cancel_live_orders<YES<Q>, Q>(pool, balance_manager, &proof, order_ids, clock, ctx);

    event::emit(OrdersBatchCancelledEvent {
        market_id: object::id(market),
        pool_id: market.pool_id,
        order_ids,
    });
}

/// Withdraw settled amounts from the pool back to BalanceManager.
public fun withdraw_settled<Q>(
    market: &mut PredictionMarket<Q>,
    pool: &mut Pool<YES<Q>, Q>,
    balance_manager: &mut BalanceManager,
    ctx: &mut TxContext,
) {
    let proof = balance_manager::generate_proof_as_owner(balance_manager, ctx);
    pool::withdraw_settled_amounts<YES<Q>, Q>(pool, balance_manager, &proof);

    event::emit(SettledEvent {
        market_id: object::id(market),
        pool_id: market.pool_id,
        trader: ctx.sender(),
    });
}

// ============================================================
// DeepBook Trading - cancel all orders
// ============================================================

/// Cancel ALL open orders for this market's BalanceManager on the pool.
public fun cancel_all_orders<Q>(
    market: &mut PredictionMarket<Q>,
    pool: &mut Pool<YES<Q>, Q>,
    balance_manager: &mut BalanceManager,
    clock: &Clock,
    ctx: &TxContext,
) {
    assert!(!market.resolved, EMarketNotActive);

    let proof = balance_manager::generate_proof_as_owner(balance_manager, ctx);
    pool::cancel_all_orders<YES<Q>, Q>(pool, balance_manager, &proof, clock, ctx);
}

// ============================================================
// DeepBook Trading - BalanceManager funding
//
// Before placing orders the BalanceManager must have:
//   1. Q (quote coin) deposited for order collateral
//   2. YES<Q> deposited as base asset for asks
//   3. DEEP deposited for trading fees (if pay_with_deep = true)
//
// All three are deposited via deposit_for_trading below.
// ============================================================

/// Deposit quote coin and YES base coin into the BalanceManager for trading.
/// Also deposits DEEP for trading fees.
/// Call this before place_order / place_market_order.
public fun deposit_for_trading<Q>(
    _market: &PredictionMarket<Q>,
    balance_manager: &mut BalanceManager,
    base_coin: Coin<YES<Q>>,
    quote_coin: Coin<Q>,
    deep_coin: Coin<DEEP>,
    ctx: &mut TxContext,
) {
    deposit(balance_manager, base_coin, ctx);
    deposit(balance_manager, quote_coin, ctx);
    deposit(balance_manager, deep_coin, ctx);
}

// ============================================================
// DeepBook referral - protocol earns extra trading fees
// ============================================================

/// Mint a DeepBook referral for the market's pool, making this protocol
/// the owner of the referral so it can claim additional trading fees.
/// Only callable once per market.
public fun setup_referral<Q>(
    market: &mut PredictionMarket<Q>,
    pool: &mut Pool<YES<Q>, Q>,
    multiplier: u64,  // e.g. 1_000_000_000 = 1.0x referral bonus (must be multiple of 100_000_000)
    ctx: &mut TxContext,
) {
    assert!(ctx.sender() == market.creator, ENotCreator);
    assert!(option::is_none(&market.referral_id), EReferralAlreadySet);

    let referral_id = pool::mint_referral<YES<Q>, Q>(pool, multiplier, ctx);
    market.referral_id = option::some(referral_id);

    event::emit(ReferralSetEvent {
        market_id: object::id(market),
        referral_id,
    });
}

/// Claim accumulated referral rewards from DeepBook for the market's pool.
/// Only the referral owner (set during setup_referral) can call this.
/// Rewards go to the caller.
public fun claim_referral_rewards<Q>(
    pool: &mut Pool<YES<Q>, Q>,
    referral: &DeepBookPoolReferral,
    ctx: &mut TxContext,
) {
    let (yes_dust, quote_coins, deep_coins) = pool::claim_pool_referral_rewards<YES<Q>, Q>(pool, referral, ctx);
    transfer::public_transfer(yes_dust, ctx.sender());
    transfer::public_transfer(quote_coins, ctx.sender());
    transfer::public_transfer(deep_coins, ctx.sender());
}

// ============================================================
// Admin - withdraw accumulated protocol fees
// ============================================================

/// Withdraw accumulated fees from the shared FeeVault.
public fun withdraw_fees<Q>(
    vault: &mut FeeVault<Q>,
    amount: u64,
    ctx: &mut TxContext,
) {
    assert!(ctx.sender() == vault.admin, ENotAdmin);
    assert!(amount > 0, EZeroAmount);

    let out = balance::split(&mut vault.fee_balance, amount);

    event::emit(FeesWithdrawnEvent {
        admin: ctx.sender(),
        amount,
    });

    transfer::public_transfer(coin::from_balance(out, ctx), vault.admin);
}

// ============================================================
// View functions
// ============================================================

public fun collateral_value<Q>(market: &PredictionMarket<Q>): u64 {
    balance::value(&market.collateral)
}

public fun fee_balance<Q>(market: &PredictionMarket<Q>): u64 {
    balance::value(&market.fee_balance)
}

public fun is_resolved<Q>(market: &PredictionMarket<Q>): bool {
    market.resolved
}

public fun market_outcome<Q>(market: &PredictionMarket<Q>): u8 {
    market.outcome
}

public fun expiry<Q>(market: &PredictionMarket<Q>): u64 {
    market.expiry_ms
}

public fun pool_id<Q>(market: &PredictionMarket<Q>): ID {
    market.pool_id
}

public fun referral_id<Q>(market: &PredictionMarket<Q>): Option<ID> {
    market.referral_id
}

public fun is_disputed<Q>(market: &PredictionMarket<Q>): bool {
    market.disputed
}

public fun dispute_count<Q>(market: &PredictionMarket<Q>): u64 {
    market.dispute_count
}

public fun dispute_evidence_uri<Q>(market: &PredictionMarket<Q>): &vector<u8> {
    &market.dispute_evidence_uri
}

// ============================================================
// Imports
// ============================================================

use std::vector;
use std::option::{Self, Option};
