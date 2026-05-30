import Link from "next/link";
import {
  getVaultSummaryClob,
  listMarkets,
} from "@suipredict/sdk";
import { Badge, Card, Stat } from "@/components/ui";

export const dynamic = "force-dynamic";

function formatUsd(value?: number) {
  if (typeof value !== "number") return "$0";
  return `$${(value / 1e6).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

function formatDate(ms: number) {
  return new Date(ms).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

export default async function HomePage() {
  const [markets, vault] = await Promise.all([
    listMarkets().catch(() => []),
    getVaultSummaryClob().catch(() => null),
  ]);

  const active = markets.filter((m) => m.status === "active").length;

  return (
    <div className="space-y-6">
      <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="rounded-lg border border-white/10 bg-[#11141d] p-5 sm:p-6">
          <Badge variant="success">DeepBook V3 CLOB</Badge>
          <h1 className="mt-4 max-w-3xl text-3xl font-semibold tracking-tight text-white sm:text-5xl">
            Trade event probabilities with YES/NO shares.
          </h1>
          <p className="mt-4 max-w-2xl text-sm leading-6 text-zinc-400 sm:text-base">
            Every market is backed by DBUSDC collateral. Split collateral into
            matched YES/NO shares, route orders through the YES order book, and
            redeem the winning outcome after resolution.
          </p>
          <div className="mt-5 flex flex-col gap-3 sm:flex-row">
            <Link
              href="/markets"
              className="inline-flex min-h-11 items-center justify-center rounded-md bg-emerald-400 px-5 text-sm font-semibold text-zinc-950 transition hover:bg-emerald-300"
            >
              Browse markets
            </Link>
            <Link
              href="/vault"
              className="inline-flex min-h-11 items-center justify-center rounded-md border border-white/10 bg-white/[0.04] px-5 text-sm font-semibold text-white transition hover:bg-white/10"
            >
              Manage vault
            </Link>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-1">
          <Card>
            <Stat label="Active markets" value={String(active)} />
          </Card>
          <Card>
            <Stat label="Vault TVL" value={formatUsd(vault?.total_balance)} />
          </Card>
          <Card>
            <Stat label="MM allocated" value={formatUsd(vault?.allocated)} />
          </Card>
          <Card>
            <Stat label="Agents" value="Creator + Maker" />
          </Card>
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex items-end justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold text-white">Featured markets</h2>
            <p className="text-sm text-zinc-500">Active order books ready for probability trading.</p>
          </div>
          <Link href="/markets" className="hidden text-sm font-medium text-emerald-300 hover:text-emerald-200 sm:block">
            View all
          </Link>
        </div>

        <div className="grid gap-3">
          {markets.slice(0, 5).map((m) => (
            <Link
              key={m.id}
              href={`/markets/${encodeURIComponent(m.id)}`}
              className="block rounded-lg border border-white/10 bg-[#11141d] p-4 transition hover:border-emerald-400/40 hover:bg-[#151924]"
            >
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <Badge variant={m.status === "active" ? "success" : "warning"}>
                      {m.status}
                    </Badge>
                    <span className="text-xs text-zinc-500">{m.category}</span>
                    <span className="text-xs text-zinc-500">Ends {formatDate(m.expiry_ms)}</span>
                  </div>
                  <p className="text-base font-semibold text-white sm:text-lg">{m.title}</p>
                  <p className="mt-1 line-clamp-2 text-sm text-zinc-500">{m.description}</p>
                </div>
                <div className="grid min-w-full grid-cols-2 gap-2 sm:min-w-48">
                  <span className="rounded-md bg-emerald-400 px-3 py-2 text-center text-sm font-semibold text-zinc-950">
                    Buy Yes
                  </span>
                  <span className="rounded-md bg-rose-400 px-3 py-2 text-center text-sm font-semibold text-zinc-950">
                    Buy No
                  </span>
                </div>
              </div>
            </Link>
          ))}
          {markets.length === 0 && (
            <div className="rounded-lg border border-dashed border-white/10 bg-[#11141d] px-5 py-10 text-center text-zinc-400">
              Start agents service to seed demo markets.
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
