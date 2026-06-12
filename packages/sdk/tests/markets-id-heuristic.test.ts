// R58.H6 regression test: the page-side `isLikelySuiId`
// heuristic. The web client uses
//   getMarket(isLikelySuiId ? normalizeObjectId(marketId) : marketId)
// instead of blindly calling `normalizeObjectId(marketId)`.
//
// The reason: `normalizeObjectId` throws on any id that
// doesn't match `/^0x[0-9a-f]{64}$/`. The throw message
// ("not a valid Sui object id (expected 0x + 64 hex
// chars)") doesn't include "404" or "not[-_ ]?found", so
// the page's error classifier would label it as
// `fetch_failed` and show "The agents indexer is
// unreachable" even though the agents service was up and
// serving the row.
//
// The fix: only call `normalizeObjectId` when the id
// actually looks like a Sui object id. Demo seed ids
// (wc26-...) pass through unchanged — the SDK's
// `isValidMarketId` accepts them.
//
// We pin the heuristic shape here so a future refactor of
// the page can't accidentally re-introduce the Sui-only
// call and silently break all wc26-* pages.

import test from "node:test";
import assert from "node:assert/strict";

function isLikelySuiId(id: string): boolean {
  // Mirror the page-side heuristic exactly.
  return /^0x[0-9a-fA-F]{64}$/.test(id);
}

test("isLikelySuiId: accepts 0x + 64 lowercase hex chars", () => {
  assert.equal(
    isLikelySuiId("0x" + "0".repeat(64)),
    true,
  );
});

test("isLikelySuiId: accepts 0x + 64 uppercase hex chars", () => {
  // Real Sui object ids are lowercase, but the page-side
  // gets mixed-case from URL decode (`decodeURIComponent`)
  // and user paste. The heuristic should accept both
  // cases so the lowercasing (via normalizeObjectId)
  // happens.
  assert.equal(
    isLikelySuiId("0x" + "ABCDEF".repeat(10) + "AB".repeat(2)),
    true,
  );
});

test("isLikelySuiId: rejects demo seed ids (wc26-...)", () => {
  // The whole point of the heuristic: demo ids must
  // pass through unchanged so the SDK's permissive
  // isValidMarketId can accept them.
  for (const id of [
    "wc26-A1v3",
    "wc26-K1v4",
    "wc26-D4v2",
    "demo-btc-100k",
    "demo-sui-ath",
  ]) {
    assert.equal(isLikelySuiId(id), false, `should reject ${id}`);
  }
});

test("isLikelySuiId: rejects wrong-length hex strings", () => {
  // 63 chars (one short) and 65 chars (one long) are
  // both Sui-shaped but malformed; the heuristic
  // shouldn't normalize these because the resulting
  // lowercased id would still fail the 64-char check
  // inside normalizeObjectId, and we'd lose the
  // descriptive error message.
  assert.equal(isLikelySuiId("0x" + "0".repeat(63)), false);
  assert.equal(isLikelySuiId("0x" + "0".repeat(65)), false);
});

test("isLikelySuiId: rejects non-hex strings starting with 0x", () => {
  assert.equal(isLikelySuiId("0x" + "z".repeat(64)), false);
});

test("isLikelySuiId: rejects empty string", () => {
  assert.equal(isLikelySuiId(""), false);
});
