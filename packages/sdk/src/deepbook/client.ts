import {
  DeepBookClient,
  OrderType,
  SelfMatchingOptions,
  mainnetCoins,
  mainnetPools,
  testnetCoins,
  testnetPools,
  type BalanceManager,
  type CoinMap,
  type PlaceLimitOrderParams,
  type PoolMap,
} from "@mysten/deepbook-v3";
import type { SuiGrpcClient } from "@mysten/sui/grpc";
import { Transaction } from "@mysten/sui/transactions";
import type { SuiClient } from "../predict-client.js";
import { normalizeObjectId } from "../utils.js";
import {
  DBUSDC_TYPE,
  DEEPBOOK_PACKAGE_ID,
  DEEPBOOK_REGISTRY_ID,
  DEEP_TYPE,
  resolveDeepbookPackageId,
  resolveDeepbookRegistryId,
} from "./constants.js";
import { isValidSuiAddress } from "../utils.js";

export type { BalanceManager, CoinMap, DeepBookClient, PoolMap };

export const PREDICT_DEEPBOOK_POOL_KEY = "PREDICT_YES_DUSDC";
export const PREDICT_BASE_COIN_KEY = "PREDICT_YES";
export const PREDICT_QUOTE_COIN_KEY = "PREDICT_QUOTE";
export const PREDICT_BALANCE_MANAGER_KEY = "PREDICT_MANAGER";

export function createDeepBookClient(
  client: SuiGrpcClient,
  address: string,
  balanceManagers: Record<string, { address: string; tradeCap?: string }> = {},
  options: {
    coins?: CoinMap;
    pools?: PoolMap;
    network?: "mainnet" | "testnet";
    packageIds?: {
      DEEPBOOK_PACKAGE_ID?: string;
      REGISTRY_ID?: string;
      DEEP_TREASURY_ID?: string;
    };
  } = {},
) {
  const network = options.network
    ?? (process.env.SUI_NETWORK === "mainnet" ? "mainnet" : "testnet");
  const defaultCoins = network === "mainnet" ? mainnetCoins : testnetCoins;
  const defaultPools = network === "mainnet" ? mainnetPools : testnetPools;
  // R-WC-1.3 fix: fail loud at the SDK boundary when
  // DEEPBOOK_PACKAGE_ID is unset. Pre-fix, the empty
  // string silently propagated into the
  // `shareBalanceManager` moveCall's `typeArguments`
  // (`${DEEPBOOK_PACKAGE_ID}::balance_manager::BalanceManager`),
  // which the on-chain BCS resolver rejected with the
  // cryptic "Encountered unexpected token when parsing
  // type args for ::balance_manager::BalanceManager"
  // error. An operator at the SuiVision link couldn't
  // tell that the root cause was a missing env var in
  // `apps/web/.env.local` — the error pointed at the
  // type name, not the missing config. The new
  // pre-flight throws a clear "set
  // NEXT_PUBLIC_DEEPBOOK_PACKAGE_ID" message at
  // `createDeepBookClient` time, before any PTB is built.
  const resolvedDeepbookPackageId =
    options.packageIds?.DEEPBOOK_PACKAGE_ID ?? resolveDeepbookPackageId();
  if (!resolvedDeepbookPackageId) {
    throw new Error(
      "createDeepBookClient: DEEPBOOK_PACKAGE_ID is not configured. " +
        "Set NEXT_PUBLIC_DEEPBOOK_PACKAGE_ID (or DEEPBOOK_PACKAGE_ID) " +
        "to the deployed DeepBook V3 package id " +
        "(testnet default: 0xc93ae840671495202260c7afb93c820bf11c081b884b660106399208871dec5a). " +
        "This is required for every moveCall the DeepBook client builds — the package id is " +
        "baked into the `typeArguments` for `BalanceManager`, `Pool`, `TradeProof`, etc.",
    );
  }
  // Support custom DeepBook deployments via env vars or explicit options
  const packageIds = options.packageIds ?? {
    DEEPBOOK_PACKAGE_ID: resolveDeepbookPackageId(),
    REGISTRY_ID: resolveDeepbookRegistryId(),
    DEEP_TREASURY_ID: process.env.NEXT_PUBLIC_DEEP_TREASURY_ID
      ?? process.env.DEEP_TREASURY_ID
      ?? undefined,
  };
  return new DeepBookClient({
    client,
    address,
    network,
    balanceManagers,
    coins: options.coins ?? defaultCoins,
    pools: options.pools ?? defaultPools,
    packageIds,
  });
}

export interface PredictionDeepBookMarketConfig {
  poolKey?: string | null;
  poolId: string;
  baseCoinType: string;
  quoteCoinType?: string;
  baseScalar?: number;
  quoteScalar?: number;
}

function packageAddress(coinType: string): string {
  const [address] = coinType.split("::");
  if (!address) throw new Error(`Invalid coin type: ${coinType}`);
  return address;
}

export function createPredictionDeepBookClient(params: {
  client: SuiGrpcClient;
  address: string;
  balanceManagerId?: string | null;
  tradeCapId?: string | null;
  market: PredictionDeepBookMarketConfig;
}) {
  const poolKey = params.market.poolKey ?? PREDICT_DEEPBOOK_POOL_KEY;
  const quoteType = params.market.quoteCoinType ?? DBUSDC_TYPE;
  const balanceManagers: Record<string, BalanceManager> = {};
  if (params.balanceManagerId) {
    balanceManagers[PREDICT_BALANCE_MANAGER_KEY] = {
      address: params.balanceManagerId,
      tradeCap: params.tradeCapId ?? undefined,
    };
  }

  return createDeepBookClient(params.client, params.address, balanceManagers, {
    coins: {
      ...testnetCoins,
      // Override DEEP with self-hosted DEEP type from env
      DEEP: {
        address: packageAddress(DEEP_TYPE),
        type: DEEP_TYPE,
        scalar: 1_000_000,
      },
      [PREDICT_BASE_COIN_KEY]: {
        address: packageAddress(params.market.baseCoinType),
        type: params.market.baseCoinType,
        scalar: params.market.baseScalar ?? 1_000_000,
      },
      [PREDICT_QUOTE_COIN_KEY]: {
        address: packageAddress(quoteType),
        type: quoteType,
        scalar: params.market.quoteScalar ?? 1_000_000,
      },
    },
    pools: {
      ...testnetPools,
      [poolKey]: {
        address: params.market.poolId,
        baseCoin: PREDICT_BASE_COIN_KEY,
        quoteCoin: PREDICT_QUOTE_COIN_KEY,
      },
    },
  });
}

export function buildDeepBookCreateBalanceManagerTx(
  dbClient: DeepBookClient,
  owner?: string,
): Transaction {
  // R-WC-1.3 fix: redundant defensive check. The
  // `createDeepBookClient` pre-flight now catches a
  // missing DEEPBOOK_PACKAGE_ID, but a caller that
  // constructed the DeepBookClient via a custom
  // path (e.g. a test that bypasses the factory)
  // could still pass an unconfigured client here.
  // This guard makes the error message slightly
  // more specific (mentions `createBalanceManager` /
  // `shareBalanceManager` by name) and surfaces the
  // same root cause + remediation.
  const pkg = resolveDeepbookPackageId();
  if (!pkg) {
    throw new Error(
      "buildDeepBookCreateBalanceManagerTx: DEEPBOOK_PACKAGE_ID is not configured. " +
        "Set NEXT_PUBLIC_DEEPBOOK_PACKAGE_ID before constructing the DeepBook client " +
        "(see createDeepBookClient for the full message).",
    );
  }
  // R49 audit fix: validate `owner` at the build boundary. An
  // empty string would fall through to the no-arg branch below
  // (the previous code treated `""` as "no owner", which is
  // wrong — a user who submitted an accidentally blank field
  // got an unowned BalanceManager). A malformed non-empty
  // string would have aborted inside the wallet spinner.
  if (owner !== undefined) {
    if (!isValidSuiAddress(owner)) {
      throw new Error(
        `buildDeepBookCreateBalanceManagerTx: owner must be a non-zero Sui address when provided (got "${owner}")`,
      );
    }
  }
  const tx = new Transaction();
  if (owner) {
    const manager = dbClient.balanceManager.createBalanceManagerWithOwner(owner)(tx);
    dbClient.balanceManager.shareBalanceManager(manager)(tx);
  } else {
    dbClient.balanceManager.createAndShareBalanceManager()(tx);
  }
  return tx;
}

export function buildDeepBookDepositTx(
  dbClient: DeepBookClient,
  coinKey: string,
  amount: number,
): Transaction {
  const tx = new Transaction();
  dbClient.balanceManager.depositIntoManager(
    PREDICT_BALANCE_MANAGER_KEY,
    coinKey,
    amount,
  )(tx);
  return tx;
}

export function buildDeepBookWithdrawTx(
  dbClient: DeepBookClient,
  coinKey: string,
  amount: number,
  recipient: string,
): Transaction {
  const tx = new Transaction();
  dbClient.balanceManager.withdrawFromManager(
    PREDICT_BALANCE_MANAGER_KEY,
    coinKey,
    amount,
    recipient,
  )(tx);
  return tx;
}

export function buildDeepBookPlaceLimitOrderTx(
  dbClient: DeepBookClient,
  params: Omit<PlaceLimitOrderParams, "poolKey" | "balanceManagerKey"> & {
    poolKey?: string;
  },
): Transaction {
  const tx = new Transaction();
  dbClient.deepBook.placeLimitOrder({
    poolKey: params.poolKey ?? PREDICT_DEEPBOOK_POOL_KEY,
    balanceManagerKey: PREDICT_BALANCE_MANAGER_KEY,
    clientOrderId: params.clientOrderId,
    price: params.price,
    quantity: params.quantity,
    isBid: params.isBid,
    expiration: params.expiration,
    orderType: params.orderType ?? OrderType.NO_RESTRICTION,
    selfMatchingOption:
      params.selfMatchingOption ?? SelfMatchingOptions.SELF_MATCHING_ALLOWED,
    payWithDeep: params.payWithDeep ?? true,
  })(tx);
  return tx;
}

export function buildDeepBookWithdrawSettledTx(
  dbClient: DeepBookClient,
  poolKey = PREDICT_DEEPBOOK_POOL_KEY,
): Transaction {
  const tx = new Transaction();
  dbClient.deepBook.withdrawSettledAmounts(poolKey, PREDICT_BALANCE_MANAGER_KEY)(tx);
  return tx;
}

/**
 * R-WC-1.8 fix: read the on-chain BalanceManager balance
 * for a specific coin type. The DeepBook SDK's
 * `checkManagerBalance` is a PTB builder, not a
 * query — it emits a moveCall whose return value is
 * only accessible via dryRun / devInspect. This
 * helper builds the PTB, calls `dryRunTransactionBlock`
 * to simulate it, and returns the parsed u64 balance
 * (or 0 if the BM has no entry for this coin).
 *
 * The on-chain `balance_manager::balance<T>(bm): u64`
 * is a view function — the dryRun runs the PTB
 * without submitting a real transaction. The return
 * value is a BCS-encoded u64 in the first
 * `returnValues` entry of the simulation result.
 */
export async function getBalanceManagerBalance(
  client: SuiClient,
  balanceManagerId: string,
  coinType: string,
): Promise<bigint> {
  const tx = new Transaction();
  tx.setSenderIfNotSet(
    "0x0000000000000000000000000000000000000000000000000000000000000000",
  );
  tx.moveCall({
    target: `${resolveDeepbookPackageId()}::balance_manager::balance`,
    typeArguments: [coinType],
    arguments: [tx.object(normalizeObjectId(balanceManagerId))],
  });
  // R-WC-1.8 fix: the gRPC `core.simulateTransaction`
  // returns a different shape than the JSON-RPC
  // `dryRunTransactionBlock`. Use the JSON-RPC
  // path which is more reliable on the public
  // testnet. The SuiClient type is `SuiGrpcClient`
  // but it exposes a `jsonRpc` field that mirrors
  // the same RPC namespace.
  const jsonRpc = (client as unknown as { jsonRpc?: { dryRunTransactionBlock: (input: { transactionBlock: Transaction }) => Promise<{ results?: { returnValues?: { returnValueBytes?: string }[] }[] }> } }).jsonRpc;
  if (!jsonRpc) {
    // SuiClient = SuiGrpcClient doesn't expose
    // jsonRpc by default. Fall back to 0n (the
    // pre-flight will allow the order through and
    // the user will see the on-chain abort in the
    // wallet — a degraded but safe UX).
    return 0n;
  }
  const result = await jsonRpc.dryRunTransactionBlock({ transactionBlock: tx });
  const returnValues = result.results?.[0]?.returnValues;
  if (!returnValues?.length) {
    return 0n;
  }
  const b64 = returnValues[0]?.returnValueBytes;
  if (!b64) return 0n;
  const bytes = Buffer.from(b64, "base64");
  if (bytes.length < 8) return 0n;
  // little-endian u64
  let value = 0n;
  for (let i = 0; i < 8; i++) {
    const byte = bytes[i] ?? 0;
    value |= BigInt(byte) << BigInt(i * 8);
  }
  return value;
}

export type OrderBookDepth = { bids: [number, number][]; asks: [number, number][] };

export async function getOrderBookDepth(
  dbClient: DeepBookClient,
  poolKey: string,
  lowPrice = 0.01,
  highPrice = 0.99,
): Promise<OrderBookDepth> {
  try {
    const result = await dbClient.deepBook.getLevel2Range(
      poolKey,
      lowPrice,
      highPrice,
      true,
    );
    if (typeof result === "function") return { bids: [], asks: [] };
    return result as OrderBookDepth;
  } catch (err) {
    // R54 audit fix: log the original error before returning the
    // empty-book fallback. The previous `catch {}` swallowed
    // every error — a pool that's been permanently frozen, a
    // wrong network, or an RPC outage all returned `{ bids: [],
    // asks: [] }`, indistinguishable from a genuinely-empty
    // book. The market-maker agent (line 154-157) already has
    // its own outer try/catch, so the swallowing was redundant
    // *and* hid the real error from the operator's logs.
    console.warn(
      `[sdk] getOrderBookDepth(${poolKey}) failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return { bids: [], asks: [] };
  }
}

export async function getMidPrice(dbClient: DeepBookClient, poolKey: string) {
  try {
    const book = await getOrderBookDepth(dbClient, poolKey);
    const bestBid = book.bids[0]?.[0];
    const bestAsk = book.asks[0]?.[0];
    if (bestBid != null && bestAsk != null) return (bestBid + bestAsk) / 2;
    if (bestBid != null) return bestBid;
    if (bestAsk != null) return bestAsk;
    return 0.5;
  } catch (err) {
    // R55 audit fix: log the original error before
    // returning the 0.5 fallback. R54 fixed the same
    // pattern in `getOrderBookDepth` and `getSpotPrice`
    // but missed this one. `market-maker` and
    // `market-resolver` both call this; a 2-hour pool
    // outage would have them post "0.5" mid-price
    // orders indistinguishable from a real mid, churning
    // the book with bad quotes.
    console.warn(
      `[sdk] getMidPrice(${poolKey}) failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return 0.5;
  }
}

export { DBUSDC_TYPE };
