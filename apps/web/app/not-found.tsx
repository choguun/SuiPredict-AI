/**
 * 404 / Not Found page. The Next.js App Router requires a
 * `not-found.tsx` at the root (or per-segment) to render for
 * unknown routes. Without it, an unrecognised URL renders the
 * global `error.tsx` boundary with "Something went wrong",
 * which is technically incorrect (a missing route isn't a
 * runtime error) and confuses users who paste a broken link.
 *
 * The page keeps the same dark/glass aesthetic as the rest
 * of the app and offers a single primary CTA back to the
 * markets list, with secondary CTAs to the home page and
 * the World Cup dashboard. The "trending markets" preview
 * calls the SDK's `listMarkets` so a fresh visitor who
 * mistyped a URL lands on a useful page instead of an
 * empty void.
 */

import Link from "next/link";
import { listMarkets } from "@suipredict/sdk";
import { Badge } from "@/components/ui";
import { EmptyState } from "@/components/EmptyState";

export const dynamic = "force-dynamic";

export default async function NotFound() {
  // Show the user a few featured markets so the page is
  // useful even if the URL was a typo. `listMarkets()`
  // already returns the cached SQLite mirror, so this
  // adds at most one agents-RTT to the page render.
  let featured: Awaited<ReturnType<typeof listMarkets>> = [];
  try {
    featured = (await listMarkets())
      .filter((m) => m.status === "active")
      .slice(0, 3);
  } catch {
    // Agents service down → render the empty state.
    featured = [];
  }

  return (
    <div className="space-y-8 pb-12">
      {/* Hero */}
      <section className="relative overflow-hidden rounded-3xl border border-white/10 bg-[#11141d] p-8 sm:p-12 text-center shadow-2xl shadow-black/40">
        <div className="absolute -top-40 -right-40 h-[400px] w-[400px] rounded-full bg-violet-600/10 blur-[100px] pointer-events-none" />
        <div className="absolute -bottom-40 -left-40 h-[400px] w-[400px] rounded-full bg-cyan-600/10 blur-[100px] pointer-events-none" />

        <div className="relative z-10 flex flex-col items-center gap-4">
          <div className="text-7xl sm:text-8xl">🏟️</div>
          <Badge
            variant="warning"
            className="px-3 py-1 text-xs font-bold uppercase tracking-widest"
          >
            404 · Off the pitch
          </Badge>
          <h1 className="text-3xl font-extrabold tracking-tight text-white sm:text-5xl">
            We couldn&apos;t find that page
          </h1>
          <p className="max-w-xl text-base text-zinc-400">
            The link may be broken, the market may have been
            resolved and removed, or the URL was just a typo.
            Try one of the routes below — the bracket&apos;s
            still live.
          </p>

          <div className="mt-2 flex flex-col sm:flex-row gap-3">
            <Link
              href="/markets"
              className="inline-flex min-h-12 items-center justify-center rounded-xl bg-gradient-to-r from-violet-600 to-cyan-600 px-6 text-sm font-bold text-white shadow-lg shadow-cyan-900/30 transition hover:scale-[1.02]"
            >
              Browse Markets
            </Link>
            <Link
              href="/worldcup"
              className="inline-flex min-h-12 items-center justify-center rounded-xl border border-white/10 bg-white/5 px-6 text-sm font-semibold text-white transition hover:bg-white/10"
            >
              World Cup 2026
            </Link>
            <Link
              href="/"
              className="inline-flex min-h-12 items-center justify-center rounded-xl border border-white/10 bg-white/5 px-6 text-sm font-semibold text-white transition hover:bg-white/10"
            >
              Home
            </Link>
          </div>
        </div>
      </section>

      {/* Featured markets — useful even if the user mistyped. */}
      <section className="space-y-4">
        <h2 className="text-xl font-bold text-white">Featured live markets</h2>
        {featured.length === 0 ? (
          <EmptyState
            title="No live markets"
            description="Start the agents service to seed demo markets, or check the network status."
            actionLabel="Go home"
            href="/"
          />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {featured.map((m) => (
              <Link
                key={m.id}
                href={`/markets/${encodeURIComponent(m.id)}`}
                className="group flex flex-col gap-2 rounded-2xl border border-white/10 bg-[#0d1019] p-4 transition hover:border-emerald-500/30"
              >
                <div className="flex items-center gap-2">
                  <Badge variant="success" className="text-[10px]">
                    LIVE
                  </Badge>
                  <span className="text-[10px] uppercase tracking-wider text-zinc-500">
                    {m.category}
                  </span>
                </div>
                <h3 className="line-clamp-2 text-sm font-semibold text-white group-hover:text-emerald-300">
                  {m.title}
                </h3>
                <p className="line-clamp-2 text-xs text-zinc-500">
                  {m.description}
                </p>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
