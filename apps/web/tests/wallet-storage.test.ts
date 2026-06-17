// Unit tests for the disconnect-aware localStorage wrapper
// used by the dapp-kit `createDAppKit` call.
//
// The dapp-kit's `autoConnect` initializer reads the
// "selected wallet + address" cookie on mount and silently
// re-binds the previously authorised account. The pre-fix
// build had `autoConnect: false` to prevent the wallet
// extension's own session from re-binding after a
// user-initiated disconnect (R48 audit). The fix restores
// `autoConnect: true` and routes the dapp-kit storage
// through `createDisconnectAwareStorage`, which stamps a
// `suipredict:wallet-disconnected` flag in localStorage
// whenever `removeItem` is called on the dapp-kit cookie.
// While the flag is set, `getItem` returns null so the
// autoConnect initializer bails out. `setItem` clears the
// flag so any subsequent reconnect (manual or
// autoConnect-driven) restores the normal flow.
//
// We run with the built-in `node:test` runner (no deps) and
// a minimal `localStorage` shim that simulates a browser
// KV store. Run with:
//
//   cd apps/web && node --import tsx --test tests/wallet-storage.test.ts

import test from "node:test";
import assert from "node:assert/strict";

// Minimal localStorage shim that mirrors the small surface
// area `wallet-storage.ts` uses. Throws on `setItem` if
// `quotaExceeded` is true, to verify the try/catch wrappers
// don't bubble quota errors.
class FakeStorage {
  private store = new Map<string, string>();
  public quotaExceeded = false;

  getItem(key: string): string | null {
    return this.store.has(key) ? (this.store.get(key) as string) : null;
  }

  setItem(key: string, value: string): void {
    if (this.quotaExceeded) {
      const err = new Error("QuotaExceededError");
      (err as Error & { name: string }).name = "QuotaExceededError";
      throw err;
    }
    this.store.set(key, value);
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }

  get size(): number {
    return this.store.size;
  }
}

// Install the shim before importing the module under test.
// The wrapper reads `window.localStorage` lazily (only when
// its methods fire), so we can install `window` first and
// then import.
const fakeStorage = new FakeStorage();
const fakeWindow = {
  localStorage: fakeStorage as unknown as Storage,
} as unknown as typeof globalThis;
(globalThis as unknown as { window: typeof globalThis }).window =
  fakeWindow;

import {
  createDisconnectAwareStorage,
  DAPP_KIT_STORAGE_KEY,
  DISCONNECT_FLAG_KEY,
} from "../lib/wallet-storage.js";

function makeStorage() {
  // Each test starts with a clean storage so the disconnect
  // flag from a prior test doesn't leak across cases.
  fakeStorage.clear();
  fakeStorage.quotaExceeded = false;
  return createDisconnectAwareStorage();
}

test("getItem returns null when the cookie is missing and no flag is set", () => {
  const storage = makeStorage();
  assert.equal(storage.getItem(DAPP_KIT_STORAGE_KEY), null);
  assert.equal(fakeStorage.getItem(DISCONNECT_FLAG_KEY), null);
});

test("setItem stores the value and clears the disconnect flag (autoConnect-friendly)", () => {
  const storage = makeStorage();

  // Simulate a prior disconnect by stamping the flag
  // directly. This mimics the state after
  // `disconnectWallet()` ran in a previous session.
  fakeStorage.setItem(DISCONNECT_FLAG_KEY, "1");

  // While the flag is set, getItem returns null
  // (autoConnect bails out).
  assert.equal(storage.getItem(DAPP_KIT_STORAGE_KEY), null);

  // Now simulate the user reconnecting (e.g. clicking
  // "Connect Wallet" → dappKit.connectWallet → saveAccountToStorage
  // → setItem on the dapp-kit cookie).
  storage.setItem(DAPP_KIT_STORAGE_KEY, "wallet:0xabc:transfer");

  // The cookie is now stored…
  assert.equal(
    fakeStorage.getItem(DAPP_KIT_STORAGE_KEY),
    "wallet:0xabc:transfer",
  );
  // …and the disconnect flag has been cleared, so the
  // *next* refresh can auto-reconnect.
  assert.equal(fakeStorage.getItem(DISCONNECT_FLAG_KEY), null);
  // getItem now returns the cookie normally (no null
  // because of the flag).
  assert.equal(
    storage.getItem(DAPP_KIT_STORAGE_KEY),
    "wallet:0xabc:transfer",
  );
});

test("removeItem sets the disconnect flag so the next refresh stays disconnected", () => {
  const storage = makeStorage();

  // Simulate a previously-connected state by writing the
  // cookie directly. The user has an active session.
  fakeStorage.setItem(DAPP_KIT_STORAGE_KEY, "wallet:0xabc:transfer");

  // The user clicks Disconnect → dappKit.disconnectWallet
  // → storage.removeItem(storageKey).
  storage.removeItem(DAPP_KIT_STORAGE_KEY);

  // The dapp-kit cookie is gone…
  assert.equal(fakeStorage.getItem(DAPP_KIT_STORAGE_KEY), null);
  // …and the disconnect flag is set, so the next refresh
  // sees getItem return null and skips auto-reconnect.
  assert.equal(fakeStorage.getItem(DISCONNECT_FLAG_KEY), "1");
  assert.equal(storage.getItem(DAPP_KIT_STORAGE_KEY), null);
});

test("autoConnect round-trip: cookie → disconnect → refresh-stays-off → reconnect → refresh-stays-on", () => {
  const storage = makeStorage();

  // 1. First-ever connect: cookie written, no flag yet.
  storage.setItem(DAPP_KIT_STORAGE_KEY, "wallet1:0xaaa:transfer");
  assert.equal(fakeStorage.getItem(DISCONNECT_FLAG_KEY), null);
  assert.equal(storage.getItem(DAPP_KIT_STORAGE_KEY), "wallet1:0xaaa:transfer");

  // 2. Page refresh (no flag, no removeItem): cookie
  //    visible to autoConnect → silent reconnect works.
  //    We simulate this by re-reading the cookie via the
  //    storage wrapper.
  assert.equal(storage.getItem(DAPP_KIT_STORAGE_KEY), "wallet1:0xaaa:transfer");

  // 3. User clicks Disconnect.
  storage.removeItem(DAPP_KIT_STORAGE_KEY);
  assert.equal(fakeStorage.getItem(DISCONNECT_FLAG_KEY), "1");

  // 4. Page refresh (flag is set): getItem returns null →
  //    autoConnect bails out, page shows Connect Wallet.
  assert.equal(storage.getItem(DAPP_KIT_STORAGE_KEY), null);

  // 5. User clicks "Connect Wallet" with a different wallet.
  storage.setItem(DAPP_KIT_STORAGE_KEY, "wallet2:0xbbb:transfer");
  assert.equal(fakeStorage.getItem(DISCONNECT_FLAG_KEY), null);

  // 6. Page refresh (no flag again): cookie is visible,
  //    autoConnect reconnects to wallet2.
  assert.equal(storage.getItem(DAPP_KIT_STORAGE_KEY), "wallet2:0xbbb:transfer");
});

test("switchAccount path: setItem on the cookie clears the flag without going through removeItem", () => {
  const storage = makeStorage();

  // Simulate an active session.
  fakeStorage.setItem(DAPP_KIT_STORAGE_KEY, "wallet1:0xaaa:transfer");

  // User clicks Disconnect, then later decides to come
  // back and switches accounts within the same wallet
  // (dapp-kit's switchAccount calls saveAccountToStorage,
  // which is setItem — not removeItem).
  storage.removeItem(DAPP_KIT_STORAGE_KEY);
  assert.equal(fakeStorage.getItem(DISCONNECT_FLAG_KEY), "1");

  // First reconnect.
  storage.setItem(DAPP_KIT_STORAGE_KEY, "wallet1:0xaaa:transfer");
  assert.equal(fakeStorage.getItem(DISCONNECT_FLAG_KEY), null);

  // Then switchAccount writes a new address — flag stays
  // cleared (no spurious disconnect).
  storage.setItem(DAPP_KIT_STORAGE_KEY, "wallet1:0xbbb:transfer");
  assert.equal(fakeStorage.getItem(DISCONNECT_FLAG_KEY), null);
  assert.equal(storage.getItem(DAPP_KIT_STORAGE_KEY), "wallet1:0xbbb:transfer");
});

test("setItem on an unrelated key does not clear the disconnect flag", () => {
  const storage = makeStorage();

  // Stamp the flag, simulating a user who just
  // disconnected.
  storage.removeItem(DAPP_KIT_STORAGE_KEY);
  assert.equal(fakeStorage.getItem(DISCONNECT_FLAG_KEY), "1");

  // A separate module writes to its own cookie.
  storage.setItem("some-other-key", "some-other-value");

  // The flag must still be set so the next refresh stays
  // disconnected. (Only writes to the dapp-kit cookie
  // should clear it.)
  assert.equal(fakeStorage.getItem(DISCONNECT_FLAG_KEY), "1");
});

test("removeItem on an unrelated key does not set the disconnect flag", () => {
  const storage = makeStorage();

  // Pre-condition: no flag.
  assert.equal(fakeStorage.getItem(DISCONNECT_FLAG_KEY), null);

  // A separate module clears its own cookie.
  storage.removeItem("some-other-key");

  // Flag must still be unset — only the dapp-kit
  // disconnect flow should set it.
  assert.equal(fakeStorage.getItem(DISCONNECT_FLAG_KEY), null);
});

test("setItem survives localStorage quota errors without throwing", () => {
  const storage = makeStorage();
  fakeStorage.quotaExceeded = true;

  // Should swallow the QuotaExceededError silently rather
  // than bubble it up to the dapp-kit caller (a private-
  // mode browser would otherwise crash the connect
  // handler).
  assert.doesNotThrow(() =>
    storage.setItem(DAPP_KIT_STORAGE_KEY, "wallet:0xabc"),
  );

  // The cookie wasn't actually written (quota blocked it),
  // so getItem returns null.
  assert.equal(storage.getItem(DAPP_KIT_STORAGE_KEY), null);
});

test("getItem returns null when localStorage throws (private mode)", () => {
  const storage = makeStorage();
  fakeStorage.setItem(DAPP_KIT_STORAGE_KEY, "wallet:0xabc:transfer");

  // Replace localStorage.getItem with one that throws
  // (simulates Safari private mode on a fresh tab).
  const originalGetItem = fakeStorage.getItem.bind(fakeStorage);
  fakeStorage.getItem = () => {
    throw new Error("SecurityError");
  };

  try {
    // The wrapper catches the error and returns null —
    // callers see the same surface as a missing cookie.
    assert.equal(storage.getItem(DAPP_KIT_STORAGE_KEY), null);
  } finally {
    fakeStorage.getItem = originalGetItem;
  }
});