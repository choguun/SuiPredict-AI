// Smoke tests for the SDK's market-id validator.
//
// The previous strict check (`/^0x[0-9a-fA-F]{64}$/`) broke
// demo seed ids like "wc26-J1v3" which the indexer correctly
// accepts. The new `isValidMarketId` is permissive on shape
// but strict on path-safety. These tests pin both halves of
// the contract so a future refactor doesn't re-introduce the
// Sui-only check or accidentally allow path-traversal.

import test from "node:test";
import assert from "node:assert/strict";

// The validator is private. We exercise it indirectly via
// getMarket's error path: a valid id is sent to the
// indexer (which may or may not be running) and we expect
// the SDK to NOT throw a "must be a 32-byte hex Sui object
// id" error. An invalid id should throw that error.
import { getMarket } from "../src/markets/indexer-client.js";

test("getMarket accepts demo seed ids (wc26-...) without throwing a shape error", async () => {
  // We don't care whether the call succeeds (the indexer
  // may not be running); we only care that the SDK
  // doesn't reject the id at the build boundary.
  let err: Error | null = null;
  try {
    await getMarket("wc26-J1v3");
  } catch (e) {
    err = e as Error;
  }
  if (err) {
    // The error should be from the indexer (404, network, etc.)
    // — NOT from the SDK's id validator.
    assert.ok(
      !/must be a 32-byte hex Sui object id/i.test(err.message),
      `SDK rejected demo seed id at the build boundary: ${err.message}`,
    );
    // Acceptable error classes: 404 (no indexer), fetch
    // failed (no agents), or anything from the indexer.
    assert.ok(
      /404|indexer|fetch|network|abort|ENOTFOUND|ECONNREFUSED|timeout/i.test(err.message),
      `Unexpected error from a valid demo id: ${err.message}`,
    );
  }
});

test("getMarket accepts Sui object ids (lowercase hex)", async () => {
  const id = "0x" + "0".repeat(64);
  let err: Error | null = null;
  try {
    await getMarket(id);
  } catch (e) {
    err = e as Error;
  }
  if (err) {
    assert.ok(
      !/must be a 32-byte hex Sui object id/i.test(err.message),
      `SDK rejected Sui object id: ${err.message}`,
    );
  }
});

test("getMarket accepts Sui object ids (uppercase hex)", async () => {
  const id = "0x" + "ABCDEF".repeat(10) + "ABCDEF".repeat(2) + "AB";
  let err: Error | null = null;
  try {
    await getMarket(id);
  } catch (e) {
    err = e as Error;
  }
  if (err) {
    assert.ok(
      !/must be a 32-byte hex Sui object id/i.test(err.message),
      `SDK rejected uppercase Sui object id: ${err.message}`,
    );
  }
});

test("getMarket rejects path-traversal attempts at the build boundary", async () => {
  // The indexer might 404, but the SDK must reject these
  // BEFORE the fetch — i.e. the error class is the SDK's
  // "must be a non-empty path-safe string" message, not
  // a network or 404 error.
  const bad = [
    "../../../admin/secrets",
    "foo/bar",
    "foo%2Fbar",
    "foo..bar",
    "foo bar",
    "foo\tbar",
    "foo#bar",
    "foo?bar",
    "",
    " ",
  ];
  for (const id of bad) {
    let err: Error | null = null;
    try {
      await getMarket(id);
    } catch (e) {
      err = e as Error;
    }
    assert.ok(err, `SDK accepted dangerous id: ${JSON.stringify(id)}`);
    assert.ok(
      /non-empty path-safe string|non-empty string/i.test(err.message),
      `Wrong error for ${JSON.stringify(id)}: ${err?.message ?? "(none)"}`,
    );
  }
});

test("getMarket rejects ids over 128 chars", async () => {
  const id = "a".repeat(129);
  let err: Error | null = null;
  try {
    await getMarket(id);
  } catch (e) {
    err = e as Error;
  }
  assert.ok(err, "SDK accepted an id over 128 chars");
  assert.ok(
    /non-empty path-safe string|non-empty string/i.test(err.message),
    `Wrong error: ${err?.message ?? "(none)"}`,
  );
});
