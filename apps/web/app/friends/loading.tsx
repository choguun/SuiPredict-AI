/**
 * Loading skeleton for the friends page.
 * Shows the page chrome (hero + add form
 * + empty friends grid) while the
 * /portfolio/:addr calls fire on mount.
 */
export default function FriendsLoading() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="space-y-6 pb-12 animate-pulse"
    >
      <span className="sr-only">Loading friends…</span>

      <div className="rounded-3xl border border-white/10 bg-[#11141d] p-6 sm:p-10">
        <div className="h-4 w-32 rounded bg-violet-500/10" />
        <div className="mt-3 h-9 w-48 rounded bg-white/5" />
        <div className="mt-2 h-4 w-96 max-w-full rounded bg-white/5" />
      </div>

      <div className="rounded-2xl border border-white/10 bg-[#0d1019] p-5">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="flex-1">
            <div className="h-3 w-24 rounded bg-white/5" />
            <div className="mt-2 h-10 rounded-lg bg-white/[0.04]" />
          </div>
          <div className="h-10 w-20 rounded-lg bg-emerald-500/20" />
        </div>
      </div>

      <div className="rounded-2xl border border-white/10 bg-[#0d1019] p-6 text-center">
        <div className="mx-auto h-12 w-12 rounded-full bg-white/5" />
        <div className="mx-auto mt-4 h-5 w-32 rounded bg-white/5" />
        <div className="mx-auto mt-2 h-3 w-64 max-w-full rounded bg-white/5" />
      </div>
    </div>
  );
}
