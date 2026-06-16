"use client";

/**
 * Self-hosted DUSDC faucet button.
 *
 * Background: Sui's official testnet faucet
 * (https://faucet.sui.io/) mints SUI for gas, but NOT the
 * protocol's DUSDC. A fresh user landing on the trade panel
 * needs DUSDC collateral before they can mint YES+NO shares,
 * and the only path on a self-hosted DeepBook V3 deploy is
 * through the protocol's own TreasuryCap.
 *
 * The agents service exposes a /faucet/info + /faucet/dusdc
 * pair (see `apps/agents/src/faucet.ts`) that mints DUSDC to a
 * given Sui address. This component:
 *
 *   1. Reads /faucet/info on mount to know if the faucet is
 *      enabled + configured. If not, render a state-appropriate
 *      "Faucet disabled" hint instead of the action button.
 *   2. On click, POSTs to /faucet/dusdc with the connected
 *      wallet's address (or the explicit `recipient` prop).
 *   3. On success, toasts the digest and dispatches a
 *      `faucet-mint` window event so the markets/[id] page's
 *      DUSDC pre-flight re-runs (R51 pattern — the same
 *      window event bus that `ConnectModal` uses to fire the
 *      connect modal).
 *   4. On rate-limit (429), surfaces the `Retry-After` header
 *      so the user sees a real countdown instead of "try
 *      again later".
 *   5. On "insufficient SUI" (502 from the agent), surfaces a
 *      clear "operator needs to top up the agent" hint.
 *
 * Two visual variants:
 *   - `variant="primary"`: full CTA card with title, balance
 *     preview, and a single button. Used in the ConnectModal
 *     and the markets/[id] "no DUSDC" empty state.
 *   - `variant="compact"`: inline button, used inside the
 *     trade panel's collateral card.
 *
 * Props:
 *   - `amount`: DUSDC amount to request. Defaults to the
 *     /faucet/info `defaultAmount` (100 DUSDC).
 *   - `recipient`: optional override for the recipient address.
 *     If unset, uses the connected wallet's address; the
 *     button is disabled when no wallet is connected.
 *   - `label`: optional custom button label.
 *   - `variant`: "primary" (default) or "compact".
 *   - `onSuccess`: optional callback fired after a successful
 *     mint with the digest.
 */

import { useCurrentAccount } from "@mysten/dapp-kit-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

const AGENTS_URL =
  process.env.NEXT_PUBLIC_AGENTS_URL ?? "http://localhost:3001";

interface FaucetInfo {
  enabled: boolean;
  configured: boolean;
  reason?: string;
  defaultAmount: number;
  maxAmount: number;
  minAmount: number;
  totalMinted: string;
  totalRequests: number;
  totalErrors: number;
  lastDigest: string;
  lastMintAt: number;
  faucetAddress: string;
  dusdcType: string;
}

interface FaucetResponse {
  ok?: boolean;
  digest?: string;
  amount?: number;
  amountAtoms?: string;
  recipient?: string;
  info?: FaucetInfo;
  error?: string;
  detail?: string;
}

export interface FaucetButtonProps {
  amount?: number;
  recipient?: string;
  label?: string;
  variant?: "primary" | "compact";
  /** Optional title for the primary variant card. */
  title?: string;
  /** Optional helper copy under the title. */
  description?: string;
  /** Optional className for the wrapping element (compact
   *  variant only). Lets the parent page control margin /
   *  width without prop-drilling a `style` object. */
  className?: string;
  /** Optional callback fired with the digest on success. */
  onSuccess?: (digest: string, amount: number) => void;
}

function shortAddress(addr: string): string {
  if (!addr) return "";
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function shortDigest(d: string): string {
  if (!d) return "";
  return `${d.slice(0, 10)}…`;
}

export function FaucetButton({
  amount: amountProp,
  recipient: recipientProp,
  label,
  variant = "primary",
  title,
  description,
  className,
  onSuccess,
}: FaucetButtonProps) {
  const account = useCurrentAccount();
  const recipient = (recipientProp ?? account?.address ?? "").trim();

  const [info, setInfo] = useState<FaucetInfo | null>(null);
  const [infoError, setInfoError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [lastDigest, setLastDigest] = useState<string | null>(null);

  // Fetch /faucet/info on mount + after each successful mint.
  // Polling would be wasteful — the info is essentially static
  // (only counters change). A re-fetch on demand (mount +
  // success) covers the live cases.
  const refreshInfo = useCallback(async () => {
    try {
      const res = await fetch(`${AGENTS_URL}/faucet/info`, {
        cache: "no-store",
      });
      if (!res.ok) {
        setInfoError(`HTTP ${res.status}`);
        return;
      }
      const j = (await res.json()) as FaucetInfo;
      setInfo(j);
      setInfoError(null);
    } catch (err) {
      setInfoError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refreshInfo();
  }, [refreshInfo]);

  // Resolve the amount to request. Clamp to [min, max] from
  // /faucet/info so a future tweak to the server cap is
  // honoured without a client rebuild.
  const requestedAmount = useMemo(() => {
    const fallback = info?.defaultAmount ?? 100;
    const requested = amountProp ?? fallback;
    if (!info) return requested;
    return Math.min(
      Math.max(requested, info.minAmount),
      info.maxAmount,
    );
  }, [amountProp, info]);

  const canRequest = useMemo(() => {
    if (!info) return false;
    if (!info.enabled) return false;
    if (!info.configured) return false;
    if (!recipient) return false;
    return true;
  }, [info, recipient]);

  const handleClick = useCallback(async () => {
    if (!canRequest) return;
    setBusy(true);
    const toastId = toast.loading(
      `Minting ${requestedAmount} DUSDC to your address…`,
    );
    try {
      const res = await fetch(`${AGENTS_URL}/faucet/dusdc`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recipient,
          amount: requestedAmount,
        }),
      });
      // 429 has a Retry-After header — surface it on the toast
      // so the user knows when to retry instead of clicking
      // again in a tight loop.
      if (res.status === 429) {
        const retry = Number(res.headers.get("Retry-After") ?? "60");
        const data = (await res.json().catch(() => ({}))) as FaucetResponse;
        toast.error(
          `Faucet rate-limited. Try again in ${retry}s. ${data.detail ?? data.error ?? ""}`.trim(),
          { id: toastId, duration: 6_000 },
        );
        return;
      }
      const data = (await res.json().catch(() => ({}))) as FaucetResponse;
      if (!res.ok || !data.ok) {
        const raw = data.detail ?? data.error ?? `HTTP ${res.status}`;
        // Special-case the agent's "insufficient SUI" error so
        // the user knows the issue is operational, not user
        // error.
        if (/insufficient SUI|gas selection/i.test(raw)) {
          toast.error(
            "Faucet is out of gas. The protocol operator needs to top up the agent's SUI balance.",
            { id: toastId, duration: 8_000 },
          );
        } else if (data.error === "Faucet is not configured") {
          toast.error(
            "DUSDC faucet is not configured on this deployment. Ask the operator to run `pnpm --filter @suipredict/agents bootstrap`.",
            { id: toastId, duration: 8_000 },
          );
        } else if (data.error === "Faucet is disabled") {
          toast.error("DUSDC faucet is disabled on this deployment.", {
            id: toastId,
            duration: 6_000,
          });
        } else {
          toast.error(raw, { id: toastId, duration: 6_000 });
        }
        return;
      }
      setLastDigest(data.digest ?? null);
      toast.success(
        `Minted ${requestedAmount} DUSDC · ${shortDigest(data.digest ?? "")}`,
        { id: toastId, duration: 6_000 },
      );
      // Broadcast a window event so the markets/[id] page's
      // DUSDC pre-flight (which runs in `splitCollateral`)
      // re-queries `client.core.listCoins` immediately
      // instead of waiting for the next mount. The pattern
      // matches the existing `open-connect-modal` event.
      if (typeof window !== "undefined") {
        window.dispatchEvent(
          new CustomEvent("faucet-mint", {
            detail: {
              digest: data.digest,
              amount: requestedAmount,
              recipient,
              at: Date.now(),
            },
          }),
        );
      }
      // Re-fetch the info so the live counters (totalMinted /
      // totalRequests) reflect the new mint.
      void refreshInfo();
      onSuccess?.(data.digest ?? "", requestedAmount);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Faucet request failed",
        { id: toastId },
      );
    } finally {
      setBusy(false);
    }
  }, [canRequest, onSuccess, recipient, refreshInfo, requestedAmount]);

  // Render a friendly "disabled" state for the cases where
  // the faucet isn't usable (no agent key, no TreasuryCap,
  // production env). Showing the user *why* the button is
  // greyed out is much better than a button that silently
  // fails on click.
  if (infoError && !info) {
    if (variant === "compact") {
      return (
        <span className="text-[10px] text-zinc-500">Faucet offline</span>
      );
    }
    return (
      <div className="rounded-2xl border border-white/10 bg-panel p-4">
        <h3 className="text-sm font-bold text-white">DUSDC faucet</h3>
        <p className="mt-1 text-xs text-zinc-500">
          Could not reach the agents service ({infoError}). Start the
          agents with <code className="text-[10px]">pnpm dev:agents</code>{" "}
          and refresh.
        </p>
      </div>
    );
  }

  if (info && !info.enabled) {
    if (variant === "compact") return null;
    return (
      <div className="rounded-2xl border border-white/10 bg-panel p-4">
        <h3 className="text-sm font-bold text-white">DUSDC faucet</h3>
        <p className="mt-1 text-xs text-zinc-500">
          {info.reason ?? "The faucet is disabled on this deployment."}
        </p>
      </div>
    );
  }

  if (info && !info.configured) {
    if (variant === "compact") return null;
    return (
      <div className="rounded-2xl border border-white/10 bg-panel p-4">
        <h3 className="text-sm font-bold text-white">DUSDC faucet</h3>
        <p className="mt-1 text-xs text-zinc-500">
          {info.reason ??
            "DUSDC_TREASURY_CAP_ID is not configured on the agents service. The operator must run `pnpm --filter @suipredict/agents bootstrap`."}
        </p>
      </div>
    );
  }

  if (variant === "compact") {
    return (
      <div className={className}>
        <button
          type="button"
          onClick={handleClick}
          disabled={!canRequest || busy}
          className="inline-flex min-h-9 w-full items-center justify-center gap-1.5 rounded-lg bg-gradient-to-r from-cyan-600 to-emerald-500 px-3 py-1.5 text-xs font-bold text-white shadow-lg shadow-emerald-900/30 transition-all hover:scale-[1.01] active:scale-95 disabled:cursor-not-allowed disabled:opacity-50 disabled:scale-100"
          title={
            !recipient
              ? "Connect a wallet first"
              : `Mint ${requestedAmount} testnet DUSDC to your address from the protocol's TreasuryCap`
          }
        >
        {busy ? (
          <>
            <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-white border-t-transparent" />
            Minting…
          </>
        ) : (
          <>
            <span aria-hidden="true">💧</span>
            {label ?? `Faucet ${requestedAmount} DUSDC`}
          </>
        )}
        </button>
      </div>
    );
  }

  // Primary variant — full CTA card.
  const ctaTitle = title ?? "Need testnet DUSDC?";
  const ctaDescription =
    description ??
    "Mint free testnet DUSDC from the protocol's TreasuryCap. You need DUSDC to mint YES+NO shares on any market.";

  return (
    <div className="rounded-2xl border border-cyan-500/20 bg-gradient-to-br from-cyan-500/10 via-panel to-emerald-500/5 p-4 sm:p-5">
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-cyan-500/20 text-cyan-300">
          <span aria-hidden="true" className="text-lg">
            💧
          </span>
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-bold text-white">{ctaTitle}</h3>
          <p className="mt-1 text-xs text-cyan-200/80">{ctaDescription}</p>
          {!recipient && (
            <p className="mt-1 text-[10px] text-amber-300">
              Connect a wallet first to claim DUSDC.
            </p>
          )}
          {lastDigest && (
            <p className="mt-1 text-[10px] text-emerald-300/80">
              Last mint: {shortDigest(lastDigest)}
            </p>
          )}
        </div>
      </div>
      <button
        type="button"
        onClick={handleClick}
        disabled={!canRequest || busy}
        className="mt-3 inline-flex min-h-10 w-full items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-cyan-600 to-emerald-500 px-4 text-sm font-bold text-white shadow-lg shadow-emerald-900/30 transition-all hover:scale-[1.01] hover:shadow-emerald-900/50 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50 disabled:scale-100"
      >
        {busy ? (
          <>
            <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
            Minting {requestedAmount} DUSDC…
          </>
        ) : (
          <>
            <span aria-hidden="true">💧</span>
            {label ?? `Get ${requestedAmount} DUSDC`}
          </>
        )}
      </button>
      <p className="mt-2 text-[10px] text-zinc-500">
        Mints to{" "}
        <span className="font-mono text-zinc-400">
          {shortAddress(recipient)}
        </span>{" "}
        from{" "}
        <span className="font-mono text-zinc-400">
          {shortAddress(info?.faucetAddress ?? "")}
        </span>
        . Capped at {info?.maxAmount ?? 500} DUSDC per request · 3
        requests/h/address.
      </p>
    </div>
  );
}
