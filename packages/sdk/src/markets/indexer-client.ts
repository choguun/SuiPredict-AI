import type { MarketInfo, OrderBookSnapshot, PortfolioPosition, VaultSummaryClob } from "./types.js";

/**
 * Resolve the indexer URL at call time so a
 * hot-patch via `bootstrap-env.ts` takes
 * effect on the next request. R52 audit fix:
 * the previous module-level `const` froze
 * the URL at SDK import time, so an env
 * patch made after the agents process was
 * up (e.g. via `setenv` from the
 * `bootstrap-env.ts` hot-reload) was
 * silently lost until the next restart.
 *
 * The `getIndexerUrl()` indirection costs
 * one property access per call; the web
 * bundle inlines `NEXT_PUBLIC_AGENTS_URL`
 * at build time, so the call resolves to a
 * frozen string in the browser. The agents
 * process pays the env-read cost on every
 * request, which is the cost we want.
 */
function getIndexerUrl(): string {
  return (
    process.env.INDEXER_URL ??
    process.env.NEXT_PUBLIC_AGENTS_URL ??
    "http://localhost:3001"
  );
}

async function fetchJson<T>(path: string): Promise<T> {
  // R52 audit fix: bound the fetch with an
  // 8s timeout. A mainnet indexer behind a
  // 502 gateway (Sui infra outage) would
  // otherwise hang the web's home page and
  // the agents' tick loop for the full TCP
  // keepalive (~minutes). Also validate the
  // content-type so a 200 with a Vite dev
  // page (`Content-Type: text/html`) doesn't
  // blow up on `res.json()`.
  //
  // R54 audit fix: cap the response body
  // size at 5 MB and send a `User-Agent`
  // header so a misconfigured indexer that
  // returns a 1 GB body OOMs the Node
  // process. The `User-Agent` lets
  // operators grep the access log for
  // "which deploy is hammering the indexer".
  const url = `${getIndexerUrl()}${path}`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(8_000),
    headers: { "User-Agent": "suipredict-sdk" },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`indexer ${path}: ${res.status}${body ? " — " + body.slice(0, 256) : ""}`);
  }
  const len = Number(res.headers.get("content-length") ?? 0);
  if (len > 5_000_000) {
    throw new Error(
      `indexer ${path}: response too large (Content-Length ${len} > 5_000_000)`,
    );
  }
  const ct = res.headers.get("content-type") ?? "";
  if (!ct.includes("application/json")) {
    throw new Error(
      `indexer ${path}: expected application/json, got ${ct || "(none)"}`,
    );
  }
  return res.json() as Promise<T>;
}

export async function listMarkets(): Promise<MarketInfo[]> {
  // R54 audit fix: paginate the indexer's `/markets` endpoint so
  // protocols with > 50 markets see the full list. The agents
  // indexer caps at 50 rows per call (per `markets/routes.ts:75`),
  // so a single un-paginated fetch silently truncates everything
  // beyond the cap. Loop with the indexer's `?limit=&offset=`
  // query params until the page comes back short. We cap the
  // total at 10,000 markets — well above any realistic deploy
  // size — and throw if we hit the cap so the operator can bump
  // the indexer's per-page limit rather than silently truncating.
  const PAGE_SIZE = 50;
  const MAX_TOTAL = 10_000;
  const all: MarketInfo[] = [];
  let offset = 0;
  for (let page = 0; page < MAX_TOTAL / PAGE_SIZE; page++) {
    const res = await fetchJson<MarketInfo[]>(
      `/markets?limit=${PAGE_SIZE}&offset=${offset}`,
    );
    all.push(...res);
    if (res.length < PAGE_SIZE) break;
    offset += res.length;
    if (all.length >= MAX_TOTAL) {
      throw new Error(
        `listMarkets: hit MAX_TOTAL (${MAX_TOTAL}) after ${page + 1} pages; ` +
          "the indexer may be returning a growing dataset. Bump the cap or " +
          "use a more selective query.",
      );
    }
  }
  return all;
}

export async function getMarket(id: string): Promise<MarketInfo> {
  // R55 audit fix: validate `id` is a non-empty string before
  // building the path. The previous code silently hit
  // `https://...com/markets/` for an empty id and produced a
  // confusing 404 from `fetchJson`. A `null` / `undefined`
  // would also concatenate as the string `"undefined"`. Throw
  // at the build boundary with a readable message.
  //
  // R57.5 audit fix: also enforce the 32-byte hex Sui object id
  // shape. A caller passing `id = "../../admin/secrets"` (a stale
  // URL param or a fuzzer) interpolates into `/markets/…/…` and
  // `fetch` follows the path-traversal after URL normalization.
  // Mirror `normalizeObjectId`'s regex; the indexer handler
  // accepts both upper and lower case.
  if (!id || typeof id !== "string") {
    throw new Error(
      `getMarket: id must be a non-empty string (got ${id === undefined ? "undefined" : JSON.stringify(id)})`,
    );
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(id)) {
    throw new Error(
      `getMarket: id must be a 32-byte hex Sui object id (got ${JSON.stringify(id)})`,
    );
  }
  return fetchJson(`/markets/${id}`);
}

export async function getMarketOrderBook(id: string): Promise<OrderBookSnapshot> {
  // R55 audit fix: same `id` validation as `getMarket`. The
  // web's market page passes the URL param directly; a
  // Next.js catch-all route that resolves to `undefined`
  // would silently 500 with a path like `/markets/undefined/book`.
  //
  // R57.5 audit fix: 32-byte hex shape (see `getMarket`).
  if (!id || typeof id !== "string") {
    throw new Error(
      `getMarketOrderBook: id must be a non-empty string (got ${id === undefined ? "undefined" : JSON.stringify(id)})`,
    );
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(id)) {
    throw new Error(
      `getMarketOrderBook: id must be a 32-byte hex Sui object id (got ${JSON.stringify(id)})`,
    );
  }
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
  // R55 audit fix: paginate the indexer's `/portfolio/:addr`
  // endpoint. R54 added pagination to `listMarkets` but missed
  // this call. The indexer caps at 50 rows per call; a user
  // with 51+ open positions silently truncates to the first
  // 50. Loop with the indexer's `?limit=&offset=` query
  // params until the page comes back short. Cap at 5,000
  // (a single user cannot reasonably hold more than that) and
  // throw if we hit the cap so the operator can bump the
  // indexer's per-page limit.
  if (!address || typeof address !== "string") {
    throw new Error(
      `getPortfolio: address must be a non-empty string (got ${address === undefined ? "undefined" : JSON.stringify(address)})`,
    );
  }
  const PAGE_SIZE = 50;
  const MAX_TOTAL = 5_000;
  const all: PortfolioPosition[] = [];
  let offset = 0;
  for (let page = 0; page < MAX_TOTAL / PAGE_SIZE; page++) {
    const res = await fetchJson<PortfolioPosition[]>(
      `/portfolio/${address}?limit=${PAGE_SIZE}&offset=${offset}`,
    );
    all.push(...res);
    if (res.length < PAGE_SIZE) break;
    offset += res.length;
    if (all.length >= MAX_TOTAL) {
      throw new Error(
        `getPortfolio: hit MAX_TOTAL (${MAX_TOTAL}) after ${page + 1} pages; ` +
          "the indexer may be returning a growing dataset. Bump the cap or " +
          "use a more selective query.",
      );
    }
  }
  return all;
}

export async function getVaultSummaryClob(): Promise<VaultSummaryClob> {
  // R56.9 audit fix: keep the on-the-wire shape (string) at
  // the read boundary. The R55 sweep coerced to `Number(...)`
  // to defend against a future bigint-as-string migration,
  // but `Number(bigintString)` loses precision above
  // 2^53 - 1 (DUSDC has 6 decimals, so 2^53 atoms = ~$9
  // trillion). The new contract is "string everywhere" —
  // render with `BigInt(s).toString()` + `formatDusdc` to
  // preserve precision through to the admin / home / vault
  // pages. Tolerate the old `number` wire shape for
  // backwards compat with a pre-R56 agents deploy.
  const raw = await fetchJson<VaultSummaryClob>("/vault/summary");
  return {
    ...raw,
    total_balance: String(raw.total_balance),
    allocated: String(raw.allocated),
    available: String(raw.available),
  };
}

export { tupleBookToSnapshot };
