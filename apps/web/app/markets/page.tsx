import Link from "next/link";
import { listMarkets } from "@suipredict/sdk";
import { Badge, Card } from "@/components/ui";

export const dynamic = "force-dynamic";

function formatDate(ms: number) {
  return new Date(ms).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
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
          <Card className="border-dashed border-white/15 py-10 text-center">
            <p className="text-zinc-400">
              No markets yet. Start the agents service to seed demo markets.
            </p>
          </Card>
        )}
        {markets.map((m) => (
          <Link
            key={m.id}
            href={`/markets/${encodeURIComponent(m.id)}`}
            className="group rounded-lg border border-white/10 bg-[#11141d] p-4 transition hover:border-emerald-400/40 hover:bg-[#151924]"
          >
            <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
              <div className="min-w-0">
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
                <h2 className="text-base font-semibold leading-snug text-zinc-100 sm:text-lg">
                  {m.title}
                </h2>
                <p className="mt-1 line-clamp-2 text-sm leading-6 text-zinc-500">
                    {m.description}
                </p>
                {m.outcome && (
                  <p className="mt-2 text-sm font-medium text-emerald-300">
                    Outcome: {m.outcome.toUpperCase()}
                  </p>
                )}
              </div>
              <div className="grid shrink-0 grid-cols-2 gap-2 md:w-52">
                <span className="rounded-md bg-emerald-400 px-3 py-2 text-center text-sm font-semibold text-zinc-950 transition group-hover:bg-emerald-300">
                  Buy Yes
                </span>
                <span className="rounded-md bg-rose-400 px-3 py-2 text-center text-sm font-semibold text-zinc-950 transition group-hover:bg-rose-300">
                  Buy No
                </span>
              </div>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
