#!/usr/bin/env node
/**
 * One-shot reconciliation: every `chain_orders` row in the SQLite
 * mirror with `cancelled_at_ms IS NULL` was placed BEFORE the v3
 * indexer wired the DeepBook `order::OrderCanceled` fallback. Even
 * though the agent ran `buildCancelAllOrdersTx` and the on-chain
 * pool is empty, the off-chain `chain_orders` mirror never saw the
 * cancel signal because v3's `prediction_market::cancel_all_orders`
 * does not emit `OrderCancelledEvent` (see
 * `prediction_market.move:1226`).
 *
 * Walk the DeepBook `OrderCanceled` event stream backwards from the
 * tip until we hit an event older than the oldest still-open
 * `chain_orders` row, mark every (pool_id, order_id) hit as
 * cancelled in the SQLite mirror. Idempotent: re-runs find no
 * remaining stale rows and exit.
 *
 * Run: `node apps/agents/scripts/reconcile-stale-chain-orders.mjs`
 * (loads .env, requires DEEPBOOK_PACKAGE_ID and DATA_DIR).
 */
import dotenv from "dotenv";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const __dirname = dirname(fileURLToPath(import.meta.url));
for (const p of [
  resolve(__dirname, "../../../.env"),
  resolve(__dirname, "../../.env"),
  resolve(process.cwd(), ".env"),
]) {
  if (existsSync(p)) {
    dotenv.config({ path: p, override: true });
    break;
  }
}

const deepbookPkg =
  process.env.DEEPBOOK_PACKAGE_ID ??
  process.env.NEXT_PUBLIC_DEEPBOOK_PACKAGE_ID;
if (!deepbookPkg) {
  console.error(
    "DEEPBOOK_PACKAGE_ID (or NEXT_PUBLIC_DEEPBOOK_PACKAGE_ID) not set",
  );
  process.exit(1);
}
const rpcUrl =
  process.env.SUI_JSON_RPC_URL ??
  (process.env.SUI_NETWORK === "mainnet"
    ? "https://fullnode.mainnet.sui.io:443"
    : "https://fullnode.testnet.sui.io:443");

const dbPath = process.env.DATA_DIR
  ? join(process.env.DATA_DIR, "markets.db")
  : resolve(__dirname, "../data/markets.db");
const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

// Snapshot of stale (pool_id, order_id) pairs we still need to match.
// Pull them keyed by pool so the event walk can filter cheaply.
const stale = db
  .prepare(
    `SELECT market_id, order_id, pool_id, timestamp_ms
       FROM chain_orders
       WHERE cancelled_at_ms IS NULL
       ORDER BY timestamp_ms ASC`,
  )
  .all();
if (stale.length === 0) {
  console.log("no stale open orders; nothing to reconcile");
  process.exit(0);
}
const want = new Map();
for (const row of stale) {
  if (!want.has(row.pool_id)) want.set(row.pool_id, new Map());
  want.get(row.pool_id).set(String(row.order_id), {
    market_id: row.market_id,
    ts_ms: row.timestamp_ms,
  });
}
const oldestMs = stale[0].timestamp_ms;
console.log(
  `[reconcile] ${stale.length} stale open orders across ${want.size} pools; oldest ts=${oldestMs}`,
);

const markCancelled = db.prepare(
  `UPDATE chain_orders
      SET cancelled_at_ms = ?
    WHERE market_id = ? AND order_id = ? AND cancelled_at_ms IS NULL`,
);

// Walk backwards from the tip. Sui's `queryEvents` with a `cursor`
// + `order: descending` returns the latest events first; we keep
// going until the event timestamp drops below `oldestMs`.
let cursor = null;
const PAGE = 200;
let pageNo = 0;
let marked = 0;
let scanned = 0;
outer: while (true) {
  pageNo += 1;
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "suix_queryEvents",
    params: [
      { MoveEventType: `${deepbookPkg}::order::OrderCanceled` },
      cursor,
      PAGE,
      false,
    ],
  };
  const r = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (j.error) {
    console.error(`rpc error page ${pageNo}:`, j.error.message);
    process.exit(1);
  }
  const events = j.result?.data ?? [];
  if (events.length === 0) break;
  cursor = j.result.nextCursor ?? null;
  for (const ev of events) {
    const ts = ev.timestampMs ? Number(ev.timestampMs) : 0;
    scanned += 1;
    if (ts < oldestMs) break outer;
    const pj = ev.parsedJson;
    if (!pj?.pool_id || pj?.order_id == null) continue;
    const poolId = pj.pool_id;
    const orderId = String(pj.order_id);
    const expected = want.get(poolId)?.get(orderId);
    if (!expected) continue;
    const result = markCancelled.run(ts, expected.market_id, orderId);
    if (result.changes > 0) {
      marked += 1;
      console.log(
        `[reconcile] marked cancelled market=${expected.market_id.slice(0, 16)}… order=${orderId} ts=${ts}`,
      );
      // Drop from `want` so we stop matching this order on later pages.
      want.get(poolId).delete(orderId);
      if (want.get(poolId).size === 0) want.delete(poolId);
      if (want.size === 0) break outer;
    }
  }
  if (!cursor) break;
}

const remaining = db
  .prepare(
    `SELECT COUNT(*) AS n FROM chain_orders WHERE cancelled_at_ms IS NULL`,
  )
  .get();
console.log(
  `[reconcile] done: scanned=${scanned} events across ${pageNo} pages, marked=${marked}, remaining open=${remaining.n}`,
);
