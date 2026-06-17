"use client";

import { createDAppKit } from "@mysten/dapp-kit-react";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import type { Transaction } from "@mysten/sui/transactions";
import {
  AGENT_POLICY_PACKAGE_ID,
  PREDICT_PACKAGE_ID,
} from "@suipredict/sdk";
import { createDisconnectAwareStorage } from "@/lib/wallet-storage";

// R34 audit fix: the dAppKit config was hard-coded to testnet, so
// `useCurrentClient()` (used by every page) returned a testnet
// client even on a mainnet deploy. A mainnet operator would see
// every transaction fail with "package object not found" or worse
// — silent type-mismatch aborts. Read the network from the env so
// the client tracks SUI_NETWORK like the rest of the stack.
//
// The env keys match the root `.env.example` and the agents-side
// `SUI_NETWORK` so a single value drives both the agents service
// and the web client. Falling back to testnet preserves the
// pre-R34 default for local dev; a production deploy is expected
// to set NEXT_PUBLIC_SUI_NETWORK explicitly.
//
// R38 audit fix: the previous code also read `process.env.SUI_NETWORK`
// (no NEXT_PUBLIC_ prefix) as a fallback. Only NEXT_PUBLIC_* vars
// are inlined into the browser bundle by Next.js — the bare
// `SUI_NETWORK` would always be `undefined` in the web runtime, so
// the fallback was dead code that gave the false impression of
// supporting a non-prefixed env. Drop it.
//
// R53 audit fix: validate the
// env value against the
// allowlist. The previous
// `as "testnet" | "mainnet" |
// "devnet"` cast accepted any
// string — a typo like
// `NEXT_PUBLIC_SUI_NETWORK=mantinet`
// (or a stale `localnet` from
// a dev deploy) would
// configure dAppKit for a
// non-existent network. The
// sibling allowlists at
// `app/admin/page.tsx:116-117`
// and
// `app/agents/page.tsx:107-108`
// already use the
// `.includes()` check; mirror
// the same pattern here.
const SUI_NETWORKS = ["testnet", "mainnet", "devnet"] as const;
type SuiNetwork = (typeof SUI_NETWORKS)[number];
const rawNetwork = process.env.NEXT_PUBLIC_SUI_NETWORK ?? "testnet";
const SUI_NETWORK: SuiNetwork = (SUI_NETWORKS as readonly string[]).includes(
  rawNetwork,
)
  ? (rawNetwork as SuiNetwork)
  : "testnet";
const FULLNODE_URL =
  process.env.NEXT_PUBLIC_SUI_RPC_URL ??
  (SUI_NETWORK === "mainnet"
    ? "https://fullnode.mainnet.sui.io:443"
    : SUI_NETWORK === "devnet"
      ? "https://fullnode.devnet.sui.io:443"
      : "https://fullnode.testnet.sui.io:443");

export const dAppKit = createDAppKit({
  networks: [SUI_NETWORK],
  defaultNetwork: SUI_NETWORK,
  createClient(network) {
    return new SuiGrpcClient({
      network,
      baseUrl: FULLNODE_URL,
    });
  },
  // R-Wallet-1 fix: restore the dapp-kit default
  // `autoConnect: true`. The pre-fix build set this to
  // `false` (R48 audit) because the wallet extension
  // silently re-binds the session from its own cookie
  // even after `disconnectWallet()` clears the dapp-kit
  // cookie, making "Disconnect + Refresh" effectively a
  // no-op. The user-facing behaviour we want is:
  //   • Open the site → silently reconnect to the
  //     previously authorised wallet (standard dApp UX,
  //     matches every other Sui wallet dApp).
  //   • Click Disconnect → next refresh stays
  //     disconnected, exactly as the user asked.
  // The `storage` wrapper below implements the second
  // guarantee by tracking an explicit disconnect flag
  // that makes `getItem(storageKey)` return null until
  // the user reconnects.
  autoConnect: true,
  storage: createDisconnectAwareStorage(),
});

export const PACKAGE_IDS = {
  predict: PREDICT_PACKAGE_ID,
  agentPolicy: AGENT_POLICY_PACKAGE_ID,
};

declare module "@mysten/dapp-kit-react" {
  interface Register {
    dAppKit: typeof dAppKit;
  }
}

/**
 * Local mirror of the dAppKit
 * `TransactionResultWithEffects` discriminated union.
 * The shape is `{ $kind: "Transaction", Transaction: { digest, ... } }`
 * or `{ $kind: "Failed" | "EffectsCert", ... }` — see the
 * dAppKit types for the upstream definition. Defined
 * here as a structural type so we don't depend on a
 * path that may move between dAppKit versions.
 */
interface TransactionResultLike {
  $kind: "Transaction" | "FailedTransaction" | "EffectsCert";
  Transaction?: { digest: string };
  FailedTransaction?: { digest?: string };
  [k: string]: unknown;
}

/**
 * Result of a `submitAndWait` call. Mirrors the
 * `TransactionResultWithEffects` discriminated union from
 * dAppKit but flattens the post-wait digest onto the
 * success variant so callers can render the digest
 * without a second type-narrow. See
 * https://sdk.mystenlabs.com/dapp-kit for the upstream
 * shape.
 */
export type SubmitResult =
  | { $kind: "Transaction"; digest: string }
  | { $kind: "FailedTransaction" | "EffectsCert"; digest?: string; error?: unknown };

/**
 * R51 audit fix: wrap `dAppKit.signAndExecuteTransaction`
 * to `await client.waitForTransaction` after a
 * successful sign.
 *
 * The previous flow at every call site was:
 *
 *   const r = await dAppKit.signAndExecuteTransaction({ transaction: tx });
 *   if (r.$kind === "Transaction") {
 *     toast.success(`… ${r.Transaction.digest.slice(0, 16)}`);
 *     // ← no wait. invalidateQueries fires immediately
 *     // and the React Query refetch races the on-chain
 *     // finalization. A slow RPC (or a node that hasn't
 *     // seen the tx yet) returns the old balance for
 *     // ~1-2s, and the user sees a stale portfolio.
 *   }
 *
 * `submitAndWait` adds an explicit
 * `client.waitForTransaction({ digest, timeout: 30_000 })`
 * after a successful sign, so the next `invalidateQueries`
 * hits a node that has already finalized the tx. The
 * timeout is 30s — Sui's BFT finality is ~3-5s in
 * practice, so 30s is 6-10x the typical wait and only
 * fires on a real outage. The legacy
 * `app/legacy/predict/trade/page.tsx:103` is the only
 * pre-R51 call site that already did the right thing
 * (wait, then invalidate); every modern flow
 * (markets/[id], parlay, vault, settings, admin) is
 * fixed in this round.
 */
export async function submitAndWait(
  // The `dAppKit` is the singleton created above;
  // pass the `useDAppKit()` value from the component
  // so tests can swap it.
  dappKit: { signAndExecuteTransaction: (args: { transaction: Transaction }) => Promise<TransactionResultLike> },
  // The `client` is the `useCurrentClient()` result;
  // it carries the `waitForTransaction` helper bound
  // to the user's current network.
  client: { waitForTransaction: (args: { digest: string; timeout?: number; signal?: AbortSignal }) => Promise<unknown> },
  tx: Transaction,
  options?: { timeoutMs?: number; signal?: AbortSignal },
): Promise<SubmitResult> {
  const r = await dappKit.signAndExecuteTransaction({ transaction: tx });
  if (r.$kind !== "Transaction") {
    // R55 audit fix: surface the underlying Move-abort
    // message in `error` so call sites that run
    // `friendlyMoveError(err, "Mint")` (R47 helper) can
    // still pattern-match on the abort module. The
    // dapp-kit FailedTransaction nests the abort as
    // `r.FailedTransaction.status.error.message`; without
    // this unwrap the helper would receive
    // `[object Object]` and fall through to the generic
    // "Mint failed on-chain" toast.
    const failed = (r as { FailedTransaction?: { status?: { success: false; error?: { message?: string } } | { success: true } } }).FailedTransaction;
    const abortMsg = failed?.status && failed.status.success === false
      ? failed.status.error?.message
      : undefined;
    return {
      $kind: r.$kind as "FailedTransaction" | "EffectsCert",
      error: abortMsg ? new Error(abortMsg) : undefined,
    };
  }
  const digest = r.Transaction?.digest;
  if (!digest) {
    // The $kind narrows to Transaction but the
    // Transaction object is missing — a contract
    // violation from the SDK. Surface a failure
    // rather than NPE.
    return { $kind: "FailedTransaction", error: new Error("missing digest on Transaction result") };
  }
  try {
    await client.waitForTransaction({
      digest,
      timeout: options?.timeoutMs ?? 30_000,
      signal: options?.signal,
    });
  } catch (err) {
    // The tx has been signed and accepted (the wallet
    // returned a digest). The wait may time out only
    // on a real RPC outage. Return the digest so the
    // caller can still show a "submitted, will land
    // shortly" toast rather than "failed". The
    // follow-up `invalidateQueries` will still fire
    // and pick up the tx once the RPC is back.
    console.warn(`[submitAndWait] waitForTransaction(${digest}) failed:`, err);
  }
  return { $kind: "Transaction", digest };
}
