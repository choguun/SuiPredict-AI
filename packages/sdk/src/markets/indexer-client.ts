import type { MarketInfo, OrderBookSnapshot, PortfolioPosition } from "./types.js";

const INDEXER_URL =
  process.env.INDEXER_URL ??
  process.env.NEXT_PUBLIC_AGENTS_URL ??
  "http://localhost:3001";

async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(`${INDEXER_URL}${path}`);
  if (!res.ok) throw new Error(`indexer ${path}: ${res.status}`);
  return res.json() as Promise<T>;
}

export async function listMarkets(): Promise<MarketInfo[]> {
  return fetchJson("/markets");
}

export async function getMarket(id: string): Promise<MarketInfo> {
  return fetchJson(`/markets/${id}`);
}

export async function getMarketOrderBook(id: string): Promise<OrderBookSnapshot> {
  return fetchJson(`/markets/${id}/book`);
}

/**
 * Convert a [price, quantity] tuple from DeepBook's `getLevel2Range`
 * into an OrderBookSnapshot compatible with the rest of the SDK. The
 * `order_id` field is empty since the direct pool read does not
 * return order ids — only price levels and aggregated quantities.
 */
function tupleBookToSnapshot(
  marketId: string,
  bids: [number, number][],
  asks: [number, number][],
): OrderBookSnapshot {
  const toLevel = (t: [number, number]) => ({
    price: t[0],
    price_bps: Math.round(t[0] * 10_000),
    quantity: t[1],
  });
  const bidLevels = bids.map(toLevel).sort((a, b) => b.price_bps - a.price_bps);
  const askLevels = asks.map(toLevel).sort((a, b) => a.price_bps - b.price_bps);
  const bestBid = bidLevels[0]?.price_bps ?? 0;
  const bestAsk = askLevels[0]?.price_bps ?? 10_000;
  const mid = bestBid && bestAsk ? (bestBid + bestAsk) / 2 / 10_000 : 0.5;
  return {
    market_id: marketId,
    bids: bidLevels,
    asks: askLevels,
    spread_bps: bestBid && bestAsk ? bestAsk - bestBid : 0,
    mid_price: mid,
  };
}

export async function getPortfolio(address: string): Promise<PortfolioPosition[]> {
  return fetchJson(`/portfolio/${address}`);
}

export async function getVaultSummaryClob(): Promise<{
  vault_id: string;
  total_balance: number;
  allocated: number;
}> {
  return fetchJson("/vault/summary");
}

export { tupleBookToSnapshot };
