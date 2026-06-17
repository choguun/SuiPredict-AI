"use client";

/**
 * CoinRegistryLimitBanner.tsx
 * ============================================================================
 * One-line status banner shown at the top of the home page and the
 * /worldcup dashboard. Highlights the live, tradeable WC market
 * and acknowledges that the rest of the group-stage schedule is
 * still in the "preview" (SQLite-only) state. Dismissed via
 * localStorage so it doesn't reappear on every page load.
 *
 * R-WC-1.7 fix: the original copy (R-WC-1.2) framed the 1-tradeable
 * / 44-preview state as a system constraint ("Sui CoinRegistry
 * allows only one Currency<YES<DUSDC>> per package, so the contract
 * can publish a single on-chain market at a time") — the wording
 * was technically accurate but read as an error alert. End users
 * don't care about CoinRegistry internals; they want to know
 * "what can I trade right now?" The new copy is positive and
 * action-oriented: it leads with the live market (one-click deep
 * link to the tradeable wc26-A1v4 market) and frames the rest as
 * "previews of what's coming next" rather than a broken system.
 *
 * The technical detail (Sui CoinRegistry, per-market coin types,
 * the long-term contract upgrade path) is still documented in
 * `docs/SOP-DEPLOYMENT.md#coinregistry-limit` for operators.
 */

import { useEffect, useState } from "react";
import Link from "next/link";

const STORAGE_KEY = "suipredict-coinregistry-banner-dismissed-v1";

export function CoinRegistryLimitBanner() {
  const [dismissed, setDismissed] = useState<boolean | null>(null);

  useEffect(() => {
    try {
      setDismissed(localStorage.getItem(STORAGE_KEY) === "1");
    } catch {
      setDismissed(false);
    }
  }, []);

  if (dismissed !== false) return null;

  const onDismiss = () => {
    try {
      localStorage.setItem(STORAGE_KEY, "1");
    } catch {
      // ignore — localStorage may be disabled
    }
    setDismissed(true);
  };

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-cyan-500/30 bg-cyan-500/5 p-3 text-xs text-cyan-200/90 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex-1 leading-relaxed">
        <span className="font-bold text-cyan-200">1 live market · 44 previews.</span>{" "}
        The next live market is the kickoff closest to T-7d; the
        other 44 group matches are previews until they go on-chain.
        The home page{" "}
        <Link
          href="/markets/wc26-A1v4"
          className="font-bold text-cyan-200 underline decoration-cyan-500/40 underline-offset-2 hover:text-cyan-100"
        >
          wc26-A1v4
        </Link>{" "}
        is tradeable now.
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss banner"
        className="self-start rounded-lg border border-cyan-500/30 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-cyan-200 hover:bg-cyan-500/10 sm:self-auto"
      >
        Dismiss
      </button>
    </div>
  );
}
