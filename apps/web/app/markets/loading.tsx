/**
 * Loading skeleton for the /markets list
 * page. Mirrors the home page's role="status"
 * + aria-live pattern so screen-reader users
 * get a "Loading markets" announcement.
 *
 * R32 sweep fix: the markets list was
 * rendering an empty container for ~1-2s on
 * the first cold-navigation, then
 * materialising the full list once the agents
 * REST responded. The page has 47+ cards
 * which can cause a layout shift ("no
 * categories" → "50 cards, all in a column"
 * → "filtered list"). A skeleton with the
 * same grid layout eliminates the shift and
 * signals "data is on its way" to the user.
 */
export default function MarketsListLoading() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="space-y-5 animate-pulse"
    >
      <span className="sr-only">Loading markets…</span>

      {/* Hero skeleton */}
      <div className="rounded-3xl border border-white/10 bg-[#11141d] p-6 sm:p-10">
        <div className="h-7 w-48 rounded-lg bg-white/5" />
        <div className="mt-3 h-4 w-96 max-w-full rounded-lg bg-white/5" />
      </div>

      {/* Filter pills skeleton */}
      <div className="flex gap-2">
        {[1, 2, 3, 4, 5].map((i) => (
          <div
            key={i}
            className="h-9 w-24 rounded-full bg-white/[0.04]"
          />
        ))}
      </div>

      {/* Search row skeleton */}
      <div className="flex gap-2">
        <div className="h-11 flex-1 rounded-lg bg-white/[0.04]" />
        <div className="h-11 w-32 rounded-lg bg-white/[0.04]" />
        <div className="h-11 w-32 rounded-lg bg-white/[0.04]" />
        <div className="h-11 w-20 rounded-lg bg-white/[0.04]" />
      </div>

      {/* Card grid skeleton — matches the
          2-column `md:grid-cols-2` layout of
          the real page so the transition from
          skeleton to data has no layout shift. */}
      <div className="grid gap-3 md:grid-cols-2">
        {[1, 2, 3, 4, 5, 6].map((i) => (
          <div
            key={i}
            className="h-48 rounded-2xl border border-white/5 bg-[#11141d]"
          />
        ))}
      </div>
    </div>
  );
}
