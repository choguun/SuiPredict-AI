/**
 * Loading skeleton for the World Cup
 * dashboard. The page is client-rendered
 * (`"use client"`) and depends on three
 * concurrent fetches to the agents
 * service (`/wc/groups`, `/wc/schedule`,
 * `/wc/upcoming`). On a cold start
 * (the first navigation after the
 * agents service is online) all three
 * can take ~200-500ms. Without a
 * skeleton, the user sees an empty
 * hero + empty groups for that
 * window. The skeleton mirrors the
 * final layout so the transition is
 * layout-shift free.
 *
 * R32 sweep fix: same pattern as the
 * markets list loading. The "Live &
 * Upcoming" strip and the 12-group
 * grid are both eagerly rendered
 * placeholders, with pulse animation
 * hinting at the loading state to
 * sighted users.
 */
export default function WorldCupLoading() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="space-y-6 pb-12 animate-pulse"
    >
      <span className="sr-only">Loading World Cup dashboard…</span>

      {/* Hero */}
      <div className="rounded-3xl border border-emerald-500/20 bg-gradient-to-br from-emerald-900/40 via-panel to-panel p-6 sm:p-10">
        <div className="h-6 w-48 rounded-full bg-emerald-500/10" />
        <div className="mt-4 h-12 w-3/4 max-w-2xl rounded-lg bg-white/5" />
        <div className="mt-2 h-4 w-2/3 max-w-xl rounded-lg bg-white/5" />
      </div>

      {/* Live & Upcoming ticker */}
      <div className="rounded-2xl border border-white/10 bg-panel p-5 sm:p-6">
        <div className="mb-4 flex items-center justify-between">
          <div className="h-6 w-40 rounded-lg bg-white/5" />
          <div className="h-6 w-28 rounded-lg bg-white/5" />
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-24 rounded-xl border border-white/10 bg-white/[0.02]"
            />
          ))}
        </div>
      </div>

      {/* Groups */}
      <div className="space-y-4">
        <div className="h-7 w-32 rounded-lg bg-white/5" />
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((i) => (
            <div
              key={i}
              className="h-40 rounded-2xl border border-white/10 bg-panel"
            />
          ))}
        </div>
      </div>
    </div>
  );
}
