/**
 * Loading skeleton for the leaderboard
 * page. Renders a server-side hero
 * skeleton + filter form skeleton + a
 * 5-row table skeleton. The
 * LeaderboardTable component's own
 * loading state (3-row skeleton) is
 * what shows once the SSR data
 * hydrates; this is the navigation
 * skeleton.
 */
export default function LeaderboardLoading() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="space-y-8 animate-pulse"
    >
      <span className="sr-only">Loading leaderboard…</span>

      <div>
        <div className="h-9 w-48 rounded-lg bg-white/5" />
        <div className="mt-2 h-4 w-72 rounded-lg bg-white/5" />
      </div>

      <div className="rounded-2xl border border-white/10 bg-panel p-5">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-10 rounded-md bg-white/[0.04]" />
          ))}
        </div>
      </div>

      <div className="rounded-2xl border border-white/10 bg-panel p-5">
        <div className="space-y-3">
          {[1, 2, 3, 4, 5].map((i) => (
            <div
              key={i}
              className="h-10 rounded-lg bg-white/[0.04]"
            />
          ))}
        </div>
      </div>
    </div>
  );
}
