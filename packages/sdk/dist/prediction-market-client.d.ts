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
import type { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
/** PredictionMarket package ID — single source of truth is `AGENT_POLICY_PACKAGE_ID`
 *  in `./constants.js`, which carries the on-chain address from
 *  `packages/contracts/Published.toml`. The package contains
 *  `prediction_market`, `streak_system`, `prize_pool`, `agent_policy`,
 *  and `types`; `PREDICT_MARKET_PACKAGE_ID` is re-exported here for
 *  backwards compatibility with the previous (and now-stale) name.
 *
 *  R-UAT-23 follow-up: at module-init time, prefer the
 *  env-configurable `MARKET_PACKAGE_ID` over the
 *  `AGENT_POLICY_PACKAGE_ID` so a deploy can point the SDK
 *  at a *separate* `prediction_market` package (e.g. the
 *  historical `0x23b78ca…` that owns the on-chain YES<DUSDC>
 *  pool) rather than the co-located `agent_policy` package
 *  (0xb1777f…). Without this, every `buildCreateMarket*Tx`
 *  call would target a `prediction_market::YES<Q>` whose
 *  type is *different* from the YES type of the on-chain
 *  pool the bootstrap script shares, and Move's type
 *  system would reject the call with a "pool type
 *  mismatch" error. The previous `AGENT_POLICY_PACKAGE_ID`
 *  default is preserved as a fallback for older deploys
 *  where the two packages were the same.
 *
 *  Override at deploy time via `NEXT_PUBLIC_MARKET_PACKAGE_ID`
 *  (Next.js) or `MARKET_PACKAGE_ID` (server/agents).
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
/** R-WC-3 v3: id of the `SharedTreasuryHolder<Q>` shared object
 *  that holds the per-package YES/Q + NO/Q TreasuryCaps. Created
 *  once at module bootstrap via
 *  `init_yes_no_currencies<Q>(...)`. All `create_market<Q>`,
 *  `mint_shares<Q>`, and `redeem{,_no,_with_streak}<Q>` PTBs
 *  must include this shared object as a `&mut` arg. The bare
 *  `SHARED_TREASURY_HOLDER_ID` is the server/agents variant;
 *  the web bundle uses the `NEXT_PUBLIC_*` form (the
 *  `predict-server` env.ts also reads this for the web side).
 */
export declare const SHARED_TREASURY_HOLDER_ID: string;
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
    /**
     * R-WC-2: per-market phantom `M: address`. Threaded as the
     * second type argument so `create_market<Q, M>` produces a
     * unique `YES<Q, M>` coin type per market (bypasses the Sui
     * CoinRegistry's one-Currency-per-T-per-package limit).
     * When provided, this REPLACES the broken `withMarketType`
     * post-processor (which only mutated a getData() snapshot
     * and never reached the actual BCS serializer).
     */
    m?: string;
}): Transaction;
/**
 * R-UAT-23 fix: build `create_market_with_pool` transaction.
 *
 * Alternative entry point that reuses an already-existing DeepBook
 * pool instead of creating a new one. The standard
 * `buildCreateMarketTx` calls `pool::create_permissionless_pool`,
 * which aborts with `EPoolAlreadyExists` (code 1) when a
 * YES<DUSDC> pool is already in the registry — which is the
 * case on the self-hosted DeepBook after the first market is
 * created. This builder wraps `create_market_with_pool`:
 * - Skips pool creation (no 500 DEEP fee required)
 * - Skips the deepbook_registry argument (not needed)
 * - Takes a `&mut Pool<YES<Q>, Q>` reference instead
 * - Otherwise identical signature: creates BalanceManager +
 *   YES/NO TreasuryCaps + PredictionMarket in one PTB
 *
 * Use case: `apps/agents/scripts/bootstrap-wc-markets.mjs` first
 * attempts `buildCreateMarketTx`; on `EPoolAlreadyExists` it
 * looks up the existing pool by base/quote TypeName and calls
 * this builder instead. Multiple markets can share the same
 * DeepBook pool (different YES/NO TreasuryCaps per market),
 * which is the canonical Polymarket-style design.
 *
 * @param params.title            - Market question
 * @param params.resolutionSource - How the market resolves
 * @param params.expiryMs        - Unix timestamp (ms) when
 *                                 resolution becomes allowed
 * @param params.poolId          - Object ID of the existing
 *                                 Pool<YES<Q>, Q>
 * @param params.category        - Off-chain topic code (0..3)
 */
export declare function buildCreateMarketWithPoolTx(params: {
    title: string;
    resolutionSource: string;
    expiryMs: bigint;
    poolId: string;
    category?: number;
    /**
     * R-WC-2: per-market phantom `M: address`. Threaded as the
     * second type argument so `create_market_with_pool<Q, M>`
     * produces a unique `YES<Q, M>` coin type per market.
     */
    m?: string;
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
export declare function buildMintSharesTx(marketId: string, vaultId: string, quoteIn: string, amountAtoms: bigint, 
/**
 * R-WC-2: per-market phantom `M: address`. Threaded as the
 * second type argument to `mint_shares<Q, M>` so the call
 * matches the v2 package's generic signature.
 */
m?: string, 
/**
 * R-WC-3 v3: id of the `SharedTreasuryHolder<Q>` shared object
 * holding the YES/Q + NO/Q TreasuryCaps. Defaults to
 * `SHARED_TREASURY_HOLDER_ID` (resolved from env). Pass an
 * explicit id to mint against a specific holder (e.g. when
 * multiple packages are deployed with separate holders).
 */
sharedCapsId?: string): Transaction;
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
    /**
     * R-WC-2: per-market phantom `M: address`. Threaded as the
     * second type argument to every `mint_shares<Q, M>` call.
     */
    m?: string;
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
export declare function buildResolveMarketTx(marketId: string, outcome: 1 | 2, 
/**
 * R-WC-2: per-market phantom `M: address`. Threaded as the
 * second type argument to `resolve_market<Q, M>`.
 */
m?: string): Transaction;
/**
 * Build `redeem` (YES winning) transaction.
 *
 * @param marketId    - PredictionMarket object ID
 * @param vaultId     - FeeVault<DUSDC> object ID
 * @param winningCoin - Coin<YES<DUSDC>> to redeem
 */
export declare function buildRedeemTx(marketId: string, vaultId: string, winningCoin: string, 
/**
 * R-WC-2: per-market phantom `M: address`. Threaded as the
 * second type argument to `redeem<Q, M>`.
 */
m?: string, 
/**
 * R-WC-3 v3: id of the `SharedTreasuryHolder<Q>` shared
 * object. Defaults to `SHARED_TREASURY_HOLDER_ID` (env).
 */
sharedCapsId?: string): Transaction;
export declare function buildDisputeMarketTx(marketId: string, evidenceUri: string | Uint8Array, 
/**
 * R-WC-2: per-market phantom `M: address`. Threaded as the
 * second type argument to `dispute_market<Q, M>`.
 */
m?: string): Transaction;
/**
 * Build `resolve_dispute` transaction. Settles a previously-disputed
 * market. Only the creator may invoke.
 */
export declare function buildResolveDisputeTx(marketId: string, finalOutcome: 1 | 2, 
/**
 * R-WC-2: per-market phantom `M: address`. Threaded as the
 * second type argument to `resolve_dispute<Q, M>`.
 */
m?: string): Transaction;
/**
 * Build `redeem_no` (NO winning) transaction.
 *
 * @param marketId    - PredictionMarket object ID
 * @param vaultId     - FeeVault<DUSDC> object ID
 * @param winningCoin - Coin<NO<DUSDC>> to redeem
 */
export declare function buildRedeemNoTx(marketId: string, vaultId: string, winningCoin: string, 
/**
 * R-WC-2: per-market phantom `M: address`. Threaded as the
 * second type argument to `redeem_no<Q, M>`.
 */
m?: string, 
/**
 * R-WC-3 v3: id of the `SharedTreasuryHolder<Q>` shared
 * object. Defaults to `SHARED_TREASURY_HOLDER_ID` (env).
 */
sharedCapsId?: string): Transaction;
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
export declare function buildRedeemWithStreakTx(marketId: string, vaultId: string, winningCoinId: string, streakId: string, 
/**
 * R-WC-2: per-market phantom `M: address`. Threaded as the
 * second type argument to `redeem_with_streak<Q, M>`.
 */
m?: string, 
/**
 * R-WC-3 v3: id of the `SharedTreasuryHolder<Q>` shared
 * object. Defaults to `SHARED_TREASURY_HOLDER_ID` (env).
 */
sharedCapsId?: string): Transaction;
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
export declare function buildSetupReferralTx(marketId: string, poolId: string, multiplier?: bigint, 
/**
 * R-WC-2: per-market phantom `M: address`. Threaded as the
 * second type argument to `setup_referral<Q, M>`.
 */
m?: string): Transaction;
/**
 * Build `claim_referral_rewards` transaction.
 *
 * Move signs the reward coins to `ctx.sender()` — the caller is the
 * recipient. To route to a treasury, sign the tx with the treasury key.
 *
 * @param poolId     - DeepBook Pool object ID
 * @param referralId - DeepBookPoolReferral object ID
 */
export declare function buildClaimReferralRewardsTx(poolId: string, referralId: string, 
/**
 * R-WC-2: per-market phantom `M: address`. Threaded as the
 * second type argument to `claim_referral_rewards<Q, M>`.
 */
m?: string): Transaction;
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
export declare function buildInitFeeVaultFallbackTx(): Transaction;
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
 * R-WC-2: Derive a deterministic 32-byte Sui address from any
 * string seed. Used as the per-market phantom `M: address` type
 * argument so each market's `Currency<YES<Q, M>>` registration
 * is unique in the Sui CoinRegistry (without this, the second
 * market on the same package aborts with `ECurrencyAlreadyExists`).
 *
 * The seed can be anything unique-per-market: a WC match id
 * ("wc26-A1v3"), a market title, or an on-chain object id.
 * The derivation is a simple FNV-1a + xorshift spread — NOT
 * cryptographically secure, but collision-resistant enough for
 * generating unique type tags across hundreds of markets.
 *
 * This is dependency-free (no @noble/hashes needed) and works
 * in both Node and browser environments (TextEncoder is global).
 */
export declare function marketTypeSeed(seed: string): string;
/**
 * Normalize a Sui object id or address to the lowercase
 * `0x`-prefixed form that Sui expects in type argument strings.
 * Unlike the old version (which stripped `0x`), this KEEPS the
 * prefix — Sui's BCS type-argument serializer requires the full
 * `0x…` address when an `address` is used as a phantom type
 * parameter.
 */
export declare function addressOf(id: string): string;
/**
 * R-WC-2: append the per-market phantom `M: address` as the
 * second type argument to a Move call built by the SDK's
 * `buildXxxTx` builders. The builders hardcode
 * `typeArguments: [DUSDC_TYPE]`; this post-processor walks the
 * PTB's commands and appends `m` (a 0x-prefixed address) to the
 * first MoveCall's typeArguments, producing the
 * `YES<Q, M>` / `PredictionMarket<Q, M>` Move call signature.
 *
 * Why post-process: keeps the 22 builder signatures stable
 * (no breaking change to the public SDK API). The caller pipes
 * `buildXxxTx(...)` through `withMarketType(tx, m)` before
 * `executeTransaction`. The `m` value can be either an on-chain
 * object id or a `marketTypeSeed(seed)`-derived address.
 */
export declare function withMarketType(tx: Transaction, m: string): Transaction;
/**
 * R-WC-2: per-market phantom `M: address` appended to the
 * YES/NO/PredictionMarket type so each market's
 * `Currency<YES<Q, M>>` registration is unique per Sui CoinRegistry.
 * Pass the `m` address (a `marketTypeSeed` output or object id) to
 * get `YES<DUSDC, 0xM>`; omit it to get the legacy `<YES<DUSDC>>`
 * shape (callers like `findExistingYesPool` prefix-match on the
 * `YES<` portion, which is unaffected by M).
 */
export declare function yesCoinType(packageId?: string, m?: string): string;
export declare function noCoinType(packageId?: string, m?: string): string;
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
    /**
     * R-WC-2: per-market phantom `M: address`. Threaded as the
     * second type argument to `place_market_order<Q, M>`.
     */
    m?: string;
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
    /**
     * Optional market status pre-flight. If supplied, the
     * builder throws a clear error for non-`active` markets
     * rather than letting the PTB abort on-chain with the
     * opaque `EMarketNotActive` (code 1). The web markets/[id]
     * page already pre-flights the same condition in the
     * form-level `disabled` check, so this is a defense-in-depth
     * for SDK callers (agents, scripts, programmatic users).
     *
     * E2E-GAP-03 fix.
     */
    marketStatus?: string;
    /**
     * R-WC-2: per-market phantom `M: address`. Threaded as the
     * second type argument to `place_order<Q, M>`.
     */
    m?: string;
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
 * R-WC-1.6 fix: base-coin scale constant. The YES / NO
 * outcome tokens have 6 decimals (matching the
 * `create_market` default `lotSize = minSize = 1_000_000`
 * in `prediction_market.move:326`), so 1 share = 1_000_000
 * atoms. DeepBook's `validate_inputs` asserts
 * `quantity >= min_size`, so a caller passing
 * `BigInt(qty)` directly (where `qty` is the human
 * "share count", e.g. `1` for one share) would submit
 * 1 atom on-chain and abort with
 * `EOrderBelowMinimumSize` (abort code 1).
 *
 * Web callers (the markets/[id] page) should multiply
 * the share count by `BASE_SCALE` to convert to atom
 * count: `quantity: BigInt(qty) * BASE_SCALE`. The
 * default `1_000_000n` matches the 6-decimal YES coin
 * and the pool's `min_size` of `1_000_000n`.
 */
export declare const BASE_SCALE = 1000000n;
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
    /**
     * R-WC-2: per-market phantom `M: address`. Threaded as the
     * second type argument to `cancel_order<Q, M>`.
     */
    m?: string;
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
    /**
     * R-WC-2: per-market phantom `M: address`. Threaded as the
     * second type argument to `cancel_orders<Q, M>`.
     */
    m?: string;
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
/**
 * R-WC-1 fix: find an existing `Pool<YES<Q>, Q>` in the
 * DeepBook registry, if any. Used to bootstrap N markets
 * that all share one DeepBook pool (the design the
 * `world-cup-creator` now uses after the R-WC-1 refactor).
 *
 * Walks the registry's dynamic fields and returns the
 * first pool whose `BaseType` matches `<PKG>::prediction_market::YES<Q>`.
 *
 * @param client              - Sui client
 * @param deepbookRegistryId  - DeepBook `Registry` object id
 * @param marketPackageId     - The published prediction_market package
 *                              (defaults to the SDK's resolved PKG)
 * @param quoteType           - Quote coin Q (defaults to DUSDC_TYPE)
 * @returns Pool object id, or null if no YES<Q>/Q pool exists yet
 */
export declare function findExistingYesPool(client: SuiClient, deepbookRegistryId: string, marketPackageId?: string, quoteType?: string, fallbackPoolId?: string): Promise<string | null>;
/**
 * R-WC-1 fix: result of a successful market creation. The
 * `marketId` is the new on-chain `PredictionMarket<Q>`
 * object id; the `poolId` is the DeepBook pool the market
 * is bound to (created by `create_market` or reused from
 * the registry by `create_market_with_pool`); the
 * `balanceManagerId` is a fresh `BalanceManager` for this
 * market's trading.
 */
export interface CreatedMarket {
    marketId: string;
    poolId: string;
    balanceManagerId: string;
    /** "create_market" (new pool) or "create_market_with_pool"
     *  (reused pool). Operators can tell from the agent
     *  log which path was taken on each tick. */
    source: "create_market" | "create_market_with_pool";
}
/**
 * R-WC-1 fix: try `create_market` first, fall back to
 * `create_market_with_pool` on `EPoolAlreadyExists`. The
 * single entry point that the `world-cup-creator` (and
 * the operator's `bootstrap-wc-markets.mjs` script) use
 * to mint a per-market on-chain `PredictionMarket`. Replaces
 * the pre-fix "always `create_market`, catch the abort,
 * write a SQLite-only demo row" path that left 46 of 47
 * WC markets with no on-chain backing.
 *
 * **Why this exists (and not just a try/catch at the
 * call site):** the call site needs the *new* market id
 * and pool id regardless of which path was taken, and the
 * `create_market_with_pool` path requires a pool id at
 * PTB build time. Centralising the lookup + retry
 * keeps the agent code to a single `await` and
 * guarantees both paths are exercised in the same way
 * (idempotent, logged, with a single structured return
 * type for the agent's decision feed).
 *
 * **Wallet-funding gate:** the caller is responsible for
 * funding the wallet with enough SUI for gas + (on the
 * first market) 500 DEEP for the pool-creation fee. This
 * helper does NOT check the wallet balance — the agents
 * gate this themselves before calling, with a clear
 * operator-visible error if underfunded (see
 * `world-cup-creator.ts`).
 *
 * @param client            - Sui client
 * @param signer            - Agent keypair
 * @param deepbookRegistry  - DeepBook registry id (or null
 *                            if no registry configured)
 * @param params            - Market creation params
 * @param params.title            - Market question
 * @param params.resolutionSource - How the market resolves
 * @param params.expiryMs         - Unix ms when resolution allowed
 * @param params.category         - 0..3 topic code
 * @param params.deepCoinId       - Coin<DEEP> for the pool-creation
 *                                  fee (only consumed on the
 *                                  first market; subsequent
 *                                  markets don't touch it)
 * @param params.coinRegistry     - Sui system CoinRegistry id
 *                                  (defaults to "0xc")
 * @param params.tickSize         - Pool tick size (only on
 *                                  create_market path)
 * @param params.lotSize          - Pool lot size (only on
 *                                  create_market path)
 * @param params.minSize          - Pool min size (only on
 *                                  create_market path)
 */
export declare function ensureMarketCreated(client: SuiClient, signer: Ed25519Keypair, deepbookRegistry: string | null, params: {
    title: string;
    resolutionSource: string;
    expiryMs: bigint;
    category?: number;
    deepCoinId: string;
    coinRegistry?: string;
    tickSize?: bigint;
    lotSize?: bigint;
    minSize?: bigint;
    /**
     * R-WC-2: per-market phantom type `M` (a 32-byte address from
     * `marketTypeSeed`). Threaded via `withMarketType` so the PTB's
     * MoveCall targets `create_market<Q, M>` / `create_market_with_pool<Q, M>`.
     * Omit for legacy single-phantom calls (the CoinRegistry limit applies).
     */
    m?: string;
}): Promise<CreatedMarket>;
//# sourceMappingURL=prediction-market-client.d.ts.map