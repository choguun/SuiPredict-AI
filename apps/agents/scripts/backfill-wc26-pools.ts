#!/usr/bin/env -S npx tsx
/**
 * R-WC-3 v3 backfill: copy `onchain_market_id` + `deepbook_pool_id` from the
 * hex-id `markets` rows (written by `market-creator.ts` after a successful
 * on-chain `create_market_with_pool` call) into the matching `wc26-*` rows
 * (written by `wc-demo-seed.ts` at boot with empty on-chain fields).
 *
 * Why this script exists:
 *  - The wc-creator circuit-breaker is currently tripped, so the v3 wc-creator
 *    never re-attempts the failing `create_market_with_pool` flow. The
 *    generic `market-creator.ts` (different code path) successfully created
 *    8 markets on the v3 package using the new shared pool
 *    `0x0fbe4fb2a26272f88c0656b99efbe7cfaa32ac80618dd9250c8065150ccd0555`,
 *    keyed by the on-chain `marketId` (a 32-byte hex string, NOT the
 *    `wc26-<matchId>` form).
 *  - Meanwhile the agents service's boot `wc-demo-seed.ts` writes 8
 *    `wc26-<matchId>` rows (status=active, no on-chain ids) so the home
 *    page has something to render. The `upsertMarket` SQL's `ON CONFLICT
 *    DO UPDATE` clause wipes the wc26 row's `onchain_market_id` and
 *    `deepbook_pool_id` to NULL when the seed runs (because the seed's
 *    payload has `onchain_market_id: undefined`).
 *  - The wc-maker's `matchToMarket` map is keyed by the `wc26-<matchId>`
 *    form, with `marketId` and `poolId` read from the SAME row. With
 *    `poolId` empty, the maker takes the demo path and writes a SQLite
 *    order row but never calls `place_limit_order`. The order book stays
 *    empty.
 *
 * Fix:
 *  - Match hex-id rows to wc26 rows by exact `title` (both go through
 *    `matchWinnerTitle(match)` and produce identical strings).
 *  - Update the wc26 row's `onchain_market_id`, `deepbook_pool_id`,
 *    `pool_id`, and `deepbook_pool_key` from the hex row.
 *  - Re-running the script is safe — it only writes when the wc26 row's
 *    `deepbook_pool_id` is empty.
 *
 * Usage:
 *   cd apps/agents
 *   npx tsx scripts/backfill-wc26-pools.ts
 */
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

// Load the repo-root `.env` so `MARKET_PACKAGE_ID` is available.
// We try (in order): the script's parent dir, the cwd, the cwd's
// parent (for `apps/agents` cwd), and two levels up.
import dotenv from "dotenv";
const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, "..");
const candidates = [
  resolve(__dirname, "../../../.env"),
  resolve(process.cwd(), ".env"),
  resolve(process.cwd(), "../.env"),
  resolve(process.cwd(), "../../.env"),
  resolve(__dirname, "../.env"),
];
for (const p of candidates) {
  if (existsSync(p)) {
    dotenv.config({ path: p });
    break;
  }
}

const dbPath = resolve(__dirname, "../data/markets.db");
const db = new Database(dbPath);

const NEW_V3_POOL = "0x0fbe4fb2a26272f88c0656b99efbe7cfaa32ac80618dd9250c8065150ccd0555";

interface HexRow {
  id: string;
  onchain_market_id: string;
  deepbook_pool_id: string;
  deepbook_pool_key: string | null;
  title: string;
}

interface Wc26Row {
  id: string;
  onchain_market_id: string | null;
  deepbook_pool_id: string | null;
  title: string;
}

const hexRows = db
  .prepare(
    `SELECT id, onchain_market_id, deepbook_pool_id, deepbook_pool_key, title
       FROM markets
      WHERE id LIKE '0x%'
        AND status = 'active'
        AND deepbook_pool_id = ?`,
  )
  .all(NEW_V3_POOL) as HexRow[];

console.log(`Found ${hexRows.length} v3 on-chain markets (pool ${NEW_V3_POOL.slice(0, 10)}...)`);

const wcRows = db
  .prepare(
    `SELECT id, onchain_market_id, deepbook_pool_id, title
       FROM markets
      WHERE id LIKE 'wc26-%'
        AND status = 'active'
        AND (deepbook_pool_id IS NULL OR deepbook_pool_id = '')`,
  )
  .all() as Wc26Row[];

console.log(`Found ${wcRows.length} wc26-* rows with empty pool_id`);

// The hex rows' `title` was double-encoded (Latin-1-of-UTF-8) by an
// earlier `market-creator.ts` call site that ran a JS string through
// a Sui `utf8ToBytes()` then back through a `TextDecoder("latin1")`.
// The wc26 rows' `title` is the correct UTF-8 string. Normalize the
// hex rows' title so the map key matches.
const fixTitle = (s: string): string => {
  try {
    // s is the double-encoded string. Interpret each char code as a byte,
    // then decode the byte sequence as UTF-8.
    const bytes = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i) & 0xff;
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch {
    return s;
  }
};

const byTitle = new Map<string, Wc26Row>();
for (const w of wcRows) byTitle.set(w.title, w);

const update = db.prepare(
  `UPDATE markets
      SET onchain_market_id = @onchainMarketId,
          deepbook_pool_id = @poolId,
          pool_id = @poolId,
          deepbook_pool_key = @poolKey,
          deepbook_base_coin_type = @baseCoinType,
          deepbook_quote_coin_type = @quoteCoinType,
          deepbook_base_scalar = @baseScalar,
          deepbook_quote_scalar = @quoteScalar
    WHERE id = @id`,
);

// The maker's `wcMarkets` filter requires `deepbook_base_coin_type`
// to start with the current package id (the type embeds the package
// id as its first segment). The hex rows we read from have a
// NULL `deepbook_base_coin_type`, so derive it from env (the package
// id is in `.env` as MARKET_PACKAGE_ID / AGENT_POLICY_PACKAGE_ID).
const PKG_ID = (
  process.env.NEXT_PUBLIC_MARKET_PACKAGE_ID ??
  process.env.MARKET_PACKAGE_ID ??
  process.env.NEXT_PUBLIC_AGENT_POLICY_PACKAGE_ID ??
  process.env.AGENT_POLICY_PACKAGE_ID ??
  ""
).trim();
if (!PKG_ID) {
  console.error("[backfill] FATAL: MARKET_PACKAGE_ID not found in env");
  process.exit(1);
}
const YES_COIN_TYPE = `${PKG_ID}::prediction_market::YES`;
const QUOTE_COIN_TYPE =
  process.env.NEXT_PUBLIC_DUSDC_TYPE ??
  process.env.DUSDC_TYPE ??
  "0xe9a73a6f4457f6ecad6260a37a200745a8009e9ee1a235ab91f8d3c030d3a705::dusdc::DUSDC";

let matched = 0;
let unmatched: HexRow[] = [];
const tx = db.transaction((rows: HexRow[]) => {
  for (const h of rows) {
    const normalized = fixTitle(h.title);
    const w = byTitle.get(normalized);
    if (!w) {
      unmatched.push(h);
      return;
    }
    update.run({
      id: w.id,
      onchainMarketId: h.onchain_market_id,
      poolId: h.deepbook_pool_id,
      poolKey: h.deepbook_pool_key ?? `wc_${w.id}`,
      baseCoinType: YES_COIN_TYPE,
      quoteCoinType: QUOTE_COIN_TYPE,
      baseScalar: 1_000_000,
      quoteScalar: 1_000_000,
    });
    matched++;
    console.log(
      `  [OK] ${w.id} → onchain=${h.onchain_market_id.slice(0, 10)}… pool=${h.deepbook_pool_id.slice(0, 10)}…`,
    );
  }
});
tx(hexRows);

console.log(`\nBackfill complete: ${matched} updated, ${unmatched.length} unmatched.`);
if (unmatched.length > 0) {
  console.log("Unmatched hex rows (no wc26-* with the same title):");
  for (const h of unmatched) {
    console.log(`  - ${h.id} (${h.title})`);
  }
}

db.close();
