// Disconnect-aware wrapper around the localStorage
// adapter that the dapp-kit uses to persist the
// connected wallet session.
//
// Background
// ----------
// The dapp-kit's `autoConnect` initializer reads the
// "selected wallet + address" cookie on mount and silently
// re-binds the previously authorised account. The R48 audit
// in `apps/web/lib/dapp-kit.ts` had turned this off because
// some wallet extensions keep their own per-site
// authorisation cookie even after `disconnectWallet()` calls
// `standard:disconnect`, which made "Disconnect + Refresh"
// effectively a no-op.
//
// The standard dApp UX is the opposite: stay connected
// across refreshes, but if the user explicitly clicks
// Disconnect, the next refresh must NOT silently reconnect.
// We restore `autoConnect: true` and route the dapp-kit
// storage through this wrapper, which stamps a separate
// `suipredict:wallet-disconnected` flag whenever the
// dapp-kit calls `removeItem` on its cookie. While the flag
// is set, `getItem` returns null so the autoConnect
// initializer bails out. The flag is cleared on any
// subsequent `setItem` (connect, switchAccount, or the
// autoConnect path itself re-binding the account).
//
// Why a separate flag key
// -----------------------
// The dapp-kit's cookie shape is
// `<walletId>:<address>:<supportedIntents>`, encoded with a
// colon-separated delimiter. A future dapp-kit version that
// bumps the cookie shape (e.g. adds a 4th field) would still
// call `removeItem` on the same key, but our intent flag
// lives at a totally independent key, so a cookie-shape
// change can't accidentally clobber the user's "stay
// disconnected" intent.
//
// SSR / private-mode safety
// -------------------------
// The dapp-kit's `createDAppKit` call also runs at module
// load on the Next.js server, where `window` is undefined.
// Every localStorage call here is gated behind
// `typeof window !== "undefined"` and wrapped in try/catch
// (private-mode browsers throw on `setItem`).

export const DAPP_KIT_STORAGE_KEY =
  "mysten-dapp-kit:selected-wallet-and-address";

export const DISCONNECT_FLAG_KEY = "suipredict:wallet-disconnected";

export interface DisconnectAwareStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

function readDisconnectFlag(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(DISCONNECT_FLAG_KEY) === "1";
  } catch {
    return false;
  }
}

function setDisconnectFlag(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(DISCONNECT_FLAG_KEY, "1");
  } catch {
    /* private mode / quota — fall through silently */
  }
}

function clearDisconnectFlag(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(DISCONNECT_FLAG_KEY);
  } catch {
    /* private mode / quota — fall through silently */
  }
}

export function createDisconnectAwareStorage(): DisconnectAwareStorage {
  return {
    getItem(key) {
      // While the user-explicit disconnect flag is set,
      // pretend the dapp-kit cookie is missing. The
      // autoConnect initializer will skip the silent
      // reconnect and the page renders the "Connect
      // Wallet" CTA. The wallet extension's own session
      // is left untouched (we never call
      // `standard:disconnect` here — `disconnectWallet()`
      // already did that).
      if (key === DAPP_KIT_STORAGE_KEY && readDisconnectFlag()) {
        return null;
      }
      if (typeof window === "undefined") return null;
      try {
        return window.localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    setItem(key, value) {
      // Any successful write to the dapp-kit cookie means
      // the user has an active session again (manual
      // connect, switchAccount, or the autoConnect path
      // itself just re-bound the account). Drop the
      // disconnect flag so the *next* refresh
      // auto-reconnects again.
      if (key === DAPP_KIT_STORAGE_KEY) {
        clearDisconnectFlag();
      }
      if (typeof window === "undefined") return;
      try {
        window.localStorage.setItem(key, value);
      } catch {
        /* quota / private mode */
      }
    },
    removeItem(key) {
      // removeItem is only invoked by
      // `disconnectWallet()` (no other dapp-kit call site
      // clears the cookie). Stamp the disconnect flag so
      // the next page refresh sees `getItem` return null
      // and skips the silent reconnect.
      if (key === DAPP_KIT_STORAGE_KEY) {
        setDisconnectFlag();
      }
      if (typeof window === "undefined") return;
      try {
        window.localStorage.removeItem(key);
      } catch {
        /* quota / private mode */
      }
    },
  };
}