"use client";

import { useCurrentAccount, useDAppKit } from "@mysten/dapp-kit-react";
import { buildCreateStreakTx } from "@suipredict/sdk";
import { useUserStreakId } from "@/hooks/useUserStreakId";
import { useStreakInfo } from "@/hooks/useStreakInfo";

const TIER_THRESHOLDS = [3, 7, 14, 30, 100] as const;
const TIER_LABELS = ["Bronze", "Silver", "Gold", "Platinum", "Diamond"] as const;
const REGISTRY_ID = process.env.NEXT_PUBLIC_STREAK_REGISTRY_ID ?? "";

function tierIndexForStreak(current: number): number {
  let best = -1;
  for (let i = 0; i < TIER_THRESHOLDS.length; i++) {
    if (current >= TIER_THRESHOLDS[i]!) best = i;
  }
  return best;
}

function nextMilestone(current: number): { days: number; label: string } {
  const idx = tierIndexForStreak(current) + 1;
  if (idx >= TIER_THRESHOLDS.length) {
    return { days: TIER_THRESHOLDS[TIER_THRESHOLDS.length - 1]!, label: "Diamond" };
  }
  return { days: TIER_THRESHOLDS[idx]!, label: TIER_LABELS[idx]! };
}

function badgesEarnedCount(claimed: boolean[] | undefined): number {
  if (!claimed) return 0;
  return claimed.filter(Boolean).length;
}

export function StreakProfile() {
  const account = useCurrentAccount();
  const dAppKit = useDAppKit();
  const { streakId, isLoading: idLoading } = useUserStreakId(account?.address);
  const streak = useStreakInfo(streakId);

  if (!account) {
    return <StreakProfileEmpty reason="Connect a wallet to start a streak." />;
  }
  if (idLoading) {
    return <StreakProfileEmpty reason="Loading streak…" spinner />;
  }
  if (!streakId) {
    return (
      <StreakProfileEmpty
        reason="You don't have a streak yet."
        cta={
          <button
            disabled={!REGISTRY_ID}
            onClick={async () => {
              if (!REGISTRY_ID) return;
              const tx = buildCreateStreakTx(REGISTRY_ID);
              await dAppKit.signAndExecuteTransaction({ transaction: tx });
            }}
            className="mt-3 rounded-lg bg-gradient-to-r from-orange-500 to-rose-500 px-4 py-2 text-sm font-semibold text-white shadow-md transition hover:brightness-110 disabled:opacity-50"
          >
            Start your streak
          </button>
        }
      />
    );
  }

  const current = streak.info?.current_streak ?? 0;
  const longest = streak.info?.longest_streak ?? 0;
  const boostPct = Math.round((streak.multiplier - 1) * 100);
  const next = nextMilestone(current);
  const progressPct = next.days > 0
    ? Math.min(100, (current / next.days) * 100)
    : 100;
  const earned = badgesEarnedCount(streak.info?.claimed_tiers);

  return (
    <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-[#11141d] p-6 shadow-xl shadow-black/50 transition-all hover:border-orange-500/30 hover:shadow-orange-900/20">
      <div className="absolute -right-20 -top-20 h-40 w-40 rounded-full bg-orange-500/10 blur-[50px] -z-10" />
      <div className="flex flex-col gap-5">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-xs font-bold uppercase tracking-widest text-zinc-500 mb-1.5">
              Current Streak
            </h2>
            <div className="flex items-baseline gap-2">
              <span className="text-5xl font-extrabold tracking-tighter text-transparent bg-clip-text bg-gradient-to-br from-orange-300 via-rose-400 to-rose-600 drop-shadow-sm">
                {current}
              </span>
              <span className="text-base font-semibold text-zinc-400">Days</span>
            </div>
          </div>
          <div className="flex flex-col items-end">
            <h2 className="text-xs font-bold uppercase tracking-widest text-zinc-500 mb-1.5">
              Active Yield Boost
            </h2>
            <div className="flex items-center gap-1.5 rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-3 py-1.5">
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" className="text-emerald-400" strokeWidth="2.5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
              <span className="text-lg font-bold text-emerald-400">
                {boostPct >= 0 ? `+${boostPct}` : boostPct}%
              </span>
            </div>
          </div>
        </div>
        <div className="space-y-2 mt-2">
          <div className="flex justify-between text-xs font-medium text-zinc-400">
            <span>Next Milestone: {next.label} ({next.days}-Day)</span>
            <span className="text-white">{current} / {next.days}</span>
          </div>
          <div className="h-2.5 w-full overflow-hidden rounded-full bg-black/40 border border-white/5">
            <div
              className="h-full bg-gradient-to-r from-orange-400 to-rose-500 transition-all duration-500 shadow-[0_0_10px_rgba(244,63,94,0.5)]"
              style={{ width: `${progressPct}%` }}
            />
          </div>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-3">
          <div className="rounded-xl border border-white/5 bg-gradient-to-b from-white/[0.04] to-transparent p-3.5 text-center transition-colors hover:bg-white/5">
            <div className="text-[10px] font-bold tracking-widest text-zinc-500 uppercase">Longest Streak</div>
            <div className="mt-1 text-xl font-bold text-white">{longest}</div>
          </div>
          <div className="rounded-xl border border-white/5 bg-gradient-to-b from-white/[0.04] to-transparent p-3.5 text-center transition-colors hover:bg-white/5">
            <div className="text-[10px] font-bold tracking-widest text-zinc-500 uppercase">Badges Earned</div>
            <div className="mt-1 text-xl font-bold text-white">{earned}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

function StreakProfileEmpty({
  reason,
  cta,
  spinner,
}: {
  reason: string;
  cta?: React.ReactNode;
  spinner?: boolean;
}) {
  return (
    <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-[#11141d] p-6 shadow-xl shadow-black/50">
      <div className="absolute -right-20 -top-20 h-40 w-40 rounded-full bg-orange-500/10 blur-[50px] -z-10" />
      <div className="flex flex-col items-center justify-center gap-2 py-8 text-center">
        {spinner && (
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-orange-500 border-t-transparent" />
        )}
        <p className="text-sm text-zinc-400">{reason}</p>
        {cta}
      </div>
    </div>
  );
}
