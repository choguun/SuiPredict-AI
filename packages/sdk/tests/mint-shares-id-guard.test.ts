// R-UAT-23 follow-up regression test: the
// `buildMintSharesTx` and `buildPlaceOrderTx` builders
// must throw a friendly error when given a
// non-Sui-shaped marketId (e.g. a SQLite-mirror
// `wc26-A1v4` namespace). The pre-fix code
// passed the value through to `normalizeObjectId`,
// which threw the raw
// `"wc26-A1v4" is not a valid Sui object id (expected 0x + 64 hex chars)`
// and the web page's error classifier rendered
// the same message verbatim as a toast, which the
// user (and the agents service log) saw as
// "object id shape error" rather than the actual
// problem ("this market has no on-chain id").
//
// The fix: pre-flight the id shape at the builder
// boundary and throw an error message that names
// the cause (SQLite-mirror demo row) and the fix
// (use `getMarket(id).onchain_market_id`).

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildMintSharesTx,
  buildPlaceOrderTx,
} from "../src/prediction-market-client.js";

const VALID = "0x" + "1".repeat(64);
const POOL = "0x" + "2".repeat(64);
const BM = "0x" + "3".repeat(64);
const COIN = "0x" + "4".repeat(64);

test("buildMintSharesTx: throws a friendly error for a wc26-* marketId", () => {
  assert.throws(
    () => buildMintSharesTx("wc26-A1v4", VALID, COIN, 1_000_000n),
    /wc26-A1v4.*not a valid Sui object id.*on-chain market id/s,
  );
});

test("buildMintSharesTx: throws a friendly error for a demo-* marketId", () => {
  assert.throws(
    () => buildMintSharesTx("demo-btc-100k", VALID, COIN, 1_000_000n),
    /demo-btc-100k.*not a valid Sui object id.*on-chain market id/s,
  );
});

test("buildMintSharesTx: throws a friendly error for a 0x + wrong-length hex", () => {
  assert.throws(
    () => buildMintSharesTx("0x1234", VALID, COIN, 1_000_000n),
    /0x1234.*not a valid Sui object id.*on-chain market id/s,
  );
});

test("buildMintSharesTx: throws a friendly error for a 0x + non-hex", () => {
  assert.throws(
    () => buildMintSharesTx("0xZZZ", VALID, COIN, 1_000_000n),
    /0xZZZ.*not a valid Sui object id.*on-chain market id/s,
  );
});

test("buildMintSharesTx: throws a friendly error for an empty marketId", () => {
  assert.throws(
    () => buildMintSharesTx("", VALID, COIN, 1_000_000n),
    /not a valid Sui object id.*on-chain market id/s,
  );
});

test("buildMintSharesTx: throws a friendly error for a bad vaultId", () => {
  assert.throws(
    () => buildMintSharesTx(VALID, "wc26-fee-vault", COIN, 1_000_000n),
    /vaultId.*not a valid Sui object id/s,
  );
});

test("buildMintSharesTx: throws a friendly error for a bad quoteIn", () => {
  assert.throws(
    () => buildMintSharesTx(VALID, VALID, "wc26-dusdc-coin", 1_000_000n),
    /quoteIn.*not a valid Sui object id/s,
  );
});

test("buildMintSharesTx: accepts a valid 0x + 64 hex marketId (no throw)", () => {
  // The pre-flight should NOT throw for a
  // real Sui id. The full Transaction object
  // would be built; the rest of the function
  // is fine to call (we just need to verify
  // the id shape check passes).
  const tx = buildMintSharesTx(VALID, VALID, COIN, 1_000_000n);
  assert.ok(tx, "Transaction should be returned for a valid id");
});

test("buildPlaceOrderTx: throws a friendly error for a wc26-* marketId", () => {
  assert.throws(
    () =>
      buildPlaceOrderTx({
        marketId: "wc26-A1v4",
        poolId: POOL,
        balanceManagerId: BM,
        clientOrderId: 0n,
        price: 1_000_000n,
        quantity: 1_000_000n,
        isBid: true,
      }),
    /wc26-A1v4.*not a valid Sui object id/s,
  );
});

test("buildPlaceOrderTx: throws a friendly error for a bad poolId", () => {
  assert.throws(
    () =>
      buildPlaceOrderTx({
        marketId: VALID,
        poolId: "wc26-pool",
        balanceManagerId: BM,
        clientOrderId: 0n,
        price: 1_000_000n,
        quantity: 1_000_000n,
        isBid: true,
      }),
    /poolId.*not a valid Sui object id/s,
  );
});

test("buildPlaceOrderTx: throws a friendly error for a bad balanceManagerId", () => {
  assert.throws(
    () =>
      buildPlaceOrderTx({
        marketId: VALID,
        poolId: POOL,
        balanceManagerId: "wc26-bm",
        clientOrderId: 0n,
        price: 1_000_000n,
        quantity: 1_000_000n,
        isBid: true,
      }),
    /balanceManagerId.*not a valid Sui object id/s,
  );
});

test("buildPlaceOrderTx: accepts valid 0x + 64 hex ids (no throw)", () => {
  const tx = buildPlaceOrderTx({
    marketId: VALID,
    poolId: POOL,
    balanceManagerId: BM,
    clientOrderId: 0n,
    price: 1_000_000n,
    quantity: 1_000_000n,
    isBid: true,
  });
  assert.ok(tx, "Transaction should be returned for valid ids");
});
