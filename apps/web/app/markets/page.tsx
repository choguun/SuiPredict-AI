import Link from "next/link";
import { listMarkets } from "@suipredict/sdk";
import { Badge, Card } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function MarketsPage() {
  const markets = await listMarkets().catch(() => []);

  return (
    <div className="space-y-6">
      <div>
        <Badge variant="success">Polymarket-style CLOB</Badge>
        <h1 className="mt-2 text-3xl font-bold">Markets</h1>
        <p className="text-zinc-400">
          Trade YES/NO outcome tokens on on-chain order books. Split DBUSDC
          collateral to open positions.
        </p>
      </div>

      <div className="grid gap-4">
        {markets.length === 0 && (
          <Card>
            <p className="text-zinc-400">
              No markets yet. Start the agents service to seed demo markets.
            </p>
          </Card>
        )}
        {markets.map((m) => (
          <Link key={m.id} href={`/markets/${encodeURIComponent(m.id)}`}>
            <Card className="transition hover:border-cyan-500/40">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-xs uppercase text-zinc-500">{m.category}</p>
                  <h2 className="text-lg font-semibold text-zinc-100">{m.title}</h2>
                  <p className="mt-1 text-sm text-zinc-400 line-clamp-2">
                    {m.description}
                  </p>
                </div>
                <div className="text-right text-sm">
                  <Badge
                    variant={m.status === "active" ? "success" : "warning"}
                  >
                    {m.status}
                  </Badge>
                  <p className="mt-2 text-zinc-500">
                    Expires {new Date(m.expiry_ms).toLocaleDateString()}
                  </p>
                  {m.outcome && (
                    <p className="text-cyan-400">Outcome: {m.outcome.toUpperCase()}</p>
                  )}
                </div>
              </div>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
