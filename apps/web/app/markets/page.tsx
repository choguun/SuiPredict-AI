import Link from "next/link";
import { listMarkets } from "@suipredict/sdk";
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

function getPseudoProbability(id: string) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = id.charCodeAt(i) + ((hash << 5) - hash);
  }
  const val = Math.abs(hash) % 100;
  return Math.max(10, Math.min(90, val)) / 100;
}

export default async function MarketsPage() {
  const markets = await listMarkets().catch(() => []);
  const active = markets.filter((m) => m.status === "active").length;
  const resolved = markets.filter((m) => m.status === "resolved").length;

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <Badge variant="success">Polymarket-style CLOB</Badge>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight text-white">Markets</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-zinc-400">
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

      <div className="grid gap-3">
        {markets.length === 0 && (
          <EmptyState
            title="No Markets Available"
            description="Start the agents service to seed demo markets or connect to the live network."
          />
        )}
        {markets.map((m) => {
          const prob = getPseudoProbability(m.id);
          return (
            <Link
              key={m.id}
              href={`/markets/${encodeURIComponent(m.id)}`}
              className="group rounded-lg border border-white/10 bg-[#11141d] p-5 transition-all hover:border-cyan-500/30 hover:bg-[#151924] hover:shadow-lg hover:shadow-cyan-900/10"
            >
              <div className="flex flex-col gap-5 md:flex-row md:items-center md:justify-between">
                <div className="flex-1 min-w-0">
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <Badge
                      variant={m.status === "active" ? "success" : "warning"}
                    >
                      {m.status}
                    </Badge>
                    <span className="text-xs font-medium text-zinc-500">
                      {m.category}
                    </span>
                    <span className="text-xs text-zinc-600">
                      Ends {formatDate(m.expiry_ms)}
                    </span>
                  </div>
                  <h2 className="text-base font-semibold leading-snug text-white sm:text-lg">
                    {m.title}
                  </h2>
                  <p className="mt-1 line-clamp-2 text-sm leading-6 text-zinc-400">
                    {m.description}
                  </p>
                  
                  {m.status === "active" && (
                    <div className="mt-4 max-w-md">
                      <div className="flex justify-between text-xs font-medium mb-1.5">
                        <span className="text-emerald-400">{Math.round(prob * 100)}% YES</span>
                        <span className="text-rose-400">{Math.round((1 - prob) * 100)}% NO</span>
                      </div>
                      <ProbabilityBar yesProbability={prob} className="h-2" />
                    </div>
                  )}

                  {m.outcome && (
                    <div className="mt-3 inline-flex items-center gap-2 rounded-md bg-emerald-500/10 px-3 py-1.5 border border-emerald-500/20">
                      <span className="text-sm font-medium text-emerald-400">
                        Winner: {m.outcome.toUpperCase()}
                      </span>
                    </div>
                  )}
                </div>
                <div className="grid shrink-0 grid-cols-2 gap-3 md:w-56 mt-2 md:mt-0">
                  <span className="flex items-center justify-center rounded-lg bg-gradient-to-r from-emerald-500 to-teal-400 px-3 py-2.5 text-sm font-bold text-white shadow-lg shadow-emerald-900/20 transition-all group-hover:scale-[1.02]">
                    Buy Yes
                  </span>
                  <span className="flex items-center justify-center rounded-lg bg-gradient-to-r from-rose-500 to-orange-400 px-3 py-2.5 text-sm font-bold text-white shadow-lg shadow-rose-900/20 transition-all group-hover:scale-[1.02]">
                    Buy No
                  </span>
                </div>
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
