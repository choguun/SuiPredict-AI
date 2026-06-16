/**
 * Loading skeleton for a single World Cup
 * group page. Mirrors the final layout
 * (back link + group header + teams grid +
 * matchday sections).
 */
export default function GroupPageLoading() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="space-y-6 pb-12 animate-pulse"
    >
      <span className="sr-only">Loading group…</span>

      <div>
        <div className="h-4 w-24 rounded bg-white/5" />
        <div className="mt-2 h-9 w-48 rounded bg-white/5" />
      </div>

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {[1, 2, 3, 4].map((i) => (
          <div
            key={i}
            className="h-20 rounded-2xl border border-white/10 bg-panel"
          />
        ))}
      </div>

      {[1, 2, 3].map((md) => (
        <div key={md} className="space-y-2">
          <div className="h-4 w-32 rounded bg-white/5" />
          <div className="h-20 rounded-2xl border border-white/10 bg-panel" />
          <div className="h-20 rounded-2xl border border-white/10 bg-panel" />
        </div>
      ))}
    </div>
  );
}
