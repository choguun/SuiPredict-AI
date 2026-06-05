import {
  DeepBookClient,
  OrderType,
  SelfMatchingOptions,
  testnetCoins,
  testnetPools,
  type BalanceManager,
  type CoinMap,
  type PlaceLimitOrderParams,
  type PoolMap,
} from "@mysten/deepbook-v3";
import type { SuiGrpcClient } from "@mysten/sui/grpc";
import { Transaction } from "@mysten/sui/transactions";
import { DBUSDC_TYPE } from "./constants.js";
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
  } = {},
) {
  return new DeepBookClient({
    client,
    address,
    // R48 audit fix: derive the default from the same `SUI_NETWORK`
    // env var the rest of the SDK already uses (R39). A mainnet
    // deploy that forgets to pass `options.network: "mainnet"`
    // previously fell through to "testnet" and silently used the
    // testnet coin/pool registry, breaking every CLOB trade.
    network:
      options.network ??
      (process.env.SUI_NETWORK === "mainnet" ? "mainnet" : "testnet"),
    balanceManagers,
    coins: options.coins,
    pools: options.pools,
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
  } catch {
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
  } catch {
    return 0.5;
  }
}

export { DBUSDC_TYPE };
