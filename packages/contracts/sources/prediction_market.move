/// DeepBook V3-integrated prediction market.
/// Uses DeepBook Pool<YES<QUOTE>, QUOTE> as the orderbook CLOB.
/// YES/NO are TreasuryCap-backed Sui coins with 1:1 collateral backing.
#[allow(deprecated_usage)]
module suipredict::prediction_market;

// ============================================================
// Imports
// ============================================================

use deepbook::balance_manager::DeepBookPoolReferral;
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
    /// Optional DeepBook referral ID for this market's pool
    referral_id: Option<ID>,
    /// Timestamp (ms) when the market was created
    created_ms: u64,
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

public struct ReferralSetEvent has copy, drop {
    market_id: ID,
    referral_id: ID,
}

public struct FeesWithdrawnEvent has copy, drop {
    admin: address,
    amount: u64,
}

// ============================================================
// initializer
// ============================================================

/// Creates the FeeVault for DBUSDC and shares it. Called once at publish time.
fun init(ctx: &mut TxContext) {
    let vault = FeeVault<DBUSDC> {
        id: object::new(ctx),
        admin: ctx.sender(),
        fee_balance: balance::zero(),
    };
    transfer::share_object(vault);
}

/// Placeholder DBUSDC coin type - in production would be real DBUSDC.
public struct DBUSDC has drop {}

// ============================================================
// Market creation
// ============================================================

/// Creates a new prediction market, its YES/NO coin types, and a DeepBook pool.
/// Returns (market_id, pool_id).
///
/// This function handles everything in one PTB:
///   1. Call pool_creation_fee() to get the 500 DEEP creation fee
///   2. Create the DeepBook Pool<YES<Q>, Q> via create_permissionless_pool
///   3. Create PredictionMarket<Q> with YES/NO TreasuryCaps
///
/// Arguments:
///   registry         - DeepBook registry (must be shared)
///   title            - Market question / title
///   resolution_source - URL or description of how resolution occurs
///   expiry_ms        - Unix timestamp (ms) after which market can be resolved
///   tick_size        - Price tick in quote units (e.g. 1_000_000 = 0.001 DBUSDC with 6 decimals)
///   lot_size         - Minimum base-asset quantity per order (in YES * 10^decimals)
///   min_size         - Minimum order size in base units
///   deep_coin        - Coin<DEEP> for pool creation fee (500 DEEP)
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
): (ID, ID) {
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

    // 2. Create YES and NO coin currencies
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

    // 3. Create the PredictionMarket with YES/NO TreasuryCaps
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
        referral_id: option::none(),
        created_ms: ctx.epoch_timestamp_ms(),
    };

    let market_id = object::id(&market);
    event::emit(MarketCreatedEvent {
        market_id,
        pool_id: pool_id,
        title: market.title,
        expiry_ms,
        creator,
    });

    transfer::share_object(market);
    (market_id, pool_id)
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
public fun redeem_no<Q>(
    market: &mut PredictionMarket<Q>,
    winning_coin: Coin<NO<Q>>,
    ctx: &mut TxContext,
) {
    assert!(market.resolved, EMarketNotActive);
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
/// All three Coin outputs are transferred to the nominated treasury address.
public fun claim_referral_rewards<Q>(
    pool: &mut Pool<YES<Q>, Q>,
    referral: &DeepBookPoolReferral,
    treasury: address,
    ctx: &mut TxContext,
) {
    let (yes_dust, quote_coins, deep_coins) = pool::claim_pool_referral_rewards<YES<Q>, Q>(pool, referral, ctx);
    transfer::public_transfer(yes_dust, treasury);
    transfer::public_transfer(quote_coins, treasury);
    transfer::public_transfer(deep_coins, treasury);
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