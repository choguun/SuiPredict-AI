import Link from "next/link";
import {
  getVaultSummaryClob,
  listMarkets,
} from "@suipredict/sdk";
import { Badge } from "@/components/ui";
import { DailyPredictionCard } from "@/components/DailyPredictionCard";
import { StreakProfile } from "@/components/StreakProfile";
import { ProbabilityBar } from "@/components/ProbabilityBar";
import { EmptyState } from "@/components/EmptyState";

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

function getPseudoProbability(id: string) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = id.charCodeAt(i) + ((hash << 5) - hash);
  }
  const val = Math.abs(hash) % 100;
  return Math.max(10, Math.min(90, val)) / 100;
}

export default async function HomePage() {
  const [markets, vault] = await Promise.all([
    listMarkets().catch(() => []),
    getVaultSummaryClob().catch(() => null),
  ]);

  const active = markets.filter((m) => m.status === "active").length;

  return (
    <div className="space-y-6 sm:space-y-12 pb-6 sm:pb-12">
      {/* 1. Mobile Greeting (Hidden on Desktop) */}
      <div className="sm:hidden flex items-center justify-between mb-2">
        <h1 className="text-2xl font-bold text-white">GM, Trader 🔥</h1>
      </div>

      {/* 2. Massive Hero Section (Hidden on Mobile) */}
      <section className="hidden sm:block relative overflow-hidden rounded-3xl border border-white/10 bg-black/40 p-8 sm:p-16 backdrop-blur-xl">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-violet-900/40 via-[#0B0E14]/80 to-[#0B0E14] -z-10" />
        <div className="absolute -top-40 -right-40 h-[500px] w-[500px] rounded-full bg-cyan-600/20 blur-[100px] -z-10" />
        
        <div className="relative z-10 max-w-3xl">
          <Badge variant="success" className="bg-emerald-500/10 text-emerald-300 border-emerald-500/20 mb-6">
            DeepBook V3 Powered CLOB
          </Badge>
          <h1 className="text-4xl font-extrabold tracking-tight text-transparent bg-clip-text bg-gradient-to-br from-white via-white to-cyan-200 sm:text-6xl mb-6">
            Predict the future. <br className="hidden sm:block" />
            Trade probability.
          </h1>
          <p className="text-base leading-relaxed text-zinc-400 sm:text-xl mb-8 max-w-2xl">
            SuiPredict AI is the next-generation prediction market. Every market is backed by DBUSDC collateral. Split collateral into matched YES/NO shares and trade with instant settlement.
          </p>
          
          <div className="flex flex-col sm:flex-row gap-4">
            <Link
              href="/markets"
              className="inline-flex min-h-14 items-center justify-center rounded-xl bg-gradient-to-r from-violet-600 to-cyan-600 px-8 text-base font-bold text-white shadow-[0_0_40px_rgba(6,182,212,0.3)] transition-all hover:scale-[1.02] hover:shadow-[0_0_60px_rgba(6,182,212,0.5)]"
            >
              Start Trading Now
            </Link>
            <Link
              href="/vault"
              className="inline-flex min-h-14 items-center justify-center rounded-xl border border-white/10 bg-white/5 px-8 text-base font-semibold text-white backdrop-blur-md transition-all hover:bg-white/10 hover:border-white/20"
            >
              Provide Liquidity
            </Link>
          </div>
        </div>
      </section>

      {/* 3. Platform Stats (Hidden on smaller screens to prioritize Gamification) */}
      <section className="hidden lg:grid grid-cols-4 gap-4">
        <div className="group rounded-2xl border border-white/5 bg-gradient-to-b from-white/[0.04] to-transparent p-6 transition-all hover:-translate-y-1 hover:border-emerald-500/30 hover:shadow-[0_0_30px_rgba(16,185,129,0.1)]">
          <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-400">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
            </svg>
          </div>
          <p className="text-sm font-medium text-zinc-500">Active Markets</p>
          <p className="mt-1 text-3xl font-bold text-white">{active}</p>
        </div>

        <div className="group rounded-2xl border border-white/5 bg-gradient-to-b from-white/[0.04] to-transparent p-6 transition-all hover:-translate-y-1 hover:border-cyan-500/30 hover:shadow-[0_0_30px_rgba(6,182,212,0.1)]">
          <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-lg bg-cyan-500/10 text-cyan-400">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <p className="text-sm font-medium text-zinc-500">Vault TVL</p>
          <p className="mt-1 text-3xl font-bold text-white">{formatUsd(vault?.total_balance)}</p>
        </div>

        <div className="group rounded-2xl border border-white/5 bg-gradient-to-b from-white/[0.04] to-transparent p-6 transition-all hover:-translate-y-1 hover:border-violet-500/30 hover:shadow-[0_0_30px_rgba(139,92,246,0.1)]">
          <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-lg bg-violet-500/10 text-violet-400">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
            </svg>
          </div>
          <p className="text-sm font-medium text-zinc-500">MM Allocated</p>
          <p className="mt-1 text-3xl font-bold text-white">{formatUsd(vault?.allocated)}</p>
        </div>

        <div className="group rounded-2xl border border-white/5 bg-gradient-to-b from-white/[0.04] to-transparent p-6 transition-all hover:-translate-y-1 hover:border-blue-500/30 hover:shadow-[0_0_30px_rgba(59,130,246,0.1)]">
          <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-lg bg-blue-500/10 text-blue-400">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
            </svg>
          </div>
          <p className="text-sm font-medium text-zinc-500">AI Agents</p>
          <p className="mt-1 text-3xl font-bold text-white">Creator + Maker</p>
        </div>
      </section>

      {/* 4. Gamification Row (Prioritized on Mobile) */}
      <section className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-1">
          <StreakProfile />
        </div>
        <div className="lg:col-span-2">
          <DailyPredictionCard />
        </div>
      </section>

      {/* 5. Featured Markets Bento Grid */}
      <section className="space-y-4 sm:space-y-6">
        <div className="flex items-end justify-between gap-3">
          <div>
            <h2 className="text-2xl font-bold tracking-tight text-white">Featured Markets</h2>
            <p className="mt-1 text-sm text-zinc-400">High volume markets hand-picked for you.</p>
          </div>
          <Link href="/markets" className="hidden rounded-lg bg-white/5 px-4 py-2 text-sm font-medium text-white hover:bg-white/10 sm:block transition-colors">
            View all
          </Link>
        </div>

        {markets.length === 0 ? (
          <EmptyState
            title="No Featured Markets"
            description="Start the agents service to seed demo markets or connect to the live network."
            actionLabel="View All Markets"
            onAction={() => {}} // Note: EmptyState needs a generic link or we just pass action handler
          />
        ) : (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-2">
            {markets.slice(0, 4).map((m) => {
              const prob = getPseudoProbability(m.id);
              return (
                <Link
                  key={m.id}
                  href={`/markets/${encodeURIComponent(m.id)}`}
                  className="group relative flex flex-col justify-between overflow-hidden rounded-2xl border border-white/10 bg-[#11141d] p-6 transition-all hover:border-cyan-500/30 hover:bg-[#151924] hover:shadow-2xl hover:shadow-cyan-900/10"
                >
                  <div className="min-w-0">
                    <div className="mb-4 flex flex-wrap items-center gap-2">
                      <Badge variant={m.status === "active" ? "success" : "warning"} className="px-2.5 py-0.5 rounded-full">
                        {m.status}
                      </Badge>
                      <span className="rounded-full bg-white/5 px-2.5 py-0.5 text-xs font-medium text-zinc-300">{m.category}</span>
                      <span className="text-xs font-medium text-zinc-500">Ends {formatDate(m.expiry_ms)}</span>
                    </div>
                    <h3 className="text-xl font-bold text-white mb-2 leading-tight group-hover:text-cyan-100 transition-colors">{m.title}</h3>
                    <p className="line-clamp-2 text-sm text-zinc-400 mb-6">{m.description}</p>
                  </div>
                  
                  <div className="mt-auto">
                    {m.status === "active" ? (
                      <div className="space-y-2">
                        <div className="flex justify-between text-xs font-bold uppercase tracking-wider">
                          <span className="text-emerald-400">{Math.round(prob * 100)}% YES</span>
                          <span className="text-rose-400">{Math.round((1 - prob) * 100)}% NO</span>
                        </div>
                        <ProbabilityBar yesProbability={prob} className="h-2.5" />
                        
                        <div className="mt-4 grid grid-cols-2 gap-3 opacity-0 translate-y-2 transition-all duration-300 group-hover:opacity-100 group-hover:translate-y-0">
                          <div className="flex items-center justify-center rounded-lg bg-emerald-500/20 py-2.5 text-sm font-semibold text-emerald-300 border border-emerald-500/30 transition-colors hover:bg-emerald-500/30">
                            Buy YES
                          </div>
                          <div className="flex items-center justify-center rounded-lg bg-rose-500/20 py-2.5 text-sm font-semibold text-rose-300 border border-rose-500/30 transition-colors hover:bg-rose-500/30">
                            Buy NO
                          </div>
                        </div>
                      </div>
                    ) : m.outcome ? (
                      <div className="inline-flex items-center gap-2 rounded-lg bg-emerald-500/10 px-4 py-2 border border-emerald-500/20">
                        <span className="text-sm font-bold text-emerald-400">
                          WINNER: {m.outcome.toUpperCase()}
                        </span>
                      </div>
                    ) : null}
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
