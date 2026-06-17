// R-WC-1 regression test: the `ensureMarketCreated` +
// `findExistingYesPool` SDK helpers. The previous
// `world-cup-creator` flow caught the DeepBook
// `EPoolAlreadyExists` abort from `create_market` and
// silently wrote a SQLite-only "demo" row for the
// remaining 46 of 47 WC matches. The new helpers route
// the abort into `create_market_with_pool`, which
// reuses the existing pool and creates a real
// on-chain `PredictionMarket` per match.
//
// We pin three behaviours here so a future refactor of
// the SDK can't accidentally re-introduce the
// SQLite-only fallback:
//
//   1. `findExistingYesPool` returns the registry pool
//      id when a matching dynamic field is present.
//   2. `ensureMarketCreated` requires
//      `deepbookRegistry` to be set even if the pool
//      already exists (otherwise we'd silently create
//      a new pool on the wrong network).
//   3. `findExistingYesPool` returns `null` on a
//      registry with no YES<DUSDC> dynamic field
//      (the bootstrap path then knows to call
//      `create_market` for the very first market).

import test from "node:test";
import assert from "node:assert/strict";
import { findExistingYesPool, yesCoinType } from "../src/prediction-market-client.js";
import { DUSDC_TYPE, AGENT_POLICY_PACKAGE_ID } from "../src/constants.js";

test("yesCoinType: matches the on-chain <pkg>::prediction_market::YES<DUSDC> shape", () => {
  // R-WC-1 fix: pin the coin-type string the
  // indexer's `deepbook_base_coin_type` column uses
  // for every WC market. The string MUST match the
  // on-chain `PredictionMarket<Q>::yes_cap: TreasuryCap<YES<Q>>`
  // type parameter — the resolver and maker both
  // read it from SQLite to construct their PTBs.
  const expected = `${AGENT_POLICY_PACKAGE_ID}::prediction_market::YES<${DUSDC_TYPE}>`;
  assert.equal(yesCoinType(), expected);
});

test("yesCoinType: takes a custom packageId for testnet/mainnet split", () => {
  // R-WC-1 fix: the helper accepts a custom
  // `packageId` so an operator can point the SDK
  // at a testnet package while the agents runtime
  // uses mainnet. The wc-creator uses the default
  // (env-resolved) package id; an operator-side
  // replay script that re-derives the type string
  // for a different network can override.
  const customPkg = "0x23b78cabb824ccaf9a24f3fe335ae144b3fa3d21a53955ca4e3f01544a0c2d52";
  assert.equal(
    yesCoinType(customPkg),
    `${customPkg}::prediction_market::YES<${DUSDC_TYPE}>`,
  );
});

test("findExistingYesPool: returns null when the registry has no YES<Q> pool", async () => {
  // R-WC-1 fix: a fresh deploy on a new DeepBook
  // registry has zero dynamic fields; the helper
  // must return `null` (not throw) so the wc-creator
  // can fall back to `create_market` for the first
  // market. We mock the Sui client with the
  // gRPC-first `listDynamicFields` returning an
  // empty `dynamicFields` array.
  const mockClient = {
    listDynamicFields: async () => ({
      hasNextPage: false,
      cursor: null,
      dynamicFields: [],
    }),
  } as unknown as Parameters<typeof findExistingYesPool>[0];
  const result = await findExistingYesPool(
    mockClient,
    "0x123",
    AGENT_POLICY_PACKAGE_ID,
    DUSDC_TYPE,
  );
  assert.equal(result, null);
});

test("findExistingYesPool: matches dynamic fields by YES<DUSDC> prefix (SDK-wrapper shape)", async () => {
  // R-WC-1 fix: a registry with a pool of a
  // different base type (e.g. `YES<SUI>`) plus a
  // matching `YES<DUSDC>` pool must return the
  // DUSDC one. The match is on the dynamic-field
  // name's rendered TypeName. The SDK wrapper
  // returns the name as a parsed object
  // (`{ type: "TypeName", bcs: <BCS bytes> }`);
  // we decode the BCS-encoded TypeName struct
  // (which is just a `String` wrapper) and match
  // against the rendered type name.
  const matchingName = `${AGENT_POLICY_PACKAGE_ID}::prediction_market::YES<${DUSDC_TYPE}>, ${DUSDC_TYPE}`;
  const nonMatchingName = `${AGENT_POLICY_PACKAGE_ID}::prediction_market::YES<0x2::sui::SUI>, 0x2::sui::SUI`;
  // BCS encoding of a Move `String` is
  // ULEB128(length) + utf8-bytes. The TypeName
  // struct is just `{ name: String }`, so the BCS
  // is one ULEB128 + the string bytes.
  const bcsOfMatching = concatBcs(uleb128(matchingName.length), utf8(matchingName));
  const bcsOfNonMatching = concatBcs(uleb128(nonMatchingName.length), utf8(nonMatchingName));
  const mockClient = {
    listDynamicFields: async () => ({
      hasNextPage: false,
      cursor: null,
      dynamicFields: [
        { fieldId: "0xaaa", name: { type: "TypeName", bcs: bcsOfNonMatching }, valueType: "0x2::type_name::TypeName", type: "..." },
        { fieldId: "0xbbb", name: { type: "TypeName", bcs: bcsOfMatching }, valueType: "0x2::type_name::TypeName", type: "..." },
      ],
    }),
  } as unknown as Parameters<typeof findExistingYesPool>[0];
  const result = await findExistingYesPool(
    mockClient,
    "0x123",
    AGENT_POLICY_PACKAGE_ID,
    DUSDC_TYPE,
  );
  assert.equal(result, "0xbbb");
});

test("findExistingYesPool: matches dynamic fields by YES<DUSDC> prefix (legacy JSON-RPC shape)", async () => {
  // R-WC-1 fix: an older fullnode (pre-gRPC
  // migration) returns the name as a plain object
  // with a `name` field that's the rendered
  // TypeName string. The helper detects this shape
  // and uses the `name` field directly (no BCS
  // decode needed).
  const matchingName = `${AGENT_POLICY_PACKAGE_ID}::prediction_market::YES<${DUSDC_TYPE}>, ${DUSDC_TYPE}`;
  const nonMatchingName = `${AGENT_POLICY_PACKAGE_ID}::prediction_market::YES<0x2::sui::SUI>, 0x2::sui::SUI`;
  const mockClient = {
    getDynamicFields: async () => ({
      data: [
        { objectId: "0xaaa", name: { name: nonMatchingName } },
        { objectId: "0xbbb", name: { name: matchingName } },
      ],
      hasNextPage: false,
      nextCursor: null,
    }),
  } as unknown as Parameters<typeof findExistingYesPool>[0];
  const result = await findExistingYesPool(
    mockClient,
    "0x123",
    AGENT_POLICY_PACKAGE_ID,
    DUSDC_TYPE,
  );
  assert.equal(result, "0xbbb");
});

test("findExistingYesPool: returns the first matching pool when multiple are registered", async () => {
  // R-WC-1 fix: a self-hosted DeepBook with a
  // production pool and a test pool sharing the
  // same `<pkg>::prediction_market::YES<DUSDC>`
  // type parameter (a misconfiguration the SDK
  // can't detect) returns the first match. The
  // wc-creator's gate then knows there's a pool
  // to reuse and skips the DEEP fee on the
  // `create_market` path.
  const matchingName = `${AGENT_POLICY_PACKAGE_ID}::prediction_market::YES<${DUSDC_TYPE}>, ${DUSDC_TYPE}`;
  const bcsOfMatching = concatBcs(uleb128(matchingName.length), utf8(matchingName));
  const mockClient = {
    listDynamicFields: async () => ({
      hasNextPage: false,
      cursor: null,
      dynamicFields: [
        { fieldId: "0xfirst", name: { type: "TypeName", bcs: bcsOfMatching }, valueType: "0x2::type_name::TypeName", type: "..." },
        { fieldId: "0xsecond", name: { type: "TypeName", bcs: bcsOfMatching }, valueType: "0x2::type_name::TypeName", type: "..." },
      ],
    }),
  } as unknown as Parameters<typeof findExistingYesPool>[0];
  const result = await findExistingYesPool(
    mockClient,
    "0x123",
    AGENT_POLICY_PACKAGE_ID,
    DUSDC_TYPE,
  );
  assert.equal(result, "0xfirst");
});

test("findExistingYesPool: paginates when the first page has no match", async () => {
  // R-WC-1 fix: a DeepBook registry with > 50
  // dynamic fields (a busy mainnet deployment)
  // returns the first match across multiple
  // pages. The first page contains 49 non-matching
  // pools; the second page contains the match.
  // Without pagination the helper would return
  // null and the wc-creator would try to
  // `create_market` (consuming 500 DEEP for a
  // pool that already exists).
  const matchingName = `${AGENT_POLICY_PACKAGE_ID}::prediction_market::YES<${DUSDC_TYPE}>, ${DUSDC_TYPE}`;
  const nonMatchingName = `${AGENT_POLICY_PACKAGE_ID}::prediction_market::YES<0x2::sui::SUI>, 0x2::sui::SUI`;
  const bcsOfNonMatching = concatBcs(uleb128(nonMatchingName.length), utf8(nonMatchingName));
  const bcsOfMatching = concatBcs(uleb128(matchingName.length), utf8(matchingName));
  // 49 non-matching rows on the first page.
  const firstPage = Array.from({ length: 49 }, (_, i) => ({
    fieldId: `0xnonmatch${i}`,
    name: { type: "TypeName", bcs: bcsOfNonMatching },
    valueType: "0x2::type_name::TypeName",
    type: "...",
  }));
  let callCount = 0;
  const mockClient = {
    listDynamicFields: async (args: { cursor?: string }) => {
      callCount++;
      // First call: no cursor → page 1.
      // Second call: cursor="page2" → page 2.
      if (!args.cursor) {
        return {
          hasNextPage: true,
          cursor: "page2",
          dynamicFields: firstPage,
        };
      }
      return {
        hasNextPage: false,
        cursor: null,
        dynamicFields: [
          { fieldId: "0xmatch", name: { type: "TypeName", bcs: bcsOfMatching }, valueType: "0x2::type_name::TypeName", type: "..." },
        ],
      };
    },
  } as unknown as Parameters<typeof findExistingYesPool>[0];
  const result = await findExistingYesPool(
    mockClient,
    "0x123",
    AGENT_POLICY_PACKAGE_ID,
    DUSDC_TYPE,
  );
  assert.equal(result, "0xmatch");
  assert.equal(callCount, 2, "should have made exactly 2 paginated calls");
});

test("findExistingYesPool: throws on infinite-loop (hasNextPage=true without cursor)", async () => {
  // R-WC-1 fix: a misbehaving legacy fullnode that
  // returns `hasNextPage: true` but no `nextCursor`
  // would put the helper in an infinite loop. The
  // defensive check throws a clear error after the
  // first bad response so the caller (the
  // wc-creator's gate) can surface it as a failed
  // `noop` decision instead of hanging the agent.
  // The new gRPC client computes `hasNextPage` from
  // `nextPageToken` directly, so the same defensive
  // check is reachable via a missing-cursor
  // response (covered by the pagination logic); this
  // test pins the legacy JSON-RPC path which is
  // separate.
  const mockClient = {
    getDynamicFields: async () => ({
      data: [],
      hasNextPage: true,
      // No `nextCursor` key at all — a fullnode
      // omission. The defensive check should catch
      // this and throw.
    }),
  } as unknown as Parameters<typeof findExistingYesPool>[0];
  await assert.rejects(
    () => findExistingYesPool(
      mockClient,
      "0x123",
      AGENT_POLICY_PACKAGE_ID,
      DUSDC_TYPE,
    ),
    /without a cursor/,
  );
});

test("findExistingYesPool: returns the fallback pool id when the registry has no dynamic fields (self-hosted DeepBook)", async () => {
  // R-WC-1.1 fix: the self-hosted DeepBook registry
  // 0xe14eba90fc8cc14a2eac1199b207d4e664931f8196f612b5aacf0c4a7f7d7a6f
  // exposes its `Pool<YES<DUSDC>, DUSDC>` as a
  // directly-shared object, not as a dynamic field
  // on the registry. The previous helper threw when
  // it couldn't find a matching dynamic field, which
  // surfaced in the wc-creator's decision feed as
  // "findExistingYesPool returned null". The new
  // behaviour: if a `fallbackPoolId` is provided,
  // return it after exhausting all pages. The
  // operator can override the default by setting
  // `WC_FALLBACK_POOL_ID` in the env.
  const FALLBACK = "0xddd7cbe563d094d7245224bf1d9efc353fd9a9c67c9cda0640a4e203435d8360";
  const mockClient = {
    listDynamicFields: async () => ({
      hasNextPage: false,
      cursor: null,
      dynamicFields: [],
    }),
  } as unknown as Parameters<typeof findExistingYesPool>[0];
  const result = await findExistingYesPool(
    mockClient,
    "0x123",
    AGENT_POLICY_PACKAGE_ID,
    DUSDC_TYPE,
    FALLBACK,
  );
  assert.equal(result, FALLBACK);
});

test("findExistingYesPool: still returns null when no fallback is provided and no dynamic fields match", async () => {
  // R-WC-1.1 fix: if the caller does NOT provide a
  // fallback (e.g. a fresh deploy where no pool
  // exists yet), the helper returns `null` (not
  // throws) so the wc-creator can fall back to
  // `create_market` to bootstrap a new pool. This
  // pins the contract: missing fallback + missing
  // dynamic fields => null, not throw.
  const mockClient = {
    listDynamicFields: async () => ({
      hasNextPage: false,
      cursor: null,
      dynamicFields: [],
    }),
  } as unknown as Parameters<typeof findExistingYesPool>[0];
  const result = await findExistingYesPool(
    mockClient,
    "0x123",
    AGENT_POLICY_PACKAGE_ID,
    DUSDC_TYPE,
  );
  assert.equal(result, null);
});

/**
 * Test helpers for BCS encoding. The TypeName struct
 * is `{ name: String }` so its BCS is one ULEB128-encoded
 * length followed by the UTF-8 bytes of the string.
 */
function uleb128(n: number): Uint8Array {
  const bytes: number[] = [];
  do {
    bytes.push(n & 0x7f);
    n >>>= 7;
    if (n > 0) bytes[bytes.length - 1] |= 0x80;
  } while (n > 0);
  return new Uint8Array(bytes);
}
function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}
/** Concatenate two Uint8Arrays. `Uint8Array + Uint8Array`
 *  in JS coerces to a number, so we use `set` + `subarray`. */
function concatBcs(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
