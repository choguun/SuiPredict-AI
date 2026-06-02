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
import {
  AGENT_POLICY_PACKAGE_ID,
  CLOCK_OBJECT_ID,
  DUSDC_TYPE,
} from "./constants.js";
import { encodeUtf8 } from "./markets/constants.js";
import {
  DEEP_TYPE,
  DEEPBOOK_REGISTRY_ID,
  POOL_CREATION_FEE_DEEP,
} from "./deepbook/constants.js";
import {
  createDeepBookClient,
  buildDeepBookCreateBalanceManagerTx,
  buildDeepBookDepositTx,
  buildDeepBookPlaceLimitOrderTx,
  buildDeepBookWithdrawSettledTx,
  createPredictionDeepBookClient,
  getOrderBookDepth,
  getMidPrice,
  type DeepBookClient,
  type PredictionDeepBookMarketConfig,
  PREDICT_DEEPBOOK_POOL_KEY,
} from "./deepbook/client.js";
import { extractCreatedObjectId } from "./predict-client.js";
import type { SuiClient } from "./predict-client.js";
import type { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";

// ─── Constants ────────────────────────────────────────────────────────────────

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
export const PREDICT_MARKET_PACKAGE_ID = AGENT_POLICY_PACKAGE_ID;

const PKG = () => PREDICT_MARKET_PACKAGE_ID;

/** FeeVault<DUSDC> object ID — set after contract deployment. The
 *  NEXT_PUBLIC_ variant is read first so Next.js inlines it into the
 *  client bundle; the bare `FEE_VAULT_ID` is the server/agents variant.
 */
export const FEE_VAULT_ID =
  process.env.NEXT_PUBLIC_FEE_VAULT_ID ??
  process.env.FEE_VAULT_ID ??
  "0x0000000000000000000000000000000000000000000000000000000000000000";

/** Protocol treasury address for withdrawing accumulated fees and claiming referral rewards */
export const REFERRAL_TREASURY_ADDRESS =
  process.env.NEXT_PUBLIC_REFERRAL_TREASURY_ADDRESS ??
  process.env.REFERRAL_TREASURY_ADDRESS ??
  process.env.PROTOCOL_TREASURY_ADDRESS ??
  "0x0000000000000000000000000000000000000000000000000000000000000000";

// ─── Transaction builders ─────────────────────────────────────────────────────

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
export function buildCreateMarketTx(params: {
  title: string;
  resolutionSource: string;
  expiryMs: bigint;
  tickSize?: bigint;
  lotSize?: bigint;
  minSize?: bigint;
  deepCoinId: string;
  category?: number;
}): Transaction {
  if (!params.deepCoinId) throw new Error("deepCoinId is required for pool creation");
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG()}::prediction_market::create_market`,
    typeArguments: [DUSDC_TYPE],
    arguments: [
      tx.object(DEEPBOOK_REGISTRY_ID),
      tx.pure.vector("u8", encodeUtf8(params.title)),
      tx.pure.vector("u8", encodeUtf8(params.resolutionSource)),
      tx.pure.u64(params.expiryMs),
      tx.pure.u64(params.tickSize ?? 1_000_000n),       // 0.001 DUSDC tick
      tx.pure.u64(params.lotSize ?? 1_000_000n),        // 1 YES minimum
      tx.pure.u64(params.minSize ?? 1_000_000n),        // 1 YES minimum
      tx.object(params.deepCoinId),
      tx.pure.u8(params.category ?? 0),
    ],
  });
  return tx;
}

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
export function buildMintSharesTx(
  marketId: string,
  vaultId: string,
  quoteIn: string,
  amountAtoms: bigint,
): Transaction {
  // Minimum per-leg amount: 1 YES share at the protocol's default
  // scalar (1e6 = 1 share with 6 decimals). Markets created via
  // `buildCreateMarketTx` use `tickSize: 1_000_000`, `lotSize: 1_000_000`,
  // and `minSize: 1_000_000` — the on-chain `mint_shares` will reject
  // any input below this. Validating here so a fractional-amount
  // typo surfaces as a build-time error with a clear message rather
  // than a Move abort at execute time. Mirrors the validation in
  // `buildMintSharesBatchTx`.
  const MIN_ATOMS = 1_000_000n;
  if (amountAtoms <= 0n) {
    throw new Error(
      `buildMintSharesTx: amountAtoms must be > 0 (got ${amountAtoms})`,
    );
  }
  if (amountAtoms < MIN_ATOMS) {
    throw new Error(
      `buildMintSharesTx: amountAtoms ${amountAtoms} is below the protocol minimum of ${MIN_ATOMS} (1 YES share). ` +
        `Most markets use tickSize=lotSize=1_000_000.`,
    );
  }
  const tx = new Transaction();
  // Split `amountAtoms` off the user's DUSDC coin in-PTB and pass the
  // split result to `mint_shares`. A previous version of this builder
  // passed the whole `Coin<DUSDC>` to `mint_shares` without splitting,
  // which deposited the user's entire balance. The batch variant
  // (`buildMintSharesBatchTx`) already splits correctly; this single-
  // market variant now matches.
  const [mintCoin] = tx.splitCoins(tx.object(quoteIn), [tx.pure.u64(amountAtoms)]);
  tx.moveCall({
    target: `${PKG()}::prediction_market::mint_shares`,
    typeArguments: [DUSDC_TYPE],
    arguments: [tx.object(marketId), tx.object(vaultId), mintCoin],
  });
  return tx;
}

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
export function buildMintSharesBatchTx(params: {
  marketIds: string[];
  vaultId: string;
  quoteIn: string;
  amountPerMarket: bigint;
}): Transaction {
  const tx = new Transaction();
  // Minimum per-leg amount: 1 YES share at the protocol's default
  // scalar (1e6 = 1 share with 6 decimals). Markets created via
  // `buildCreateMarketTx` use `tickSize: 1_000_000`, `lotSize: 1_000_000`,
  // and `minSize: 1_000_000` — the on-chain `mint_shares` will reject
  // any input below this. We validate here so a fractional-amount
  // typo surfaces as a build-time error with a clear message rather
  // than a Move abort at execute time.
  const MIN_ATOMS = 1_000_000n;
  if (params.amountPerMarket <= 0n) {
    throw new Error(
      `buildMintSharesBatchTx: amountPerMarket must be > 0 (got ${params.amountPerMarket})`,
    );
  }
  if (params.amountPerMarket < MIN_ATOMS) {
    throw new Error(
      `buildMintSharesBatchTx: amountPerMarket ${params.amountPerMarket} ` +
        `is below the protocol minimum of ${MIN_ATOMS} (1 YES share). ` +
        `Most markets use tickSize=lotSize=1_000_000.`,
    );
  }
  if (params.marketIds.length === 0) return tx;
  // splitCoins(coin, [a1, a2, ..., aN]) returns exactly N result
  // references. For N=1 the rest spread is `[]` (still correct) and
  // for N>1 it captures coins 2..N. The destructured shape below
  // covers both the single-market and multi-market cases without an
  // off-by-one — the forEach below iterates `marketIds.length` times
  // and indexes into the same-length `coins` array.
  const amounts = params.marketIds.map(() => tx.pure.u64(params.amountPerMarket));
  const [primaryCoin, ...splitCoins] = tx.splitCoins(
    tx.object(params.quoteIn),
    amounts,
  );
  const coins = [primaryCoin, ...splitCoins];
  if (coins.length !== params.marketIds.length) {
    throw new Error(
      `buildMintSharesBatchTx: splitCoins produced ${coins.length} coins for ${params.marketIds.length} markets`,
    );
  }
  params.marketIds.forEach((marketId, i) => {
    tx.moveCall({
      target: `${PKG()}::prediction_market::mint_shares`,
      typeArguments: [DUSDC_TYPE],
      arguments: [tx.object(marketId), tx.object(params.vaultId), coins[i]!],
    });
  });
  return tx;
}

/**
 * Build `resolve_market` transaction.
 *
 * @param marketId - PredictionMarket object ID
 * @param outcome  - 1 = YES won, 2 = NO won
 */
export function buildResolveMarketTx(
  marketId: string,
  outcome: 1 | 2,
): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG()}::prediction_market::resolve_market`,
    typeArguments: [DUSDC_TYPE],
    arguments: [
      tx.object(marketId),
      tx.pure.u8(outcome),
      tx.object(CLOCK_OBJECT_ID),
    ],
  });
  return tx;
}

/**
 * Build `redeem` (YES winning) transaction.
 *
 * @param marketId    - PredictionMarket object ID
 * @param vaultId     - FeeVault<DUSDC> object ID
 * @param winningCoin - Coin<YES<DUSDC>> to redeem
 */
export function buildRedeemTx(
  marketId: string,
  vaultId: string,
  winningCoin: string,
): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG()}::prediction_market::redeem`,
    typeArguments: [DUSDC_TYPE],
    arguments: [tx.object(marketId), tx.object(vaultId), tx.object(winningCoin)],
  });
  return tx;
}

/**
 * Build `dispute_market` transaction. Files a dispute against a resolved
 * market. Anyone can call within the on-chain 1-hour window after
 * `resolve_market`. The market is frozen (redeem aborts) until
 * `resolve_dispute` is invoked by the creator.
 *
 * @param marketId     - PredictionMarket object ID
 * @param evidenceUri  - String or bytes containing the dispute evidence
 *                       (URL, IPFS hash, or JSON blob). Must be non-empty.
 */
export function buildDisputeMarketTx(
  marketId: string,
  evidenceUri: string | Uint8Array,
): Transaction {
  const evidence =
    typeof evidenceUri === "string" ? encodeUtf8(evidenceUri) : evidenceUri;
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG()}::prediction_market::dispute_market`,
    typeArguments: [DUSDC_TYPE],
    arguments: [
      tx.object(marketId),
      tx.pure.vector("u8", Array.from(evidence)),
      tx.object(CLOCK_OBJECT_ID),
    ],
  });
  return tx;
}

/**
 * Build `resolve_dispute` transaction. Settles a previously-disputed
 * market. Only the creator may invoke.
 */
export function buildResolveDisputeTx(
  marketId: string,
  finalOutcome: 1 | 2,
): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG()}::prediction_market::resolve_dispute`,
    typeArguments: [DUSDC_TYPE],
    arguments: [tx.object(marketId), tx.pure.u8(finalOutcome)],
  });
  return tx;
}

/**
 * Build `redeem_no` (NO winning) transaction.
 *
 * @param marketId    - PredictionMarket object ID
 * @param vaultId     - FeeVault<DUSDC> object ID
 * @param winningCoin - Coin<NO<DUSDC>> to redeem
 */
export function buildRedeemNoTx(
  marketId: string,
  vaultId: string,
  winningCoin: string,
): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG()}::prediction_market::redeem_no`,
    typeArguments: [DUSDC_TYPE],
    arguments: [tx.object(marketId), tx.object(vaultId), tx.object(winningCoin)],
  });
  return tx;
}

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
export function buildRedeemWithStreakTx(
  marketId: string,
  vaultId: string,
  winningCoinId: string,
  streakId: string,
): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG()}::prediction_market::redeem_with_streak`,
    typeArguments: [DUSDC_TYPE],
    arguments: [
      tx.object(marketId),
      tx.object(vaultId),
      tx.object(winningCoinId),
      tx.object(streakId),
    ],
  });
  return tx;
}

/** Build `redeem_no_with_streak` transaction. See `buildRedeemWithStreakTx`. */
export function buildRedeemNoWithStreakTx(
  marketId: string,
  vaultId: string,
  winningCoinId: string,
  streakId: string,
): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG()}::prediction_market::redeem_no_with_streak`,
    typeArguments: [DUSDC_TYPE],
    arguments: [
      tx.object(marketId),
      tx.object(vaultId),
      tx.object(winningCoinId),
      tx.object(streakId),
    ],
  });
  return tx;
}

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
export function buildSetupReferralTx(
  marketId: string,
  poolId: string,
  multiplier: bigint = 1_000_000_000n,
): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG()}::prediction_market::setup_referral`,
    typeArguments: [DUSDC_TYPE],
    arguments: [
      tx.object(marketId),
      tx.object(poolId),
      tx.pure.u64(multiplier),
    ],
  });
  return tx;
}

/**
 * Build `claim_referral_rewards` transaction.
 *
 * Move signs the reward coins to `ctx.sender()` — the caller is the
 * recipient. To route to a treasury, sign the tx with the treasury key.
 *
 * @param poolId     - DeepBook Pool object ID
 * @param referralId - DeepBookPoolReferral object ID
 */
export function buildClaimReferralRewardsTx(
  poolId: string,
  referralId: string,
): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG()}::prediction_market::claim_referral_rewards`,
    typeArguments: [DUSDC_TYPE],
    arguments: [tx.object(poolId), tx.object(referralId)],
  });
  return tx;
}

/**
 * Build `withdraw_fees` transaction.
 *
 * @param vaultId - FeeVault<DUSDC> object ID
 * @param amount  - Amount of DUSDC to withdraw
 */
export function buildWithdrawFeesTx(
  vaultId: string,
  amount: bigint,
): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG()}::prediction_market::withdraw_fees`,
    typeArguments: [DUSDC_TYPE],
    arguments: [tx.object(vaultId), tx.pure.u64(amount)],
  });
  return tx;
}

/**
 * Build `init_fee_vault` transaction. Called once per quote-coin type
 * by the holder of the `ProtocolAdminCap`. The shared vault object is
 * returned; its `objectId` must be stored in `FEE_VAULT_ID` for later
 * mint/redeem/withdraw-fees calls.
 *
 * @param adminCapId   - ProtocolAdminCap object ID
 * @param vaultAdmin   - Address that will own withdrawals from the vault
 */
export function buildInitFeeVaultTx(
  adminCapId: string,
  vaultAdmin: string,
): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG()}::prediction_market::init_fee_vault`,
    typeArguments: [DUSDC_TYPE],
    arguments: [tx.object(adminCapId), tx.pure.address(vaultAdmin)],
  });
  return tx;
}

// ─── Order book helpers ───────────────────────────────────────────────────────

/**
 * Get the on-chain DeepBook order book depth for a prediction market pool.
 *
 * @param dbClient - DeepBookClient instance
 * @param poolId   - DeepBook Pool ID (from MarketInfo.deepbook_pool_id)
 * @param lowPrice  - Minimum price to query (default 0.01)
 * @param highPrice - Maximum price to query (default 0.99)
 */
export async function getMarketOrderBook(
  dbClient: DeepBookClient,
  poolId: string,
  lowPrice = 0.01,
  highPrice = 0.99,
) {
  return getOrderBookDepth(dbClient, poolId, lowPrice, highPrice);
}

/**
 * Get mid price from DeepBook pool.
 */
export async function getMarketMidPrice(
  dbClient: DeepBookClient,
  poolId: string,
) {
  return getMidPrice(dbClient, poolId);
}

// ─── Balance manager setup ───────────────────────────────────────────────────

/**
 * Build transaction to create and share a BalanceManager for the protocol.
 * The BalanceManager holds DEEP for pool creation fees and trading.
 */
export function buildCreateBalanceManagerTx(owner?: string): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: "0xdee9::balance_manager::create_balance_manager",
    arguments: owner ? [tx.pure.address(owner)] : [],
  });
  return tx;
}

/**
 * Build transaction to deposit funds into the protocol's BalanceManager.
 *
 * @param coinKey - 'DEEP' or 'DBUSDC'
 * @param amount  - Amount to deposit
 * @param managerId - BalanceManager object ID (from DEEPBOOK_REGISTRY_ID lookup)
 */
export function buildDepositIntoBalanceManagerTx(
  managerId: string,
  coinKey: "DEEP" | "DBUSDC",
  amount: number,
): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: "0xdee9::balance_manager::deposit_into_manager",
    arguments: [
      tx.object(managerId),
      tx.pure.string(coinKey),
      tx.pure.u64(amount),
    ],
  });
  return tx;
}

// ─── Coin type helpers ───────────────────────────────────────────────────────

/**
 * Compute the YES coin type for a given market's PredictionMarket object.
 * YES<Q> = <package>::prediction_market::YES<DUSDC>
 *
 * In Move, the generic type parameter is part of the type identity.
 * For a market at object ID M, the YES type is: <package>::prediction_market::YES<DUSDC>
 */
export function yesCoinType(
  packageId: string = PKG(),
): string {
  return `${packageId}::prediction_market::YES<${DUSDC_TYPE}>`;
}

export function noCoinType(
  packageId: string = PKG(),
): string {
  return `${packageId}::prediction_market::NO<${DUSDC_TYPE}>`;
}

/**
 * Place a limit order on the DeepBook pool for YES/DUSDC.
 * Convenience wrapper around buildDeepBookPlaceLimitOrderTx.
 */
export function buildPlaceYesLimitOrderTx(
  dbClient: DeepBookClient,
  poolKey: string,
  params: {
    price: number;
    quantity: number;
    isBid: boolean;
    clientOrderId?: string;
    expiration?: number;
  },
): Transaction {
  return buildDeepBookPlaceLimitOrderTx(dbClient, {
    poolKey,
    price: params.price,
    quantity: params.quantity,
    isBid: params.isBid,
    clientOrderId: params.clientOrderId ?? "",
    expiration: params.expiration,
  });
}

/**
 * Withdraw settled amounts from the DeepBook pool.
 */
export function buildWithdrawSettledTx(
  dbClient: DeepBookClient,
  poolKey: string,
): Transaction {
  return buildDeepBookWithdrawSettledTx(dbClient, poolKey);
}

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
export function buildMarketWithdrawSettledTx(
  marketId: string,
  poolId: string,
  balanceManagerId: string,
): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG()}::prediction_market::withdraw_settled`,
    typeArguments: [DUSDC_TYPE],
    arguments: [
      tx.object(marketId),
      tx.object(poolId),
      tx.object(balanceManagerId),
    ],
  });
  return tx;
}

// ─── Market-order / cancel / deposit wrappers ───────────────────────────────
//
// The on-chain entry points below all require both the `PredictionMarket<Q>`
// shared object AND the underlying DeepBook `Pool<YES<Q>, Q>` plus the
// user's `BalanceManager`. The market object carries `pool_id` and
// `balance_manager_id` after `create_market`, so the caller can pass them
// in directly. They are intentionally separate parameters (not folded
// into a client) because these wrappers sit on the prediction-market
// side of the boundary, not the DeepBook-client side; the market object
// is required for `EMarketNotActive` and the dispute-window checks.

// ─── Market-order entry ─────────────────────────────────────────────────────

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
export function buildPlaceMarketOrderTx(params: {
  marketId: string;
  poolId: string;
  balanceManagerId: string;
  clientOrderId: bigint;
  quantity: bigint;
  isBid: boolean;
}): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG()}::prediction_market::place_market_order`,
    typeArguments: [DUSDC_TYPE],
    arguments: [
      tx.object(params.marketId),
      tx.object(params.poolId),
      tx.object(params.balanceManagerId),
      tx.pure.u64(params.clientOrderId),
      tx.pure.u64(params.quantity),
      tx.pure.bool(params.isBid),
      tx.object(CLOCK_OBJECT_ID),
    ],
  });
  return tx;
}

// ─── Cancel wrappers ────────────────────────────────────────────────────────

/**
 * Build `cancel_order` transaction. Cancels a single open order by its
 * DeepBook-assigned `order_id`. Aborts with `EMarketNotActive` if the
 * market is resolved.
 */
export function buildCancelOrderTx(params: {
  marketId: string;
  poolId: string;
  balanceManagerId: string;
  orderId: bigint;
}): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG()}::prediction_market::cancel_order`,
    typeArguments: [DUSDC_TYPE],
    arguments: [
      tx.object(params.marketId),
      tx.object(params.poolId),
      tx.object(params.balanceManagerId),
      tx.pure.u128(params.orderId),
      tx.object(CLOCK_OBJECT_ID),
    ],
  });
  return tx;
}

/**
 * Build `cancel_orders` transaction. Batch-cancels a set of open orders.
 * Each `orderId` is a u128 as DeepBook assigns them. The on-chain
 * `cancel_live_orders` is the underlying call; the event is
 * `OrdersBatchCancelledEvent` (one per tx, not one per order).
 */
export function buildCancelOrdersTx(params: {
  marketId: string;
  poolId: string;
  balanceManagerId: string;
  orderIds: bigint[];
}): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG()}::prediction_market::cancel_orders`,
    typeArguments: [DUSDC_TYPE],
    arguments: [
      tx.object(params.marketId),
      tx.object(params.poolId),
      tx.object(params.balanceManagerId),
      tx.pure.vector("u128", params.orderIds),
      tx.object(CLOCK_OBJECT_ID),
    ],
  });
  return tx;
}

/**
 * Build `cancel_all_orders` transaction. Cancels every open order for
 * this `BalanceManager` on the market's DeepBook pool. The on-chain
 * function does not emit a batch event; the position-indexer observes
 * the per-order `OrderCancelledEvent` (zero or more) that follow.
 */
export function buildCancelAllOrdersTx(params: {
  marketId: string;
  poolId: string;
  balanceManagerId: string;
}): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG()}::prediction_market::cancel_all_orders`,
    typeArguments: [DUSDC_TYPE],
    arguments: [
      tx.object(params.marketId),
      tx.object(params.poolId),
      tx.object(params.balanceManagerId),
      tx.object(CLOCK_OBJECT_ID),
    ],
  });
  return tx;
}

// ─── BalanceManager top-up ──────────────────────────────────────────────────

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
export function buildDepositForTradingTx(params: {
  marketId: string;
  balanceManagerId: string;
  baseCoinId: string;
  quoteCoinId: string;
  deepCoinId: string;
}): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG()}::prediction_market::deposit_for_trading`,
    typeArguments: [DUSDC_TYPE],
    arguments: [
      tx.object(params.marketId),
      tx.object(params.balanceManagerId),
      tx.object(params.baseCoinId),
      tx.object(params.quoteCoinId),
      tx.object(params.deepCoinId),
    ],
  });
  return tx;
}

// ─── DeepBook client factory ─────────────────────────────────────────────────

/**
 * Create a DeepBook client configured for a specific prediction market pool.
 *
 * @param client      - SuiClient
 * @param address     - User's Sui address
 * @param poolId      - DeepBook Pool ID (from MarketInfo.deepbook_pool_id)
 * @param poolKey     - Pool key string (e.g. "market_abc12345" or PREDICT_DEEPBOOK_POOL_KEY)
 * @param balanceManagerId - Optional BalanceManager ID for trading
 */
export function createMarketDeepBookClient(
  client: SuiClient,
  address: string,
  poolId: string,
  poolKey: string = PREDICT_DEEPBOOK_POOL_KEY,
  balanceManagerId?: string,
) {
  const marketConfig: PredictionDeepBookMarketConfig = {
    poolKey,
    poolId,
    baseCoinType: yesCoinType(),
    quoteCoinType: DUSDC_TYPE,
    baseScalar: 1_000_000,
    quoteScalar: 1_000_000,
  };

  return createPredictionDeepBookClient({
    client,
    address,
    balanceManagerId: balanceManagerId ?? null,
    market: marketConfig,
  });
}

// ─── Vault builders ───────────────────────────────────────────────────────────

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
export function buildVaultDepositTx(
  vaultId: string,
  coinId: string,
  quoteType: string = DUSDC_TYPE,
  recipient?: string,
): Transaction {
  const tx = new Transaction();
  const vlp = tx.moveCall({
    target: `${PKG()}::vault::deposit`,
    typeArguments: [quoteType],
    arguments: [tx.object(vaultId), tx.object(coinId)],
  });
  tx.transferObjects([vlp], tx.pure.address(recipient ?? "@{sender}"));
  return tx;
}

/**
 * Build `vault::withdraw` transaction. Burns a `Coin<VLP>` and returns
 * `Coin<QuoteCoin>` to the caller. Withdraw is bounded by
 * `available_balance` (i.e. excludes the `allocated` reserve).
 */
export function buildVaultWithdrawTx(
  vaultId: string,
  vlpCoinId: string,
  quoteType: string = DUSDC_TYPE,
): Transaction {
  const tx = new Transaction();
  const out = tx.moveCall({
    target: `${PKG()}::vault::withdraw`,
    typeArguments: [quoteType],
    arguments: [tx.object(vaultId), tx.object(vlpCoinId)],
  });
  tx.transferObjects([out], tx.pure.address("@{sender}"));
  return tx;
}

// ─── Registry builders ────────────────────────────────────────────────────────

/**
 * Build `registry::create_registry` transaction. Anyone can call;
 * `ctx.sender()` becomes the registry admin.
 */
export function buildCreateRegistryTx(): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG()}::registry::create_registry`,
    arguments: [],
  });
  return tx;
}

/**
 * Build `registry::register_market` transaction. Only the registry
 * admin may invoke. Typically called by the market creator after
 * each successful `create_market`.
 */
export function buildRegisterMarketTx(
  registryId: string,
  marketObjectId: string,
): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG()}::registry::register_market`,
    arguments: [tx.object(registryId), tx.pure.id(marketObjectId)],
  });
  return tx;
}