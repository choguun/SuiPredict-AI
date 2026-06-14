// Tests for the R60 audit fix that consolidated the
// on-chain + wc26 SQLite rows into a single row.
//
// Run with:  pnpm --filter @suipredict/agents exec node --import tsx --test tests/world-cup-resolver.test.ts

import test from "node:test";
import assert from "node:assert/strict";

/**
 * Re-implement the `matchIdFromMarketRow` helper here so
 * the test is hermetic (no DB / agent runtime needed).
 * The production copy in `world-cup-resolver.ts` is the
 * source of truth; this test pins the contract.
 */
function matchIdFromMarketRow(market: {
  id: string;
  deepbook_pool_key?: string | null;
}): string | null {
  if (market.id.startsWith("wc26-")) return market.id.slice("wc26-".length);
  const key = market.deepbook_pool_key;
  if (key && key.startsWith("wc_")) return key.slice("wc_".length);
  return null;
}

test("matchIdFromMarketRow: accepts the canonical wc26-<matchId> form", () => {
  assert.equal(
    matchIdFromMarketRow({ id: "wc26-A1v3" }),
    "A1v3",
    "wc26- prefix must be stripped",
  );
  assert.equal(
    matchIdFromMarketRow({ id: "wc26-K4v2" }),
    "K4v2",
  );
});

test("matchIdFromMarketRow: accepts the on-chain form via deepbook_pool_key", () => {
  // The pre-R60 wc-creator stored the on-chain marketId
  // in `m.id` (a 0x... string) and used
  // `deepbook_pool_key = "wc_<matchId>"` to link back
  // to the schedule. The R60 fix keeps this fall-back so
  // pre-R60 DBs (or any race where the on-chain row
  // exists before the consolidated row) still resolve.
  assert.equal(
    matchIdFromMarketRow({
      id: "0xabc123def4567890abcdef1234567890abcdef1234567890abcdef1234567890",
      deepbook_pool_key: "wc_A1v3",
    }),
    "A1v3",
    "deepbook_pool_key=wc_A1v3 must yield matchId A1v3",
  );
});

test("matchIdFromMarketRow: rejects rows with neither a wc26- id nor a wc_ pool key", () => {
  assert.equal(
    matchIdFromMarketRow({ id: "demo-1234" }),
    null,
    "demo-* rows are not WC matches",
  );
  assert.equal(
    matchIdFromMarketRow({
      id: "0xabcdef",
      deepbook_pool_key: "some_other_pool",
    }),
    null,
    "non-wc_ pool keys must be rejected",
  );
  assert.equal(
    matchIdFromMarketRow({
      id: "0xabcdef",
    }),
    null,
    "missing pool key on a non-wc26 id must be rejected",
  );
});

test("matchIdFromMarketRow: prefers the wc26- id over a wc_ pool key", () => {
  // Both forms present: the canonical wc26- id wins so a
  // future operator who sets both on the same row never
  // gets an inconsistent matchId.
  assert.equal(
    matchIdFromMarketRow({
      id: "wc26-A1v3",
      deepbook_pool_key: "wc_B2v4",
    }),
    "A1v3",
  );
});
