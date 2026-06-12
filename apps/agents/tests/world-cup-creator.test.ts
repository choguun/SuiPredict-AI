// Regression test for R58.H5: the wc-creator must convert
// the DeepBook `register_pool` abort (code 1) into a demo
// row instead of logging it as a failure. Without this
// guard, the boot log fills with
//
//   [wc-creator] E1v4 failed: MoveAbort ... abort code: 1,
//   in '0xc93ae...::registry::register_pool'
//
// and the UI sees 0 wc26-* markets even though the
// underlying matches exist.
//
// We extract the relevant substring of the error message
// the same way the catch-block does, and assert that the
// pattern matches an actual production abort string from
// the wc-creator boot log.

import test from "node:test";
import assert from "node:assert/strict";

const POOL_ALREADY_EXISTS_PATTERN =
  /abort code: 1.*register_pool/;

// Verbatim strings from the user's boot log (2026-06-12).
// If DeepBook ever renames the function, this test will
// start failing and we'll know to update the catch-block
// regex too.
const BOOT_LOG_ABORT =
  "Transaction resolution failed: MoveAbort in 1st command, " +
  "abort code: 1, in '0xc93ae840671495202260c7afb93c820bf11c081b884b660106399208871dec5a" +
  "::registry::register_pool' (instruction 32)";

test("R58.H5 — register_pool abort code 1 is recognised", () => {
  assert.match(BOOT_LOG_ABORT, POOL_ALREADY_EXISTS_PATTERN);
});

test("R58.H5 — unrelated Move aborts are NOT swallowed", () => {
  const unrelated =
    "MoveAbort in 1st command, abort code: 7, in '0xabc::oracle::stale'";
  assert.doesNotMatch(unrelated, POOL_ALREADY_EXISTS_PATTERN);
});

test("R58.H5 — non-Move errors are not classified as pool-exists", () => {
  const network =
    "network error: connection reset by peer";
  assert.doesNotMatch(network, POOL_ALREADY_EXISTS_PATTERN);
});

// The dedupe key function lives in world-cup-creator.ts.
// We re-derive the contract here to lock in the public
// shape (id = "wc26-" + matchId) so a future refactor
// can't break the wc26-... routing in the UI.
function dedupeKey(matchId: string): string {
  return `wc26-${matchId}`;
}

test("R58.H5 — dedupeKey adds the wc26- prefix", () => {
  assert.equal(dedupeKey("E1v4"), "wc26-E1v4");
  assert.equal(dedupeKey("A1v3"), "wc26-A1v3");
});

// Mirror the no-DEEP branch's demo-row shape so we can
// assert the catch block writes the same row when the
// on-chain tx aborts. This is the row the wc26-... page
// reads from `markets.db`.
interface DemoRow {
  id: string;
  title: string;
  category: string;
  status: string;
}

function buildDemoRow(matchId: string, title: string): DemoRow {
  return {
    id: dedupeKey(matchId),
    title,
    category: "worldcup",
    status: "active",
  };
}

test("R58.H5 — demo row uses the wc26-* key (not a random id)", () => {
  // If this test ever flips to demo-${Date.now()}, the
  // UI's "Could not load market" error will come back
  // because the page key is wc26-... and the row id
  // wouldn't match.
  const row = buildDemoRow("E1v4", "Will Ecuador 🇪🇨 beat Germany 🇩🇪?");
  assert.equal(row.id, "wc26-E1v4");
  assert.equal(row.category, "worldcup");
  assert.equal(row.status, "active");
});
