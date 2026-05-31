"use client";



export function StreakProfile() {
  // Mock Data for UI presentation
  const currentStreak = 12;
  const longestStreak = 25;
  const multiplier = 30; // 30% yield boost
  const nextMilestone = 14;

  const progress = (currentStreak / nextMilestone) * 100;

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
                {currentStreak}
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
                +{multiplier}%
              </span>
            </div>
          </div>
        </div>

        <div className="space-y-2 mt-2">
          <div className="flex justify-between text-xs font-medium text-zinc-400">
            <span>Next Milestone: 14-Day Badge</span>
            <span className="text-white">{currentStreak} / {nextMilestone}</span>
          </div>
          <div className="h-2.5 w-full overflow-hidden rounded-full bg-black/40 border border-white/5">
            <div
              className="h-full bg-gradient-to-r from-orange-400 to-rose-500 transition-all duration-500 shadow-[0_0_10px_rgba(244,63,94,0.5)]"
              style={{ width: `${Math.min(progress, 100)}%` }}
            />
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3">
          <div className="rounded-xl border border-white/5 bg-gradient-to-b from-white/[0.04] to-transparent p-3.5 text-center transition-colors hover:bg-white/5">
            <div className="text-[10px] font-bold tracking-widest text-zinc-500 uppercase">Longest Streak</div>
            <div className="mt-1 text-xl font-bold text-white">{longestStreak}</div>
          </div>
          <div className="rounded-xl border border-white/5 bg-gradient-to-b from-white/[0.04] to-transparent p-3.5 text-center transition-colors hover:bg-white/5">
            <div className="text-[10px] font-bold tracking-widest text-zinc-500 uppercase">Badges Earned</div>
            <div className="mt-1 text-xl font-bold text-white">2</div>
          </div>
        </div>
      </div>
    </div>
  );
}
