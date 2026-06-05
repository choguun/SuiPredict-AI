import type { IncomingMessage, ServerResponse } from "node:http";
import {
  getMarket,
  getOrderBook,
  getPortfolio,
  getVaultSummaryFromEnv,
  listChainOrders,
  listMarkets,
} from "./store.js";
import { corsFor } from "../http-cors.js";

function json(res: ServerResponse, status: number, body: unknown, sideEffecting = false) {
  // R35 audit fix: every markets response previously set "*" CORS.
  // The markets routes are read-only (list / detail / order book /
  // portfolio / vault summary), so the side-effecting flag is
  // false by default. Pass `sideEffecting=true` from any future
  // mutation endpoint. The shared helper applies the same
  // env-driven allowlist as gamification/routes.ts.
  res.writeHead(status, {
    "Content-Type": "application/json",
    ...corsFor(sideEffecting),
  });
  res.end(JSON.stringify(body));
}

export function handleMarketsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): boolean {
  if (req.method === "OPTIONS") {
    // Markets routes are read-only, so the preflight response uses
    // the open CORS. The shared helper still applies the allowlist
    // when ALLOWED_ORIGIN is set; this matches the no-side-effects
    // policy for /health, /decisions, /agents/manifest in
    // index.ts.
    res.writeHead(204, {
      ...corsFor(false),
      "Access-Control-Allow-Methods": "GET, OPTIONS",
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
      // R48 audit fix: cap the limit param so a malicious or naive
      // client can't request `limit=1e9` and hold the agents
      // worker on a 100k-row scan. Mirror the gamification
      // leaderboard route which caps at 500. Reject non-finite /
      // negative values.
      const raw = Number(url.searchParams.get("limit") ?? 50);
      const limit = Number.isFinite(raw) && raw > 0
        ? Math.min(raw, 500)
        : 50;
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
