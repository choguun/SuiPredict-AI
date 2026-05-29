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
