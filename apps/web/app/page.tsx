import Link from "next/link";
import {
  getVaultSummaryClob,
  listMarkets,
} from "@suipredict/sdk";
import { Badge, Card, Stat } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const [markets, vault] = await Promise.all([
    listMarkets().catch(() => []),
    getVaultSummaryClob().catch(() => null),
  ]);

  const active = markets.filter((m) => m.status === "active").length;

  return (
    <div className="space-y-8">
      <section className="space-y-4">
        <Badge variant="success">Polymarket CLOB · DeepBook V3</Badge>
        <h1 className="text-4xl font-bold tracking-tight md:text-5xl">
          Prediction markets on
          <span className="block text-cyan-400">on-chain order books</span>
        </h1>
        <p className="max-w-2xl text-lg text-zinc-400">
          Deposit DBUSDC into a vault, split collateral into YES/NO tokens, and
          trade on a CLOB — with autonomous agents creating markets, quoting
          liquidity, and resolving outcomes. Legacy DeepBook Predict demo included.
        </p>
        <div className="flex flex-wrap gap-3 pt-2">
          <Link
            href="/markets"
            className="rounded-lg bg-cyan-500 px-5 py-2.5 text-sm font-medium text-zinc-950 hover:bg-cyan-400"
          >
            Browse Markets
          </Link>
          <Link
            href="/vault"
            className="rounded-lg border border-zinc-700 px-5 py-2.5 text-sm font-medium text-zinc-200 hover:bg-zinc-800"
          >
            Vault (VLP)
          </Link>
          <Link
            href="/legacy/predict/trade"
            className="rounded-lg border border-zinc-800 px-5 py-2.5 text-sm text-zinc-400 hover:text-zinc-200"
          >
            Legacy Predict
          </Link>
        </div>
      </section>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <Stat label="Active Markets" value={String(active)} />
        </Card>
        <Card>
          <Stat
            label="Vault TVL"
            value={
              vault
                ? `$${(vault.total_balance / 1e6).toLocaleString(undefined, { maximumFractionDigits: 0 })}`
                : "—"
            }
          />
        </Card>
        <Card>
          <Stat
            label="MM Allocated"
            value={
              vault
                ? `$${(vault.allocated / 1e6).toLocaleString(undefined, { maximumFractionDigits: 0 })}`
                : "—"
            }
          />
        </Card>
        <Card>
          <Stat label="Agents" value="Creator · Maker · Resolver" />
        </Card>
      </div>

      <Card title="Featured markets">
        <div className="space-y-3">
          {markets.slice(0, 3).map((m) => (
            <Link
              key={m.id}
              href={`/markets/${encodeURIComponent(m.id)}`}
              className="block rounded-lg border border-zinc-800 px-4 py-3 hover:border-cyan-500/30"
            >
              <p className="font-medium text-zinc-100">{m.title}</p>
              <p className="text-xs text-zinc-500">
                {m.category} · expires {new Date(m.expiry_ms).toLocaleDateString()}
              </p>
            </Link>
          ))}
          {markets.length === 0 && (
            <p className="text-sm text-zinc-500">
              Start agents service to seed demo markets.
            </p>
          )}
        </div>
      </Card>
    </div>
  );
}
