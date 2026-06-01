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
  CLOCK_OBJECT_ID,
} from "./constants.js";
import { encodeUtf8 } from "./markets/constants.js";
import {
  DBUSDC_TYPE,
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

/** PredictionMarket package ID — override via PREDICT_MARKET_PACKAGE_ID env */
export const PREDICT_MARKET_PACKAGE_ID =
  process.env.PREDICT_MARKET_PACKAGE_ID ??
  process.env.MARKET_PACKAGE_ID ??
  "0x7377808da2e3d48282268c56e332ac282adca02db3a4d924505fa139067ff4e8";

const PKG = () => PREDICT_MARKET_PACKAGE_ID;

/** FeeVault<DBUSDC> object ID — set after contract deployment */
export const FEE_VAULT_ID =
  process.env.FEE_VAULT_ID ??
  "0x0000000000000000000000000000000000000000000000000000000000000000";

/** Protocol treasury address for withdrawing accumulated fees and claiming referral rewards */
export const REFERRAL_TREASURY_ADDRESS =
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
 * @param params.tickSize        - Price tick in quote units (e.g. 1_000_000 = 0.001 DBUSDC with 6 decimals)
 * @param params.lotSize         - Minimum base-asset quantity per order (in YES * 10^decimals)
 * @param params.minSize         - Minimum order size in base units
 * @param params.deepCoinId      - Object ID of a Coin<DEEP> with at least 500 DEEP for pool creation fee (REQUIRED)
 */
export function buildCreateMarketTx(params: {
  title: string;
  resolutionSource: string;
  expiryMs: bigint;
  tickSize?: bigint;
  lotSize?: bigint;
  minSize?: bigint;
  deepCoinId: string;
}): Transaction {
  if (!params.deepCoinId) throw new Error("deepCoinId is required for pool creation");
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG()}::prediction_market::create_market`,
    typeArguments: [DBUSDC_TYPE],
    arguments: [
      tx.object(DEEPBOOK_REGISTRY_ID),
      tx.pure.vector("u8", encodeUtf8(params.title)),
      tx.pure.vector("u8", encodeUtf8(params.resolutionSource)),
      tx.pure.u64(params.expiryMs),
      tx.pure.u64(params.tickSize ?? 1_000_000n),       // 0.001 DBUSDC tick
      tx.pure.u64(params.lotSize ?? 1_000_000n),        // 1 YES minimum
      tx.pure.u64(params.minSize ?? 1_000_000n),        // 1 YES minimum
      tx.object(params.deepCoinId),
    ],
  });
  return tx;
}

/**
 * Build `mint_shares` transaction.
 *
 * Deposits collateral (DBUSDC) and receives equal YES + NO tokens.
 * Takes a 1% protocol fee.
 *
 * @param marketId - PredictionMarket object ID
 * @param quoteIn  - Coin<DBUSDC> to deposit
 */
export function buildMintSharesTx(
  marketId: string,
  quoteIn: string,
): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG()}::prediction_market::mint_shares`,
    typeArguments: [DBUSDC_TYPE],
    arguments: [tx.object(marketId), tx.object(quoteIn)],
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
    typeArguments: [DBUSDC_TYPE],
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
 * @param winningCoin - Coin<YES<DBUSDC>> to redeem
 */
export function buildRedeemTx(
  marketId: string,
  winningCoin: string,
): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG()}::prediction_market::redeem`,
    typeArguments: [DBUSDC_TYPE],
    arguments: [tx.object(marketId), tx.object(winningCoin)],
  });
  return tx;
}

/**
 * Build `dispute_market` transaction. Files a dispute against a resolved
 * market. Anyone can call within the off-chain 1-hour window. The market
 * is frozen (redeem aborts) until `resolve_dispute` is invoked by the
 * creator.
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
    typeArguments: [DBUSDC_TYPE],
    arguments: [tx.object(marketId), tx.pure.vector("u8", Array.from(evidence))],
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
    typeArguments: [DBUSDC_TYPE],
    arguments: [tx.object(marketId), tx.pure.u8(finalOutcome)],
  });
  return tx;
}

/**
 * Build `redeem_no` (NO winning) transaction.
 *
 * @param marketId    - PredictionMarket object ID
 * @param winningCoin - Coin<NO<DBUSDC>> to redeem
 */
export function buildRedeemNoTx(
  marketId: string,
  winningCoin: string,
): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG()}::prediction_market::redeem_no`,
    typeArguments: [DBUSDC_TYPE],
    arguments: [tx.object(marketId), tx.object(winningCoin)],
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
 * @param poolId    - DeepBook Pool object ID (Pool<YES<DBUSDC>, DBUSDC>)
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
    typeArguments: [DBUSDC_TYPE],
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
 * @param poolId     - DeepBook Pool object ID
 * @param referralId - DeepBookPoolReferral object ID
 * @param treasury   - Address to receive the accumulated referral rewards (DEEP + DBUSDC)
 */
export function buildClaimReferralRewardsTx(
  poolId: string,
  referralId: string,
  treasury: string,
): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG()}::prediction_market::claim_referral_rewards`,
    typeArguments: [DBUSDC_TYPE],
    arguments: [tx.object(poolId), tx.object(referralId), tx.pure.address(treasury)],
  });
  return tx;
}

/**
 * Build `withdraw_fees` transaction.
 *
 * @param vaultId - FeeVault<DBUSDC> object ID
 * @param amount  - Amount of DBUSDC to withdraw
 */
export function buildWithdrawFeesTx(
  vaultId: string,
  amount: bigint,
): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG()}::prediction_market::withdraw_fees`,
    typeArguments: [DBUSDC_TYPE],
    arguments: [tx.object(vaultId), tx.pure.u64(amount)],
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
 * YES<Q> = <package>::prediction_market::YES<DBUSDC>
 *
 * In Move, the generic type parameter is part of the type identity.
 * For a market at object ID M, the YES type is: <package>::prediction_market::YES<DBUSDC>
 */
export function yesCoinType(
  packageId: string = PKG(),
): string {
  return `${packageId}::prediction_market::YES<${DBUSDC_TYPE}>`;
}

export function noCoinType(
  packageId: string = PKG(),
): string {
  return `${packageId}::prediction_market::NO<${DBUSDC_TYPE}>`;
}

/**
 * Place a limit order on the DeepBook pool for YES/DBUSDC.
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
    quoteCoinType: DBUSDC_TYPE,
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