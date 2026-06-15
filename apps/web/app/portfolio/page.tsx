"use client";

import { useCurrentAccount } from "@mysten/dapp-kit-react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { getPortfolio, listMarkets, type PortfolioPosition } from "@suipredict/sdk";
import { EmptyState } from "@/components/EmptyState";
import { useRouter } from "next/navigation";

export default function PortfolioPage() {
  const account = useCurrentAccount();
  const router = useRouter();

  // Markets count is for the header subtitle. `listMarkets()` returns
  // every market regardless of status (active / resolved / cancelled),
  // but the header copy says "active markets" — filter client-side to
  // keep the contract honest. A `countActiveMarkets` endpoint would be
  // cheaper but isn't worth a new route for a single subtitle.
  const { data: markets = [] } = useQuery({
    queryKey: ["marketsList"],
    queryFn: () => listMarkets().catch(() => []),
    staleTime: 60_000,
  });
  const activeMarketCount = markets.filter((m) => m.status === "active").length;

  // Positions use a `["portfolio", address]` key so other components
  // (DailyPredictionCard after a successful batch mint) can invalidate
  // this query and the user sees fresh positions without a refresh.
  // Background refetch every 8s preserves the previous setInterval
  // behaviour without a raw effect.
  //
  // R43 audit fix: pause the 8s refetch when the tab is hidden.
  // `refetchInterval` accepts a function that returns ms or
  // `false` (TanStack Query ≥4); returning `false` is the
  // canonical "pause the polling" signal. The query stays
  // mounted and `refetchOnWindowFocus` (the default) fires a
  // single `getPortfolio` when the user returns, so the data
  // catches up without a 450-call resume burst. R42 added the
  // same guard to markets/[id], vault, and parlay; portfolio
  // was the survivor.
  const { data: positions = [] } = useQuery<PortfolioPosition[]>({
    queryKey: ["portfolio", account?.address],
    enabled: !!account,
    refetchInterval: () => {
      if (typeof document === "undefined") return 8_000;
      return document.visibilityState === "visible" ? 8_000 : false;
    },
    queryFn: async () => {
      if (!account) return [];
      return getPortfolio(account.address).catch(() => []);
    },
  });

  if (!account) {
    return (
      <div className="space-y-6 sm:space-y-8">
        <div>
          <h1 className="text-3xl font-extrabold tracking-tight text-transparent bg-clip-text bg-gradient-to-r from-white to-cyan-200 sm:text-5xl mb-2">
            Your Portfolio
          </h1>
          <p className="text-zinc-400">
            Track your YES/NO share balances across every active market and redeem winners.
          </p>
        </div>
        <EmptyState
          title="Wallet Disconnected"
          description="Connect your Sui wallet to view your active prediction positions."
          actionLabel="Connect Wallet"
          onAction={() => {
            if (typeof window !== "undefined") {
              window.dispatchEvent(new CustomEvent("open-connect-modal"));
            }
          }}
        />
      </div>
    );
  }

  return (
    <div className="space-y-6 sm:space-y-8">
      {/* Header Section */}
      <div className="relative overflow-hidden rounded-3xl border border-white/10 bg-[#11141d] p-6 sm:p-10 shadow-2xl shadow-black/40">
        <div className="absolute -top-40 -right-40 h-[400px] w-[400px] rounded-full bg-cyan-600/10 blur-[80px] pointer-events-none" />
        <div className="absolute -bottom-40 -left-40 h-[400px] w-[400px] rounded-full bg-violet-600/10 blur-[80px] pointer-events-none" />
        
        <div className="relative z-10">
          <h1 className="text-3xl font-extrabold tracking-tight text-transparent bg-clip-text bg-gradient-to-r from-white to-cyan-200 sm:text-5xl mb-4">
            Your Portfolio
          </h1>
          <p className="max-w-2xl text-base leading-relaxed text-zinc-400">
            Track your YES/NO share balances across {activeMarketCount} active markets.
            Redeem your winning shares directly from the individual market pages once resolved.
          </p>
        </div>
      </div>

      {positions.length === 0 ? (
        <EmptyState
          title="No Open Positions"
          description="You don't have any active YES/NO positions. Mint your first shares from the markets list to start building your portfolio."
          actionLabel="Browse Markets"
          onAction={() => router.push("/markets")}
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {positions.map((p) => {
            // R61 audit fix: surface a "View on
            // SuiVision" link for non-demo market
            // ids (the 0x... Sui object id form). The
            // card itself is a single <Link> wrapper
            // so we can't embed a nested <a>; the
            // fix is an absolutely-positioned icon
            // button in the top-right corner of the
            // card with z-20 so it sits above the
            // card's hit area. The button has its own
            // onClick handler that stops propagation
            // (so the parent <Link> doesn't fire) and
            // the native target="_blank" preserves
            // cmd/ctrl/middle-click "open in new
            // tab". Demo ids (wc26-...) and SuiVision-
            // unsupported networks (localnet) get no
            // link — the icon simply doesn't render.
            const explorerNet = (() => {
              const raw = process.env.NEXT_PUBLIC_SUI_NETWORK ?? "testnet";
              return ["testnet", "mainnet", "devnet"].includes(raw) ? raw : "testnet";
            })();
            const suivisionHref = /^0x[0-9a-fA-F]{64}$/.test(p.market_id)
              ? `https://${explorerNet}.suivision.xyz/object/${p.market_id}`
              : null;
            return (
            <Link key={p.market_id} href={`/markets/${encodeURIComponent(p.market_id)}`} className="block">
              <div className="group relative overflow-hidden rounded-2xl border border-white/10 bg-[#11141d] p-6 shadow-xl shadow-black/40 transition-all hover:-translate-y-1 hover:border-cyan-500/30 hover:shadow-[0_0_30px_rgba(6,182,212,0.15)] h-full">
                <div className="absolute inset-0 bg-gradient-to-b from-white/[0.04] to-transparent pointer-events-none group-hover:from-cyan-500/5 transition-colors" />
                <div className="relative z-10 flex flex-col h-full justify-between gap-4">
                  <div>
                    <div className="mb-2 flex items-center justify-between pr-8">
                      <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold border ${p.status === 'active' ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-300' : 'border-amber-500/20 bg-amber-500/10 text-amber-300'}`}>
                        {p.status}
                      </span>
                      {p.outcome && (
                        <span className="text-xs font-bold text-emerald-400">
                          Winner: {p.outcome.toUpperCase()}
                        </span>
                      )}
                    </div>
                    <h2 className="text-lg font-bold text-white leading-tight group-hover:text-cyan-100 transition-colors">
                      {p.title}
                    </h2>
                  </div>
                  {suivisionHref && (
                    <a
                      href={suivisionHref}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label="View on SuiVision"
                      className="absolute right-3 top-3 z-20 inline-flex h-7 w-7 items-center justify-center rounded-lg border border-white/10 bg-black/40 text-cyan-400 opacity-0 transition-all hover:bg-cyan-500/20 hover:text-cyan-200 hover:border-cyan-500/30 group-hover:opacity-100"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path strokeLinecap="round" d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                        <path strokeLinecap="round" d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                      </svg>
                    </a>
                  )}
                  
                  <div className="grid grid-cols-2 gap-2 mt-2 pt-4 border-t border-white/5">
                    <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-3 text-center transition-colors group-hover:bg-emerald-500/10">
                      <p className="text-xs font-semibold uppercase tracking-wider text-emerald-500 mb-1">YES Shares</p>
                      <p className="text-lg font-bold text-emerald-300">{(p.yes / 1e6).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
                    </div>
                    <div className="rounded-lg border border-rose-500/20 bg-rose-500/5 p-3 text-center transition-colors group-hover:bg-rose-500/10">
                      <p className="text-xs font-semibold uppercase tracking-wider text-rose-500 mb-1">NO Shares</p>
                      <p className="text-lg font-bold text-rose-300">{(p.no / 1e6).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
                    </div>
                  </div>
                </div>
              </div>
            </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
