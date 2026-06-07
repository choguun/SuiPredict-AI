/**
 * Prediction Market SDK — DeepBook V3 integrated
 *
 * Wraps prediction_market.move (suipredict module) functions:
 *   create_market, mint_shares, resolve_market,
 *   redeem, redeem_no, setup_referral, claim_referral_rewards, withdraw_fees
 *
 * Market making is handled by deepbook/client.ts (DeepBookClient).
 * This module handles only the prediction-market-specific on-chain calls.
 */
import { Transaction } from "@mysten/sui/transactions";
import { type DeepBookClient } from "./deepbook/client.js";
import type { SuiClient } from "./predict-client.js";
/** PredictionMarket package ID — single source of truth is `AGENT_POLICY_PACKAGE_ID`
 *  in `./constants.js`, which carries the on-chain address from
 *  `packages/contracts/Published.toml`. The package contains
 *  `prediction_market`, `streak_system`, `prize_pool`, `agent_policy`,
 *  and `types`; `PREDICT_MARKET_PACKAGE_ID` is re-exported here for
 *  backwards compatibility with the previous (and now-stale) name.
 *
 *  Override at deploy time via `NEXT_PUBLIC_AGENT_POLICY_PACKAGE_ID`
 *  (Next.js) or `AGENT_POLICY_PACKAGE_ID` (server/agents).
 */
export declare const PREDICT_MARKET_PACKAGE_ID: string;
/** FeeVault<DUSDC> object ID — set after contract deployment. The
 *  NEXT_PUBLIC_ variant is read first so Next.js inlines it into the
 *  client bundle; the bare `FEE_VAULT_ID` is the server/agents variant.
 *
 *  R43 audit fix: apply `.trim()` to the env chain to match the
 *  R41 pattern on `DUSDC_PACKAGE_ID` / `AGENT_POLICY_PACKAGE_ID`.
 *  A `.env` line with trailing whitespace (common when a value
 *  is pasted from a docs page or terminal copy) silently produces
 *  an id like `0x…0000 ` with a trailing space; the BCS object
 *  resolver treats the trimmed and untrimmed forms as different
 *  inputs and the PTB aborts with "invalid input object".
 */
export declare const FEE_VAULT_ID: string;
/** Protocol treasury address for withdrawing accumulated fees and claiming referral rewards.
 *
 *  R43 audit fix: same `.trim()` as FEE_VAULT_ID above. A
 *  whitespace-suffixed address would route the
 *  `referral_keeper` sweep to a non-existent recipient.
 */
export declare const REFERRAL_TREASURY_ADDRESS: string;
/**
 * Build `create_market` transaction.
 *
 * Creates a new prediction market + DeepBook pool + YES/NO coin types.
 * Returns (market_id, pool_id) as created objects.
 *
 * @param params.title            - Market question
 * @param params.resolutionSource - How the market resolves
 * @param params.expiryMs        - Unix timestamp (ms) when resolution becomes allowed
 * @param params.tickSize        - Price tick in quote units (e.g. 1_000_000 = 0.001 DUSDC with 6 decimals)
 * @param params.lotSize         - Minimum base-asset quantity per order (in YES * 10^decimals)
 * @param params.minSize         - Minimum order size in base units
 * @param params.deepCoinId      - Object ID of a Coin<DEEP> with at least 500 DEEP for pool creation fee (REQUIRED)
 * @param params.category        - Off-chain topic code forwarded to
 *                                 `MarketCreatedEvent.category`. 0=none,
 *                                 1=AI news, 2=crypto price, 3=other. The
 *                                 on-chain `PredictionMarket` does not
 *                                 store this — the indexer only reads it
 *                                 from the event for leaderboards.
 */
export declare function buildCreateMarketTx(params: {
    title: string;
    resolutionSource: string;
    expiryMs: bigint;
    tickSize?: bigint;
    lotSize?: bigint;
    minSize?: bigint;
    deepCoinId: string;
    category?: number;
}): Transaction;
/**
 * Build `mint_shares` transaction.
 *
 * Deposits collateral (DUSDC) and receives equal YES + NO tokens.
 * Takes a 1% protocol fee, routed to the shared `FeeVault<DUSDC>`.
 *
 * @param marketId - PredictionMarket object ID
 * @param vaultId  - FeeVault<DUSDC> object ID (set after `init_fee_vault<DUSDC>`)
 * @param quoteIn  - Coin<DUSDC> to deposit
 */
export declare function buildMintSharesTx(marketId: string, vaultId: string, quoteIn: string, amountAtoms: bigint): Transaction;
/**
 * Build a single PTB that mints `amountPerMarket` of DUSDC into each of
 * `marketIds` in one transaction. The input coin is split in-PTB so the
 * caller only needs to provide a single Coin<DUSDC> with
 * `amountPerMarket * marketIds.length` atoms of balance.
 *
 * Used by the daily-prediction card where the user locks in 3-5 markets
 * at once; submitting them sequentially would consume the same Coin
 * object in tx #1, leaving tx #2..N with a stale reference.
 */
export declare function buildMintSharesBatchTx(params: {
    marketIds: string[];
    vaultId: string;
    quoteIn: string;
    amountPerMarket: bigint;
}): Transaction;
/**
 * Build `resolve_market` transaction.
 *
 * R42 audit fix: normalize the object id to the canonical
 * `0x` + 64 hex form. Sui's BCS object resolver is case-
 * sensitive in some paths and case-insensitive in others, and
 * the `Input::Pure` / `Input::Object` encoding requires the
 * canonical form. Wallets and explorers occasionally hand us
 * mixed-case ids; passing them through raw can fail with
 * `invalid input object`.
 *
 * @param marketId - PredictionMarket object ID
 * @param outcome  - 1 = YES won, 2 = NO won
 */
export declare function buildResolveMarketTx(marketId: string, outcome: 1 | 2): Transaction;
/**
 * Build `redeem` (YES winning) transaction.
 *
 * @param marketId    - PredictionMarket object ID
 * @param vaultId     - FeeVault<DUSDC> object ID
 * @param winningCoin - Coin<YES<DUSDC>> to redeem
 */
export declare function buildRedeemTx(marketId: string, vaultId: string, winningCoin: string): Transaction;
export declare function buildDisputeMarketTx(marketId: string, evidenceUri: string | Uint8Array): Transaction;
/**
 * Build `resolve_dispute` transaction. Settles a previously-disputed
 * market. Only the creator may invoke.
 */
export declare function buildResolveDisputeTx(marketId: string, finalOutcome: 1 | 2): Transaction;
/**
 * Build `redeem_no` (NO winning) transaction.
 *
 * @param marketId    - PredictionMarket object ID
 * @param vaultId     - FeeVault<DUSDC> object ID
 * @param winningCoin - Coin<NO<DUSDC>> to redeem
 */
export declare function buildRedeemNoTx(marketId: string, vaultId: string, winningCoin: string): Transaction;
/**
 * Build `redeem_with_streak` (YES winning) transaction. Burns winning
 * YES tokens and pays out collateral multiplied by the user's streak
 * multiplier. The 0.5% protocol fee is routed to the shared `FeeVault`.
 *
 * The on-chain function lives in `prediction_market.move` (same package
 * as the rest of the redemption API). It was originally exposed from
 * `streak-client.ts` because it takes a `UserStreak` arg, but every
 * other redemption function lives here — moved in r16 to keep the
 * `prediction_market::*` wrappers co-located.
 */
export declare function buildRedeemWithStreakTx(marketId: string, vaultId: string, winningCoinId: string, streakId: string): Transaction;
/** Build `redeem_no_with_streak` transaction. See `buildRedeemWithStreakTx`. */
export declare function buildRedeemNoWithStreakTx(marketId: string, vaultId: string, winningCoinId: string, streakId: string): Transaction;
/**
 * Build `setup_referral` transaction.
 *
 * Mints a DeepBook referral for the market's pool, making this protocol
 * the owner so it can claim additional trading fees.
 *
 * @param marketId  - PredictionMarket object ID
 * @param poolId    - DeepBook Pool object ID (Pool<YES<DUSDC>, DUSDC>)
 * @param multiplier - Referral multiplier (e.g. 1_000_000_000 = 1.0x)
 */
export declare function buildSetupReferralTx(marketId: string, poolId: string, multiplier?: bigint): Transaction;
/**
 * Build `claim_referral_rewards` transaction.
 *
 * Move signs the reward coins to `ctx.sender()` — the caller is the
 * recipient. To route to a treasury, sign the tx with the treasury key.
 *
 * @param poolId     - DeepBook Pool object ID
 * @param referralId - DeepBookPoolReferral object ID
 */
export declare function buildClaimReferralRewardsTx(poolId: string, referralId: string): Transaction;
/**
 * Build `withdraw_fees` transaction.
 *
 * @param vaultId - FeeVault<DUSDC> object ID
 * @param amount  - Amount of DUSDC to withdraw
 */
export declare function buildWithdrawFeesTx(vaultId: string, amount: bigint): Transaction;
/**
 * Build `init_fee_vault` transaction. Called once per quote-coin type
 * by the holder of the `ProtocolAdminCap`. The shared vault object is
 * returned; its `objectId` must be stored in `FEE_VAULT_ID` for later
 * mint/redeem/withdraw-fees calls.
 *
 * @param adminCapId   - ProtocolAdminCap object ID
 * @param vaultAdmin   - Address that will own withdrawals from the vault
 */
export declare function buildInitFeeVaultTx(adminCapId: string, vaultAdmin: string): Transaction;
/**
 * Get the on-chain DeepBook order book depth for a prediction market pool.
 *
 * @param dbClient - DeepBookClient instance
 * @param poolId   - DeepBook Pool ID (from MarketInfo.deepbook_pool_id)
 * @param lowPrice  - Minimum price to query (default 0.01)
 * @param highPrice - Maximum price to query (default 0.99)
 */
export declare function getMarketOrderBook(dbClient: DeepBookClient, poolId: string, lowPrice?: number, highPrice?: number): Promise<import("./deepbook/client.js").OrderBookDepth>;
/**
 * Get mid price from DeepBook pool.
 */
export declare function getMarketMidPrice(dbClient: DeepBookClient, poolId: string): Promise<number>;
/**
 * Compute the YES coin type for a given market's PredictionMarket object.
 * YES<Q> = <package>::prediction_market::YES<DUSDC>
 *
 * In Move, the generic type parameter is part of the type identity.
 * For a market at object ID M, the YES type is: <package>::prediction_market::YES<DUSDC>
 */
export declare function yesCoinType(packageId?: string): string;
export declare function noCoinType(packageId?: string): string;
/**
 * Place a limit order on the DeepBook pool for YES/DUSDC.
 * Convenience wrapper around buildDeepBookPlaceLimitOrderTx.
 */
export declare function buildPlaceYesLimitOrderTx(dbClient: DeepBookClient, poolKey: string, params: {
    price: number;
    quantity: number;
    isBid: boolean;
    clientOrderId?: string;
    expiration?: number;
}): Transaction;
/**
 * Withdraw settled amounts from the DeepBook pool.
 */
export declare function buildWithdrawSettledTx(dbClient: DeepBookClient, poolKey: string): Transaction;
/**
 * Withdraw settled amounts via the market wrapper. Routes through
 * `prediction_market::withdraw_settled` (not the bare DeepBook call)
 * so the on-chain `SettledEvent` is emitted. The market-level event
 * is what the position-indexer uses to advance the `settled_weeks`
 * cursor on the leaderboard; calling the bare `pool::withdraw_settled`
 * bypasses the indexer path entirely, so a settled week would never
 * mark `claimed=true` for the matching off-chain leaderboard row.
 *
 * @param marketId         - `PredictionMarket<Q>` object id
 * @param poolId           - DeepBook `Pool<YES<Q>, Q>` object id (the
 *                           market stores this in `pool_id`; the UI
 *                           can read it via `getMarket`)
 * @param balanceManagerId - user's `BalanceManager` for this market
 */
export declare function buildMarketWithdrawSettledTx(marketId: string, poolId: string, balanceManagerId: string): Transaction;
/**
 * Build `place_market_order` transaction. Submits a taker order that
 * sweeps the book at the best available price (DeepBook's place_market_order).
 * Aborts with `EInvalidQuantity` if quantity == 0, `EMarketNotActive`
 * if the market is resolved or disputed.
 *
 * @param marketId         - PredictionMarket<Q> object ID
 * @param poolId           - DeepBook Pool<YES<Q>, Q> object ID
 * @param balanceManagerId - User's BalanceManager object ID
 * @param clientOrderId    - User-chosen order id (typically a monotonic counter)
 * @param quantity         - Base-asset quantity (YES * 10^decimals)
 * @param isBid            - true = buy YES with quote, false = sell YES for quote
 */
export declare function buildPlaceMarketOrderTx(params: {
    marketId: string;
    poolId: string;
    balanceManagerId: string;
    clientOrderId: bigint;
    quantity: bigint;
    isBid: boolean;
}): Transaction;
/**
 * Build `place_order` transaction — the limit-order counterpart to
 * `buildPlaceMarketOrderTx`. Routes through the prediction_market
 * wrapper that emits `OrderPlacedEvent { market_id, pool_id, ... }`,
 * which the position-indexer observes to advance the `settled_weeks`
 * cursor and to surface the order in the user's portfolio.
 *
 * R50 audit fix: this wrapper did not exist. The only
 * limit-order builder was `buildDeepBookPlaceLimitOrderTx`
 * (`deepbook/client.ts:165`) which calls DeepBook's
 * `pool::place_limit_order` directly, bypassing the
 * wrapper's `OrderPlacedEvent` carrying `market_id` — the
 * position-indexer relies on this event to advance the
 * `settled_weeks` cursor. The wrapper was dead in both
 * directions: not exposed by the SDK, and the web's
 * `placeOrder` button could only call the DeepBook-direct
 * path. The fix adds the wrapper, exports it from the
 * barrel, and re-points the web's `placeOrder` to use it
 * (see `apps/web/app/markets/[id]/page.tsx`).
 *
 * `orderType` is the DeepBook `OrderType` u8: 0=POST_ONLY,
 * 1=FOK, 2=IOC, 3=GFT (default). The on-chain module
 * asserts `is_bid` xor `is_ask` semantics via DeepBook's
 * own check; the wrapper only requires a non-zero
 * price/quantity (the on-chain assert is `price > 0,
 * quantity > 0`, matching `EMarketNotActive` /
 * `EInvalidPrice` / `EInvalidQuantity`).
 */
export declare function buildPlaceOrderTx(params: {
    marketId: string;
    poolId: string;
    balanceManagerId: string;
    clientOrderId: bigint;
    /**
     * Price in *quote units* (e.g. `500_000_000n` = 0.5 DUSDC).
     * The on-chain module's docstring at
     * `prediction_market.move:737` calls this out:
     * "Price in quote units (e.g. 500_000_000 = 0.5 Q)".
     * Callers passing a human-readable price (0.01..0.99)
     * should multiply by 1e9 — see `QUOTE_SCALE` below.
     */
    price: bigint;
    quantity: bigint;
    isBid: boolean;
    orderType?: number;
}): Transaction;
/**
 * The on-chain wrapper's price is in 1e9-scaled quote
 * units (dUSDC has 6 decimals, so the wrapper multiplies
 * 1e3 to round-trip to a fixed-point representation that
 * matches DeepBook's expected `u64` ticks). Export the
 * constant so web callers passing a 0..1 dollar price can
 * do `BigInt(Math.round(price * QUOTE_SCALE))` without
 * hardcoding the magic number.
 */
export declare const QUOTE_SCALE = 1000000000n;
/**
 * Build `cancel_order` transaction. Cancels a single open order by its
 * DeepBook-assigned `order_id`. Aborts with `EMarketNotActive` if the
 * market is resolved.
 */
export declare function buildCancelOrderTx(params: {
    marketId: string;
    poolId: string;
    balanceManagerId: string;
    orderId: bigint;
}): Transaction;
/**
 * Build `cancel_orders` transaction. Batch-cancels a set of open orders.
 * Each `orderId` is a u128 as DeepBook assigns them. The on-chain
 * `cancel_live_orders` is the underlying call; the event is
 * `OrdersBatchCancelledEvent` (one per tx, not one per order).
 */
export declare function buildCancelOrdersTx(params: {
    marketId: string;
    poolId: string;
    balanceManagerId: string;
    orderIds: bigint[];
}): Transaction;
/**
 * Build `cancel_all_orders` transaction. Cancels every open order for
 * this `BalanceManager` on the market's DeepBook pool. The on-chain
 * function does not emit a batch event; the position-indexer observes
 * the per-order `OrderCancelledEvent` (zero or more) that follow.
 */
export declare function buildCancelAllOrdersTx(params: {
    marketId: string;
    poolId: string;
    balanceManagerId: string;
}): Transaction;
/**
 * Build `deposit_for_trading` transaction. Deposits `Coin<YES<Q>>`,
 * `Coin<Q>`, and `Coin<DEEP>` into the user's `BalanceManager` so they
 * can place orders on the DeepBook pool. The three deposits are atomic
 * (one tx) — the on-chain function aborts if any coin is missing.
 *
 * All three coin IDs are required; pre-validation is the caller's
 * responsibility (e.g. resolve them from the user's Coin list first).
 *
 * @param marketId         - PredictionMarket<Q> object ID (referenced
 *                           for symmetry with on-chain signature; the
 *                           on-chain `_market` is unused — deposits go
 *                           straight into the BalanceManager)
 * @param balanceManagerId - User's BalanceManager object ID
 * @param baseCoinId       - Coin<YES<DUSDC>> (held for ask orders)
 * @param quoteCoinId      - Coin<DUSDC> (held for bid orders)
 * @param deepCoinId       - Coin<DEEP> (held for fee rebates)
 */
export declare function buildDepositForTradingTx(params: {
    marketId: string;
    balanceManagerId: string;
    baseCoinId: string;
    quoteCoinId: string;
    deepCoinId: string;
}): Transaction;
/**
 * Create a DeepBook client configured for a specific prediction market pool.
 *
 * @param client      - SuiClient
 * @param address     - User's Sui address
 * @param poolId      - DeepBook Pool ID (from MarketInfo.deepbook_pool_id)
 * @param poolKey     - Pool key string (e.g. "market_abc12345" or PREDICT_DEEPBOOK_POOL_KEY)
 * @param balanceManagerId - Optional BalanceManager ID for trading
 */
export declare function createMarketDeepBookClient(client: SuiClient, address: string, poolId: string, poolKey?: string, balanceManagerId?: string): DeepBookClient;
/**
 * Build `vault::deposit` transaction. Deposits `Coin<QuoteCoin>` into the
 * `ProtocolVault<QuoteCoin>` and returns a freshly-minted `Coin<VLP>` to
 * the caller. Use `buildVaultWithdrawTx` to redeem.
 *
 * @param vaultId     - ProtocolVault<QuoteCoin> object ID
 * @param coinId      - Object ID of a Coin<QuoteCoin> with amount > 0
 * @param quoteType   - The quote coin type (e.g. DUSDC_TYPE or DBUSDC_TYPE)
 * @param recipient   - Address to receive the VLP coin (defaults to tx sender)
 */
export declare function buildVaultDepositTx(vaultId: string, coinId: string, amountAtoms: number | bigint, quoteType?: string, recipient?: string): Transaction;
/**
 * Build `vault::withdraw` transaction. Burns a `Coin<VLP>` and returns
 * `Coin<QuoteCoin>` to the caller. Withdraw is bounded by
 * `available_balance` (i.e. excludes the `allocated` reserve).
 */
export declare function buildVaultWithdrawTx(vaultId: string, vlpCoinId: string, quoteType?: string): Transaction;
/**
 * Build `vault::create_vault` transaction. Consumes a
 * `TreasuryCap<VLP>` and produces a shared `ProtocolVault<QuoteCoin>`.
 * The TreasuryCap is destroyed by this call — there is no
 * post-creation mint path, which is what makes the VLP supply
 * equal to the on-chain quote balance.
 *
 * Round-27 audit finding C1: the bootstrap script used to build this
 * PTB inline; this builder consolidates the call so the /admin
 * VaultAdminCard and the bootstrap can share the same code path.
 *
 * @param vlpTreasuryCapId  - TreasuryCap<VLP> object ID (from the
 *                            VLP module's init, or `vlp::mint` for
 *                            self-hosted deployments)
 * @param quoteType         - Quote coin type (e.g. DUSDC_TYPE or DBUSDC_TYPE)
 */
export declare function buildCreateVaultTx(vlpTreasuryCapId: string, quoteType?: string): Transaction;
/**
 * Build `vault::allocate_for_mm` transaction. Moves `amount` of
 * `QuoteCoin` from the vault's available balance to its `allocated`
 * reserve and returns a `Coin<QuoteCoin>` for the market-maker to
 * deposit into a DeepBook balance manager. Admin-only.
 *
 * The on-chain guard is `amount <= available_balance` — callers
 * should pre-flight against the live `available` read to avoid
 * paying gas for a tx that will revert with `EInsufficientAvailable`.
 *
 * @param vaultId    - ProtocolVault<QuoteCoin> object ID
 * @param amount     - Amount in base units of QuoteCoin
 * @param quoteType  - Quote coin type (e.g. DUSDC_TYPE or DBUSDC_TYPE)
 */
export declare function buildAllocateForMmTx(vaultId: string, amount: bigint, quoteType?: string): Transaction;
/**
 * Build `vault::return_from_mm` transaction. Returns a
 * `Coin<QuoteCoin>` to the vault, decreasing the `allocated` reserve
 * and increasing `available_balance`. Admin-only.
 *
 * The on-chain guard is `coin::value(&coin) <= allocated` — callers
 * should pre-flight against the live `allocated` read to avoid
 * paying gas for a tx that will revert with `EInsufficientAvailable`.
 *
 * @param vaultId    - ProtocolVault<QuoteCoin> object ID
 * @param coinId     - Object ID of a Coin<QuoteCoin> returned from
 *                     a market-maker (must not be a balance manager
 *                     deposit — return it from the balance manager
 *                     first via `withdraw_settled` or DeepBook's
 *                     own withdraw)
 * @param quoteType  - Quote coin type (e.g. DUSDC_TYPE or DBUSDC_TYPE)
 */
export declare function buildReturnFromMmTx(vaultId: string, coinId: string, quoteType?: string): Transaction;
/**
 * Build `registry::create_registry` transaction. Anyone can call;
 * `ctx.sender()` becomes the registry admin.
 */
export declare function buildCreateRegistryTx(): Transaction;
/**
 * Build `registry::register_market` transaction. Only the registry
 * admin may invoke. Typically called by the market creator after
 * each successful `create_market`.
 */
export declare function buildRegisterMarketTx(registryId: string, marketObjectId: string): Transaction;
//# sourceMappingURL=prediction-market-client.d.ts.map