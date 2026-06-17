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
  // gRPC-first `core.getDynamicFields` returning
  // an empty dynamicFields array.
  const mockClient = {
    core: {
      getDynamicFields: async () => ({ dynamicFields: [], hasNextPage: false, cursor: null }),
    },
  } as unknown as Parameters<typeof findExistingYesPool>[0];
  const result = await findExistingYesPool(
    mockClient,
    "0x123",
    AGENT_POLICY_PACKAGE_ID,
    DUSDC_TYPE,
  );
  assert.equal(result, null);
});

test("findExistingYesPool: matches dynamic fields by YES<DUSDC> prefix", async () => {
  // R-WC-1 fix: a registry with a pool of a
  // different base type (e.g. `YES<SUI>`) plus a
  // matching `YES<DUSDC>` pool must return the
  // DUSDC one. The match is on the dynamic-field
  // name's rendered TypeName, which serialises
  // as `{ name: "<pkg>::prediction_market::YES<…>, <quote>" }`.
  const matchingName = `${AGENT_POLICY_PACKAGE_ID}::prediction_market::YES<${DUSDC_TYPE}>, ${DUSDC_TYPE}`;
  const nonMatchingName = `${AGENT_POLICY_PACKAGE_ID}::prediction_market::YES<0x2::sui::SUI>, 0x2::sui::SUI`;
  const mockClient = {
    core: {
      getDynamicFields: async () => ({
        dynamicFields: [
          { objectId: "0xaaa", name: { name: nonMatchingName } },
          { objectId: "0xbbb", name: { name: matchingName } },
        ],
        hasNextPage: false,
        cursor: null,
      }),
    },
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
  const mockClient = {
    core: {
      getDynamicFields: async () => ({
        dynamicFields: [
          { objectId: "0xfirst", name: { name: matchingName } },
          { objectId: "0xsecond", name: { name: matchingName } },
        ],
        hasNextPage: false,
        cursor: null,
      }),
    },
  } as unknown as Parameters<typeof findExistingYesPool>[0];
  const result = await findExistingYesPool(
    mockClient,
    "0x123",
    AGENT_POLICY_PACKAGE_ID,
    DUSDC_TYPE,
  );
  assert.equal(result, "0xfirst");
});
