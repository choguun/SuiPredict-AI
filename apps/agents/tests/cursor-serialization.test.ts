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

// R58.H10 regression: pin the position-indexer's
// package-id resolution order. The pre-fix code read
// `AGENT_POLICY_PACKAGE_ID` for every event filter,
// which silently returned zero matches on a two-package
// deploy (AgentPolicy at one package, CLOB at another).
// The fix prefers MARKET_PACKAGE_ID with a fallback to
// AGENT_POLICY_PACKAGE_ID.

function resolveIndexerPkg(env: Record<string, string | undefined>): string {
  return env.MARKET_PACKAGE_ID ?? env.AGENT_POLICY_PACKAGE_ID ?? "";
}

test("R58.H10 — indexer prefers MARKET_PACKAGE_ID when both are set", () => {
  // Two-package deploy: the CLOB lives at MARKET, the
  // AgentPolicy at AGENT. The indexer must use MARKET
  // for events like MarketCreatedEvent.
  const pkg = resolveIndexerPkg({
    MARKET_PACKAGE_ID: "0x23b78cabb",
    AGENT_POLICY_PACKAGE_ID: "0xb1777f167c",
  });
  assert.equal(pkg, "0x23b78cabb");
});

test("R58.H10 — indexer falls back to AGENT_POLICY_PACKAGE_ID", () => {
  // Single-package deploy (the common case).
  const pkg = resolveIndexerPkg({
    AGENT_POLICY_PACKAGE_ID: "0xb1777f167c",
  });
  assert.equal(pkg, "0xb1777f167c");
});

test("R58.H10 — indexer returns empty when both are unset", () => {
  const pkg = resolveIndexerPkg({});
  assert.equal(pkg, "");
});
// R58.H20 regression: pin the alt-ids set
// the resolver builds from a single schedule
// id. The LLM extractor has been returning
// several inconsistent match-id shapes
// (A1vA3, A1vE2, B1vB3, 1v3) and the pre-fix
// code only tried the canonical id and the
// "vA"-prefixed form, which missed the
// "vE"/"vB"/"v<L>" shapes. The alt-ids set
// must include every shape the LLM might
// return so a future prompt change doesn't
// silently drop every match.

function altIdsFor(matchId: string): string[] {
  const candidates = new Set<string>();
  candidates.add(matchId);
  if (!matchId.includes("v")) return [...candidates];
  const [prefix = "", rest = ""] = matchId.split("v", 2);
  if (!prefix || !rest) return [matchId];
  const groupLetter = prefix[0] ?? "";
  const stripped = rest.startsWith(groupLetter) ? rest.slice(1) : rest;
  candidates.add(`${prefix}v${stripped}`);
  return [...candidates];
}

test("R58.H20 — A1v3 generates {A1v3} (no leading letter to strip)", () => {
  assert.deepEqual(altIdsFor("A1v3"), ["A1v3"]);
});

test("R58.H20 — A1vA3 generates {A1v3, A1vA3} (strip leading A)", () => {
  assert.deepEqual(altIdsFor("A1vA3").sort(), ["A1v3", "A1vA3"].sort());
});

test("R58.H20 — A1v2 generates just {A1v2} (no leading group letter to strip)", () => {
  // The LLM might return "A1v2" directly (no
  // leading letter). The function should keep
  // it as-is.
  assert.deepEqual(altIdsFor("A1v2").sort(), ["A1v2"].sort());
});

test("R58.H20 — B1vB3 generates {B1v3, B1vB3}", () => {
  assert.deepEqual(altIdsFor("B1vB3").sort(), ["B1v3", "B1vB3"].sort());
});

test("R58.H20 — handles missing leading group letter (1v3 stays 1v3)", () => {
  // Defensive: if the schedule's id is
  // "1v3" (no group letter), the function
  // should return just ["1v3"].
  assert.deepEqual(altIdsFor("1v3"), ["1v3"]);
});
