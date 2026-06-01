import Link from "next/link";
import { getMarketOrderBook, listMarkets } from "@suipredict/sdk";
import { Badge } from "@/components/ui";
import { EmptyState } from "@/components/EmptyState";
import { ProbabilityBar } from "@/components/ProbabilityBar";

export const dynamic = "force-dynamic";

function formatDate(ms: number) {
  return new Date(ms).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/**
 * Read the live YES probability from the order book mid-price. If the
 * book is empty or unreachable, fall back to 0.5 so the UI still
 * renders without misleading users.
 */
function probabilityFromBook(
  book: { mid_price: number } | null | undefined,
): number {
  if (!book) return 0.5;
  const p = book.mid_price;
  if (!Number.isFinite(p) || p <= 0 || p >= 1) return 0.5;
  return p;
}

export default async function MarketsPage() {
  const markets = await listMarkets().catch(() => []);
  const active = markets.filter((m) => m.status === "active").length;
  const resolved = markets.filter((m) => m.status === "resolved").length;

  // Fetch each active market's order book in parallel. Active markets
  // without a book yet (still bootstrapping) fall back to the 0.5
  // neutral midpoint. Resolved markets don't need a book.
  const activeIds = markets.filter((m) => m.status === "active").map((m) => m.id);
  const bookResults = await Promise.allSettled(
    activeIds.map((id) => getMarketOrderBook(id)),
  );
  const bookByMarket = new Map<string, { mid_price: number }>();
  activeIds.forEach((id, i) => {
    const r = bookResults[i];
    if (r.status === "fulfilled") {
      bookByMarket.set(id, r.value);
    }
  });

  return (
    <div className="space-y-5">
      <div className="relative overflow-hidden rounded-3xl border border-white/10 bg-[#11141d] p-6 sm:p-10 shadow-2xl shadow-black/40 mb-8">
        <div className="absolute -top-40 -right-40 h-[400px] w-[400px] rounded-full bg-cyan-600/10 blur-[80px] pointer-events-none" />
        <div className="absolute -bottom-40 -left-40 h-[400px] w-[400px] rounded-full bg-violet-600/10 blur-[80px] pointer-events-none" />
        
        <div className="relative z-10 flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
          <div className="max-w-2xl">
            <Badge variant="success" className="px-3 py-1 text-sm mb-4">Polymarket-style CLOB</Badge>
            <h1 className="text-3xl font-extrabold tracking-tight text-transparent bg-clip-text bg-gradient-to-r from-white to-cyan-200 sm:text-5xl mb-4">
              Prediction Markets
            </h1>
            <p className="text-base leading-relaxed text-zinc-400">
              Pick a side, set a probability, and route the order through the
              DeepBook YES order book. NO is shown as the complement price.
            </p>
          </div>
        <div className="grid grid-cols-3 gap-2 rounded-lg border border-white/10 bg-[#11141d] p-2 text-center">
          <div className="px-3 py-2">
            <p className="text-lg font-semibold text-white">{markets.length}</p>
            <p className="text-xs text-zinc-500">Total</p>
          </div>
          <div className="px-3 py-2">
            <p className="text-lg font-semibold text-emerald-300">{active}</p>
            <p className="text-xs text-zinc-500">Active</p>
          </div>
          <div className="px-3 py-2">
            <p className="text-lg font-semibold text-amber-300">{resolved}</p>
            <p className="text-xs text-zinc-500">Resolved</p>
          </div>
        </div>
        </div>
      </div>

      <div className="grid gap-3">
        {markets.length === 0 && (
          <EmptyState
            title="No Markets Available"
            description="Start the agents service to seed demo markets or connect to the live network."
          />
        )}
        {markets.map((m) => {
          const prob = m.status === "active"
            ? probabilityFromBook(bookByMarket.get(m.id))
            : 0.5;
          return (
            <Link
              key={m.id}
              href={`/markets/${encodeURIComponent(m.id)}`}
              className="group relative flex flex-col justify-between overflow-hidden rounded-2xl border border-white/10 bg-[#11141d] p-6 transition-all hover:border-cyan-500/30 hover:bg-[#151924] hover:shadow-2xl hover:shadow-cyan-900/10"
            >
              <div className="flex flex-col gap-5 md:flex-row md:items-center md:justify-between">
                <div className="flex-1 min-w-0">
                  <div className="mb-3 flex flex-wrap items-center gap-2">
                    <Badge
                      variant={m.status === "active" ? "success" : "warning"}
                      className="px-2.5 py-0.5 rounded-full"
                    >
                      {m.status}
                    </Badge>
                    <span className="rounded-full bg-white/5 px-2.5 py-0.5 text-xs font-medium text-zinc-300">
                      {m.category}
                    </span>
                    <span className="text-xs font-medium text-zinc-500">
                      Ends {formatDate(m.expiry_ms)}
                    </span>
                  </div>
                  <h2 className="text-lg font-bold text-white mb-2 leading-tight group-hover:text-cyan-100 transition-colors sm:text-xl">
                    {m.title}
                  </h2>
                  <p className="mt-1 line-clamp-2 text-sm leading-relaxed text-zinc-400">
                    {m.description}
                  </p>
                  
                  {m.status === "active" && (
                    <div className="mt-5 max-w-lg">
                      <div className="flex justify-between text-xs font-bold uppercase tracking-wider mb-2">
                        <span className="text-emerald-400">{Math.round(prob * 100)}% YES</span>
                        <span className="text-rose-400">{Math.round((1 - prob) * 100)}% NO</span>
                      </div>
                      <ProbabilityBar yesProbability={prob} className="h-2.5" />
                    </div>
                  )}

                  {m.outcome && (
                    <div className="mt-4 inline-flex items-center gap-2 rounded-lg bg-emerald-500/10 px-4 py-2 border border-emerald-500/20">
                      <span className="text-sm font-bold text-emerald-400">
                        WINNER: {m.outcome.toUpperCase()}
                      </span>
                    </div>
                  )}
                </div>
                {m.status === "active" && (
                  <div className="grid shrink-0 grid-cols-2 gap-3 md:w-56 mt-4 md:mt-0 opacity-100 sm:opacity-0 sm:translate-y-2 transition-all duration-300 group-hover:opacity-100 group-hover:translate-y-0">
                    <span className="flex items-center justify-center rounded-lg bg-emerald-500/20 py-3 text-sm font-semibold text-emerald-300 border border-emerald-500/30 transition-colors hover:bg-emerald-500/30">
                      Buy YES
                    </span>
                    <span className="flex items-center justify-center rounded-lg bg-rose-500/20 py-3 text-sm font-semibold text-rose-300 border border-rose-500/30 transition-colors hover:bg-rose-500/30">
                      Buy NO
                    </span>
                  </div>
                )}
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
