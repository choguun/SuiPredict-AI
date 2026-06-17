// R-WC-1.3 regression test: the
// `createDeepBookClient` and
// `buildDeepBookCreateBalanceManagerTx` builders must
// throw a friendly error when DEEPBOOK_PACKAGE_ID is
// not configured. Pre-fix, an empty `DEEPBOOK_PACKAGE_ID`
// silently propagated into the
// `shareBalanceManager` moveCall's `typeArguments`
// (`${DEEPBOOK_PACKAGE_ID}::balance_manager::BalanceManager`),
// which the on-chain BCS resolver rejected with the
// cryptic
// "Encountered unexpected token when parsing type args for ::balance_manager::BalanceManager"
// error every time a user clicked "Setup Trading Account".
// The fix: throw a clear "set NEXT_PUBLIC_DEEPBOOK_PACKAGE_ID"
// message at the SDK boundary, before any PTB is built.

import test from "node:test";
import assert from "node:assert/strict";

import {
  createDeepBookClient,
  buildDeepBookCreateBalanceManagerTx,
} from "../src/deepbook/client.js";

function withCleanEnv<T>(fn: () => T): T {
  const originalPkg = process.env.NEXT_PUBLIC_DEEPBOOK_PACKAGE_ID;
  const originalNoPrefix = process.env.DEEPBOOK_PACKAGE_ID;
  delete process.env.NEXT_PUBLIC_DEEPBOOK_PACKAGE_ID;
  delete process.env.DEEPBOOK_PACKAGE_ID;
  try {
    return fn();
  } finally {
    if (originalPkg !== undefined) process.env.NEXT_PUBLIC_DEEPBOOK_PACKAGE_ID = originalPkg;
    if (originalNoPrefix !== undefined) process.env.DEEPBOOK_PACKAGE_ID = originalNoPrefix;
  }
}

test("createDeepBookClient: throws a clear 'set NEXT_PUBLIC_DEEPBOOK_PACKAGE_ID' error when env is unset", () => {
  withCleanEnv(() => {
    assert.throws(
      () =>
        createDeepBookClient(
          // Cast through `unknown` because we don't need a
          // real SuiGrpcClient for this test — the
          // pre-flight fires before any RPC is made.
          {} as unknown as Parameters<typeof createDeepBookClient>[0],
          "0x" + "1".repeat(64),
        ),
      /DEEPBOOK_PACKAGE_ID is not configured/,
    );
  });
});

test("createDeepBookClient: error message names the env var so the operator can grep for it", () => {
  withCleanEnv(() => {
    try {
      createDeepBookClient(
        {} as unknown as Parameters<typeof createDeepBookClient>[0],
        "0x" + "1".repeat(64),
      );
      assert.fail("should have thrown");
    } catch (e) {
      const msg = (e as Error).message;
      // The error message must mention the env var
      // name (so an operator who hits this in the
      // web's wallet spinner can grep their
      // .env.local and find the missing line) AND
      // the testnet default id (so they have a
      // known-good value to paste).
      assert.match(msg, /NEXT_PUBLIC_DEEPBOOK_PACKAGE_ID/);
      assert.match(msg, /0xc93ae840671495202260c7afb93c820bf11c081b884b660106399208871dec5a/);
    }
  });
});

test("createDeepBookClient: respects explicit options.packageIds.DEEPBOOK_PACKAGE_ID even when env is unset", () => {
  // The `packageIds` option is the SDK's documented
  // escape hatch for callers that build the client
  // programmatically (e.g. a test fixture that
  // doesn't go through env). The pre-flight must
  // accept this path and not throw.
  withCleanEnv(() => {
    const explicitPkg = "0x" + "9".repeat(64);
    assert.doesNotThrow(() =>
      createDeepBookClient(
        {} as unknown as Parameters<typeof createDeepBookClient>[0],
        "0x" + "1".repeat(64),
        {},
        { packageIds: { DEEPBOOK_PACKAGE_ID: explicitPkg } },
      ),
    );
  });
});

test("buildDeepBookCreateBalanceManagerTx: redundant guard fires when env is unset", () => {
  // The pre-flight in `createDeepBookClient` is
  // the primary check, but the
  // `buildDeepBookCreateBalanceManagerTx` builder
  // has its own guard for callers that construct
  // the DeepBookClient via a custom path (e.g. a
  // test that bypasses the factory).
  withCleanEnv(() => {
    // The mock client is the minimum shape the
    // builder needs to call the underlying API
    // methods. We don't actually call the API
    // because the guard fires first.
    const mockClient = {
      balanceManager: {
        createBalanceManagerWithOwner: () => () => ({} as unknown),
        shareBalanceManager: () => () => undefined,
      },
    } as unknown as Parameters<typeof buildDeepBookCreateBalanceManagerTx>[0];
    assert.throws(
      () => buildDeepBookCreateBalanceManagerTx(mockClient, "0x" + "1".repeat(64)),
      /DEEPBOOK_PACKAGE_ID is not configured/,
    );
  });
});
