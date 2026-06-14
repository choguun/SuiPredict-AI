export default function GlobalLoading() {
  return (
    // R62 audit fix: wrap the skeleton in
    // a `role="status"` + `aria-live="polite"`
    // so screen-reader users get a single
    // "Loading" announcement on every
    // route transition. The pre-R62 build
    // was a bare `<div>` with no role
    // announcement — a screen-reader user
    // navigating between pages heard
    // nothing during the brief loading
    // window. The text is also `sr-only`
    // (visually hidden) so the visual
    // skeleton still drives the layout.
    <div
      role="status"
      aria-live="polite"
      className="space-y-6 animate-pulse"
    >
      <span className="sr-only">Loading…</span>
      <div className="h-10 w-48 rounded-lg bg-white/5" />
      <div className="h-6 w-96 rounded-lg bg-white/5" />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 mt-8">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="h-32 rounded-lg border border-white/5 bg-white/[0.02]" />
        ))}
      </div>

      <div className="mt-8 h-[400px] rounded-lg border border-white/5 bg-white/[0.02]" />
    </div>
  );
}
