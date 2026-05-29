import { DeepBookClient } from "@mysten/deepbook-v3";
import type { SuiGrpcClient } from "@mysten/sui/grpc";
import { DBUSDC_TYPE } from "./constants.js";

export type { DeepBookClient };

export function createDeepBookClient(
  client: SuiGrpcClient,
  address: string,
  balanceManagers: Record<string, { address: string; tradeCap?: string }> = {},
) {
  return new DeepBookClient({
    client,
    address,
    network: "testnet",
    balanceManagers,
  });
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
