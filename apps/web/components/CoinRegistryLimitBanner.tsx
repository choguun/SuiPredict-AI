"use client";

/**
 * CoinRegistryLimitBanner.tsx
 * ============================================================================
 * One-line banner explaining the Sui CoinRegistry limit. Shown at the
 * top of the /worldcup dashboard and the home page when there is at
 * least one active WC market in the SQLite mirror. Dismissed via
 * localStorage so it doesn't reappear on every page load.
 *
 * R-WC-1.2 fix: pre-fix, the WC dashboard showed a 7-day ticker full
 * of "Place your bet →" links that all led to preview pages. The
 * banner is a single, scannable line that tells the user why those
 * links mostly don't lead to a tradeable market. Without it, the
 * dashboard felt broken (a user clicks a link, sees a preview page,
 * has no idea the system constraint is the cause).
 *
 * The banner is intentionally NOT a marketing surface. The "Learn
 * more" link points to docs/SOP-DEPLOYMENT.md so a curious operator
 * can read the full deploy story without us having to maintain a
 * copy in the web bundle.
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
    <div className="flex flex-col gap-2 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-200/90 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex-1 leading-relaxed">
        <span className="font-bold text-amber-200">1 tradeable WC market · 44 previews.</span>{" "}
        The Sui CoinRegistry allows only one
        <code className="mx-1 rounded bg-black/30 px-1 font-mono text-[10px]">Currency&lt;YES&lt;DUSDC&gt;&gt;</code>
        per package, so the contract can publish a single on-chain
        market at a time. The other 44 group matches are SQLite-only
        previews until the contract is upgraded to use per-market coin
        types.
        <Link
          href="https://github.com/SuiPredict-AI/blob/main/docs/SOP-DEPLOYMENT.md#coinregistry-limit"
          target="_blank"
          rel="noreferrer"
          className="ml-1 underline decoration-amber-500/30 underline-offset-2 hover:text-amber-200"
        >
          Learn more →
        </Link>
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss banner"
        className="self-start rounded-lg border border-amber-500/30 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-amber-200 hover:bg-amber-500/10 sm:self-auto"
      >
        Dismiss
      </button>
    </div>
  );
}
