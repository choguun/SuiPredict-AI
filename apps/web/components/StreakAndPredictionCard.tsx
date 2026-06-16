"use client";

/**
 * StreakAndPredictionCard
 *
 * Combines the StreakProfile (streak stats, yield boost, tier badges) with
 * the DailyPredictionCard (daily parlay builder) into a single left-column
 * widget on the home page. The two underlying components are kept intact
 * and only rendered when a wallet is connected, so the "Connect Wallet"
 * CTA is shown exactly once at the top of the combined card — removing
 * the duplicate connect button that previously appeared in both the
 * StreakProfile empty state and the DailyPredictionCard footer.
 *
 * Wallet state check is duplicated from the children on purpose: the
 * children still self-guard for safety (they can be rendered standalone
 * elsewhere), but here we short-circuit before mounting them so the
 * user only sees one CTA instead of two stacked empty states.
 */

import { useCurrentAccount } from "@mysten/dapp-kit-react";
import { StreakProfile } from "@/components/StreakProfile";
import { DailyPredictionCard } from "@/components/DailyPredictionCard";

function openConnectModal() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("open-connect-modal"));
  }
}

export function StreakAndPredictionCard() {
  const account = useCurrentAccount();

  if (!account) {
    return (
      <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-panel-strong p-5 shadow-xl shadow-black/50">
        <div className="absolute -right-20 -top-20 h-40 w-40 rounded-full bg-orange-500/10 blur-[50px] -z-10" />
        <div className="flex flex-col items-center justify-center gap-3 py-4 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-orange-500/10 text-orange-400">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="22"
              height="22"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z"
              />
            </svg>
          </div>
          <div>
            <h3 className="text-sm font-bold text-white mb-1">
              Connect to start trading
            </h3>
            <p className="max-w-[260px] text-xs leading-relaxed text-zinc-400">
              Build daily parlays, track your streak, and earn up to a 150%
              yield boost on winning positions.
            </p>
          </div>
          <button
            onClick={openConnectModal}
            className="mt-1 rounded-lg bg-gradient-to-r from-orange-500 to-red-500 px-4 py-2 text-xs font-bold text-white shadow-lg shadow-red-900/30 transition hover:scale-[1.02]"
          >
            Connect Wallet
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <StreakProfile />
      <DailyPredictionCard />
    </div>
  );
}
