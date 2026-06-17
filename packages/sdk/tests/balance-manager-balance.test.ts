/**
 * R-WC-1.8 regression test: `getBalanceManagerBalance`
 * parses the gRPC `core.simulateTransaction` response
 * correctly. Pre-fix, the helper used a `jsonRpc` field
 * that doesn't exist on the `SuiGrpcClient` returned
 * by the dapp-kit, so it silently returned 0n and the
 * Buy YES pre-flight always threw
 * `Insufficient DUSDC in your Trading Account: have 0.00`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { Transaction } from "@mysten/sui/transactions";
import { getBalanceManagerBalance } from "../src/deepbook/client.js";

function buildMockClient(returnValueBytes: string | null) {
  return {
    core: {
      simulateTransaction: async () => ({
        $kind: "Transaction",
        commandResults: [
          {
            returnValues: returnValueBytes
              ? [{ bcs: returnValueBytes }]
              : [],
          },
        ],
      }),
    },
  } as unknown as Parameters<typeof getBalanceManagerBalance>[0];
}

test("getBalanceManagerBalance: returns the u64 from a base64-encoded little-endian payload", async () => {
  // 1_000_000 atoms = 1 DUSDC (6 decimals).
  // little-endian u64: 0x40420f00_00000000 → base64 "QELwAAAAAAA=="
  const hex = "40420f0000000000";
  const b64 = Buffer.from(hex, "hex").toString("base64");
  const client = buildMockClient(b64);
  const balance = await getBalanceManagerBalance(
    client,
    "0x" + "5".repeat(64),
    "0x" + "d".repeat(64) + "::dusdc::DUSDC",
  );
  assert.equal(balance, 1_000_000n);
});

test("getBalanceManagerBalance: returns 0n when the BM has no balance for the coin", async () => {
  // Empty returnValues (BM exists but the BalanceKey<T> is absent;
  // the on-chain `balance` function returns 0).
  const client = buildMockClient(null);
  const balance = await getBalanceManagerBalance(
    client,
    "0x" + "5".repeat(64),
    "0x" + "d".repeat(64) + "::dusdc::DUSDC",
  );
  assert.equal(balance, 0n);
});

test("getBalanceManagerBalance: returns 0n on a FailedTransaction (e.g. BM doesn't exist)", async () => {
  // gRPC returns $kind === "FailedTransaction" when the
  // moveCall aborts (e.g. the BM id is invalid). The
  // helper must not throw — the caller expects a bigint.
  const client = {
    core: {
      simulateTransaction: async () => ({ $kind: "FailedTransaction" }),
    },
  } as unknown as Parameters<typeof getBalanceManagerBalance>[0];
  const balance = await getBalanceManagerBalance(
    client,
    "0x" + "5".repeat(64),
    "0x" + "d".repeat(64) + "::dusdc::DUSDC",
  );
  assert.equal(balance, 0n);
});

test("getBalanceManagerBalance: returns 0n when the RPC call throws (transient 429 / 503)", async () => {
  const client = {
    core: {
      simulateTransaction: async () => {
        throw new Error("HTTP 429 Too Many Requests");
      },
    },
  } as unknown as Parameters<typeof getBalanceManagerBalance>[0];
  const balance = await getBalanceManagerBalance(
    client,
    "0x" + "5".repeat(64),
    "0x" + "d".repeat(64) + "::dusdc::DUSDC",
  );
  assert.equal(balance, 0n);
});
