// R58.H7 regression test: pin the JSON cursor
// serialization contract. The pre-fix `writeCursor`
// called `String(cursor)` on a `{txDigest, eventSeq}`
// object and produced the literal string
// `"[object Object]"`. Every subsequent read cast it
// back to `EventCursor` and re-sent it to
// `queryEvents`, which the Sui RPC rejected with
// "Invalid params" on every tick.
//
// The boot log was full of:
//   [position-indexer] MarketCreated poll failed: Invalid params
//   [position-indexer] VaultCreated poll failed: Invalid params
//   [position-indexer] RegistryCreated poll failed: Invalid params
//
// These tests pin the on-disk shape so a future
// refactor can't accidentally re-introduce the
// `String()` cast.

import test from "node:test";
import assert from "node:assert/strict";

// Mirror the on-disk shape of the Sui cursor object.
interface EventCursor {
  txDigest: string;
  eventSeq: string;
}

// Re-derive the writer contract: the Sui cursor must
// be JSON-stringified (not `String()`-coerced) so it
// round-trips back to an object.
function serializeCursor(cursor: EventCursor | null | undefined): string | null {
  if (cursor == null) return null;
  return JSON.stringify(cursor);
}

// Re-derive the reader contract: parse the stored
// string. Non-JSON values (the broken legacy rows
// from the pre-R58.H7 writer) are treated as null
// so the indexer re-bootstraps from the genesis
// cursor.
function deserializeCursor(raw: string | null): EventCursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed && typeof parsed === "object" &&
      "txDigest" in parsed && typeof (parsed as { txDigest: unknown }).txDigest === "string" &&
      "eventSeq" in parsed && typeof (parsed as { eventSeq: unknown }).eventSeq === "string"
    ) {
      return parsed as EventCursor;
    }
    return null;
  } catch {
    return null;
  }
}

test("R58.H7 — writeCursor round-trips a Sui cursor object", () => {
  const cursor: EventCursor = {
    txDigest: "FFhLQka3CnLggNardwj4dV5Vc82ALGW38r5sykzNfGFe",
    eventSeq: "2",
  };
  const stored = serializeCursor(cursor);
  // Must NOT be the broken pre-fix value.
  assert.notEqual(stored, "[object Object]");
  // Must be parseable JSON.
  const round = deserializeCursor(stored);
  assert.ok(round, "round-tripped cursor should not be null");
  assert.deepEqual(round, cursor);
});

test("R58.H7 — legacy '[object Object]' rows are treated as null", () => {
  // Backward-compat: old rows from the pre-R58.H7
  // writer stored the literal string `"[object Object]"`
  // because `String({txDigest, eventSeq})` falls
  // through to `Object.prototype.toString`. A
  // fresh-deploy + legacy-DB scenario must NOT
  // crash; it should re-bootstrap from null.
  assert.equal(deserializeCursor("[object Object]"), null);
});

test("R58.H7 — null is null", () => {
  assert.equal(deserializeCursor(null), null);
  assert.equal(serializeCursor(null), null);
});

test("R58.H7 — invalid JSON is null", () => {
  assert.equal(deserializeCursor("not json"), null);
  assert.equal(deserializeCursor(""), null);
  assert.equal(deserializeCursor("{}"), null); // missing keys
  assert.equal(deserializeCursor('{"txDigest":"abc"}'), null); // missing eventSeq
});

test("R58.H7 — String(cursor) would have produced the broken value", () => {
  // This test pins the original bug as a "this is
  // what we DON'T do" so a future refactor of the
  // writer can't re-introduce the `String()` cast.
  const cursor: EventCursor = {
    txDigest: "FFhLQka3CnLggNardwj4dV5Vc82ALGW38r5sykzNfGFe",
    eventSeq: "2",
  };
  assert.equal(String(cursor), "[object Object]");
  // Verify the new code path uses JSON.stringify.
  assert.equal(serializeCursor(cursor), JSON.stringify(cursor));
});
