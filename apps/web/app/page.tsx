import Link from "next/link";
import {
  getVaultSummaryClob,
  listMarkets,
} from "@suipredict/sdk";
import { Card } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const [markets, vault] = await Promise.all([
    listMarkets().catch(() => []),
    getVaultSummaryClob().catch(() => null),
  ]);

  const active = markets.filter((m) => m.status === "active").length;

  return (
    <div className="space-y-10">
      <section className="relative overflow-hidden rounded-3xl border border-white/10 bg-white/5 backdrop-blur-xl shadow-2xl shadow-black/40">
        <div className="absolute inset-0 bg-gradient-to-br from-violet-500/10 via-transparent to-cyan-500/10 pointer-events-none" />
        <div className="relative flex flex-col gap-8 p-8 sm:p-12 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-2xl">
            <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-cyan-400/30 bg-cyan-400/10 px-3 py-1.5 text-xs font-semibold tracking-wide text-cyan-300 shadow-[0_0_15px_rgba(6,182,212,0.2)]">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-cyan-500"></span>
              </span>
              Polymarket CLOB · DeepBook V3
            </div>
            <h1 className="text-4xl font-extrabold tracking-tight sm:text-6xl text-transparent bg-clip-text bg-gradient-to-r from-white via-cyan-100 to-violet-200 drop-shadow-sm">
              Prediction markets on
              <span className="block mt-2">on-chain order books</span>
            </h1>
            <p className="mt-6 max-w-xl text-base leading-relaxed text-zinc-300 sm:text-lg">
              Deposit DBUSDC into a vault, split collateral into YES/NO tokens, and
              trade on a CLOB — with autonomous agents creating markets, quoting
              liquidity, and resolving outcomes. Legacy DeepBook Predict demo included.
            </p>
            <div className="mt-8 flex flex-wrap gap-4">
              <Link
                href="/markets"
                className="inline-flex items-center justify-center rounded-xl bg-gradient-to-r from-violet-600 to-cyan-600 px-6 py-3 text-sm font-semibold text-white shadow-lg shadow-cyan-900/30 transition-all hover:scale-[1.02] hover:shadow-cyan-900/50"
              >
                Browse Markets
              </Link>
              <Link
                href="/vault"
                className="inline-flex items-center justify-center rounded-xl border border-white/20 bg-white/5 px-6 py-3 text-sm font-semibold text-white backdrop-blur-md transition-all hover:bg-white/10"
              >
                Vault (VLP)
              </Link>
              <Link
                href="/legacy/predict/trade"
                className="inline-flex items-center justify-center rounded-xl border border-transparent px-6 py-3 text-sm font-medium text-zinc-400 transition-all hover:text-white"
              >
                Legacy Predict
              </Link>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-2 lg:min-w-64">
            <div className="flex flex-col items-center justify-center rounded-xl border border-white/10 bg-white/5 p-4 backdrop-blur-md shadow-inner transition-transform hover:scale-105">
              <div className="text-3xl font-bold text-white drop-shadow-md">{String(active)}</div>
              <div className="mt-1 text-[10px] font-bold uppercase tracking-widest text-zinc-400">Active Markets</div>
            </div>
            <div className="flex flex-col items-center justify-center rounded-xl border border-emerald-500/20 bg-emerald-500/10 p-4 backdrop-blur-md shadow-[0_0_20px_rgba(16,185,129,0.1)] shadow-inner transition-transform hover:scale-105">
              <div className="text-3xl font-bold text-emerald-300 drop-shadow-md">
                {vault ? `$${(vault.total_balance / 1e6).toLocaleString(undefined, { maximumFractionDigits: 0 })}` : "—"}
              </div>
              <div className="mt-1 text-[10px] font-bold uppercase tracking-widest text-emerald-400/80">Vault TVL</div>
            </div>
            <div className="flex flex-col items-center justify-center rounded-xl border border-cyan-500/20 bg-cyan-500/10 p-4 backdrop-blur-md shadow-[0_0_20px_rgba(6,182,212,0.1)] shadow-inner transition-transform hover:scale-105 sm:col-span-2 lg:col-span-1">
              <div className="text-3xl font-bold text-cyan-300 drop-shadow-md">
                {vault ? `$${(vault.allocated / 1e6).toLocaleString(undefined, { maximumFractionDigits: 0 })}` : "—"}
              </div>
              <div className="mt-1 text-[10px] font-bold uppercase tracking-widest text-cyan-400/80">MM Allocated</div>
            </div>
            <div className="flex flex-col items-center justify-center rounded-xl border border-violet-500/20 bg-violet-500/10 p-4 backdrop-blur-md shadow-[0_0_20px_rgba(139,92,246,0.1)] shadow-inner transition-transform hover:scale-105 sm:col-span-2 lg:col-span-1">
              <div className="text-lg font-bold text-violet-300 drop-shadow-md text-center">Creator<br/>Maker · Resolver</div>
              <div className="mt-1 text-[10px] font-bold uppercase tracking-widest text-violet-400/80">AI Agents</div>
            </div>
          </div>
        </div>
      </section>

      <Card title="Featured markets" className="border-white/10">
        <div className="space-y-3 mt-2">
          {markets.slice(0, 3).map((m) => (
            <Link
              key={m.id}
              href={`/markets/${encodeURIComponent(m.id)}`}
              className="block rounded-xl border border-white/5 bg-white/5 px-5 py-4 transition-all hover:border-cyan-500/30 hover:bg-white/10 hover:shadow-[0_0_15px_rgba(6,182,212,0.1)]"
            >
              <div className="flex justify-between items-start gap-4">
                <p className="font-semibold text-white/90 text-lg">{m.title}</p>
                <span className="shrink-0 rounded-full bg-white/10 px-2.5 py-1 text-xs font-medium text-zinc-300">
                  {m.category}
                </span>
              </div>
              <p className="mt-2 text-sm text-zinc-400">
                Expires {new Date(m.expiry_ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
              </p>
            </Link>
          ))}
          {markets.length === 0 && (
            <div className="rounded-xl border border-white/5 bg-white/5 px-5 py-8 text-center text-zinc-400">
              Start agents service to seed demo markets.
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}
