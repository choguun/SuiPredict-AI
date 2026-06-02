import type { IncomingMessage, ServerResponse } from "node:http";
import {
  getMarket,
  getOrderBook,
  getPortfolio,
  getVaultSummaryFromEnv,
  listChainOrders,
  listMarkets,
} from "./store.js";

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(body));
}

export function handleMarketsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): boolean {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return true;
  }

  if (req.method !== "GET") return false;

  if (url.pathname === "/markets") {
    json(res, 200, listMarkets());
    return true;
  }

  if (url.pathname === "/vault/summary") {
    json(res, 200, getVaultSummaryFromEnv());
    return true;
  }

  const marketMatch = url.pathname.match(/^\/markets\/([^/]+)(\/book|\/orders)?$/);
  if (marketMatch) {
    const [, id, sub] = marketMatch;
    const market = getMarket(id!);
    if (!market) {
      json(res, 404, { error: "market not found" });
      return true;
    }
    if (sub === "/book") {
      json(res, 200, getOrderBook(id!));
      return true;
    }
    if (sub === "/orders") {
      const limit = Number(url.searchParams.get("limit") ?? 50);
      json(res, 200, { orders: listChainOrders(id!, limit) });
      return true;
    }
    json(res, 200, market);
    return true;
  }

  const portfolioMatch = url.pathname.match(/^\/portfolio\/(0x[a-fA-F0-9]+)$/);
  if (portfolioMatch) {
    json(res, 200, getPortfolio(portfolioMatch[1]!));
    return true;
  }

  return false;
}
