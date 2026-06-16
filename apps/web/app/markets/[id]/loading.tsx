export default function MarketDetailLoading() {
  return (
    // R62 audit fix: same `role="status"`
    // + `aria-live="polite"` wrapper the
    // global loading.tsx uses. The
    // market detail page is the deepest
    // page in the app (multiple
    // refetching sources: market data,
    // order book, friend positions) and
    // a screen-reader user is most
    // likely to be waiting on this
    // page. The `sr-only` text doesn't
    // disrupt the visual skeleton.
    <div
      role="status"
      aria-live="polite"
      className="space-y-5 animate-pulse"
    >
      <span className="sr-only">Loading market…</span>
      <div className="h-5 w-32 rounded-lg bg-white/5" />

      <div className="rounded-lg border border-white/10 bg-panel-strong p-5 sm:p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="w-full">
            <div className="mb-3 flex gap-2">
              <div className="h-6 w-16 rounded-full bg-white/5" />
              <div className="h-6 w-24 rounded-full bg-white/5" />
            </div>
            <div className="h-10 w-2/3 rounded-lg bg-white/5" />
            <div className="mt-3 h-16 w-full rounded-lg bg-white/5" />
          </div>
          <div className="grid min-w-full grid-cols-2 gap-2 sm:min-w-72">
            <div className="h-24 rounded-lg bg-white/5" />
            <div className="h-24 rounded-lg bg-white/5" />
          </div>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="order-2 h-96 rounded-lg border border-white/10 bg-white/[0.02] lg:order-1" />
        <div className="order-1 h-[400px] rounded-lg border border-white/10 bg-white/[0.02] lg:order-2" />
      </div>
    </div>
  );
}
