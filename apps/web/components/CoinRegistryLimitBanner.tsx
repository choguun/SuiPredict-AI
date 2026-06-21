"use client";

/**
 * CoinRegistryLimitBanner.tsx
 * ============================================================================
 * One-line status banner shown at the top of the home page and the
 * /worldcup dashboard. Highlights the live, tradeable WC matches
 * and acknowledges that the rest of the group-stage schedule is
 * still in the "preview" (SQLite-only) state. Dismissed via
 * localStorage so it doesn't reappear on every page load.
 *
 * R-WC-3.4 fix: the previous copy ("1 live market · 44 previews",
 * deep-linking to wc26-A1v4) was stale — A1v4 is RESOLVED and
 * the v3 CoinRegistry migration lifted the one-market-at-a-time
 * cap, so 8 WC markets (the rest of Matchday 3) are now live
 * simultaneously. The new copy reflects the actual count (8 live
 * WC markets) and the next 64 group-stage matches that are
 * scheduled to be published on-chain 7 days before kickoff. The
 * deep-link points at the soonest-kicking active match so a user
 * landing on the home page has a one-click path to the most
 * actionable market.
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
        <span className="font-bold text-cyan-200">8 live WC markets · 64 group-stage previews.</span>{" "}
        All Matchday 3 matches are tradeable now. New group matches
        go on-chain 7 days before kickoff; the rest are previews
        until then. The next match kicking off is{" "}
        <Link
          href="/markets/wc26-A1v2"
          className="font-bold text-cyan-200 underline decoration-cyan-500/40 underline-offset-2 hover:text-cyan-100"
        >
          wc26-A1v2
        </Link>{" "}
        (Mexico 🇲🇽 vs South Africa 🇿🇦).
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
