"use client";

import { useCurrentAccount, useCurrentClient, useDAppKit } from "@mysten/dapp-kit-react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getPortfolio,
  listMarkets,
  type PortfolioPosition,
  buildRedeemTx,
  buildRedeemNoTx,
  buildRedeemWithStreakTx,
  buildRedeemNoWithStreakTx,
  yesCoinType,
  noCoinType,
  normalizeObjectId,
  isMoveAbortInModule,
} from "@suipredict/sdk";
import { EmptyState, openConnectModal } from "@/components/EmptyState";
import { useRouter } from "next/navigation";
import { SuivisionLink } from "@/components/SuivisionLink";
import { useUserStreakId } from "@/hooks/useUserStreakId";
import { useState } from "react";
import { toast } from "sonner";
import { submitAndWait } from "@/lib/dapp-kit";

export default function PortfolioPage() {
  const account = useCurrentAccount();
  const router = useRouter();
  const client = useCurrentClient();
  const dAppKit = useDAppKit();
  const queryClient = useQueryClient();
  const { streakId } = useUserStreakId(account?.address);
  const [redeemingMarketId, setRedeemingMarketId] = useState<string | null>(null);

  const friendlyMoveError = (err: unknown, action: string): string => {
    if (isMoveAbortInModule(err, "prediction_market")) {
      return `${action} failed: the market is paused or already settled.`;
    }
    if (isMoveAbortInModule(err, "balance_manager")) {
      return `${action} failed: balance manager invariant violated (insufficient funds?).`;
    }
    if (isMoveAbortInModule(err, "deepbook")) {
      return `${action} failed: DeepBook pool rejected the order.`;
    }
    if (isMoveAbortInModule(err, "dusdc")) {
      return `${action} failed: insufficient DUSDC balance.`;
    }
    if (isMoveAbortInModule(err, "agent_policy")) {
      return `${action} failed: agent policy paused, revoked, or out of budget.`;
    }
    return `${action} failed on-chain`;
  };

  const handleRedeem = async (e: React.MouseEvent, p: PortfolioPosition) => {
    e.preventDefault();
    e.stopPropagation();
    // R63 audit fix: gate on `!client` too. The
    // pre-flight `client.core.listCoins` and the
    // `submitAndWait` call both throw if dapp-kit is
    // still initializing (race on initial mount) or
    // after a wallet disconnect mid-render. The
    // sibling markets/[id], dispute, vault, and
    // parlay pages all gate on
    // `!account || !client || !...` BEFORE calling
    // `submitAndWait`; the portfolio page was the
    // survivor. The bug surfaces as a "Cannot read
    // properties of undefined" TypeError that
    // crashes the catch block before the friendly
    // "Redeem failed" toast can render.
    if (!account || !client) return;

    const toastId = toast.loading("Preparing redeem transaction...");
    setRedeemingMarketId(p.market_id);

    try {
      const winningSide = p.outcome;
      if (winningSide !== "yes" && winningSide !== "no") {
        throw new Error("Cannot redeem: market outcome is not YES or NO.");
      }

      const winningCoinType = winningSide === "yes" ? yesCoinType() : noCoinType();

      // List user's winning coins
      const { objects } = await client.core.listCoins({
        owner: normalizeObjectId(account.address),
        coinType: winningCoinType,
        limit: 100,
      });

      const sortedWinning = [...objects].sort((a, b) =>
        BigInt(b.balance) > BigInt(a.balance) ? 1 : -1,
      );
      const coin = sortedWinning[0];
      if (!coin) {
        throw new Error(
          `You don't hold any ${winningSide.toUpperCase()} tokens for this market`
        );
      }

      toast.loading(
        streakId ? "Redeeming with streak boost..." : "Redeeming...",
        { id: toastId }
      );

      const FEE_VAULT_ID = process.env.NEXT_PUBLIC_FEE_VAULT_ID ?? "";
      if (!FEE_VAULT_ID) {
        throw new Error("NEXT_PUBLIC_FEE_VAULT_ID is not configured in env");
      }

      const redeemMarketId = p.onchain_market_id ?? p.market_id;
      const tx =
        winningSide === "yes"
          ? streakId
            ? buildRedeemWithStreakTx(redeemMarketId, FEE_VAULT_ID, coin.objectId, streakId)
            : buildRedeemTx(redeemMarketId, FEE_VAULT_ID, coin.objectId)
          : streakId
            ? buildRedeemNoWithStreakTx(redeemMarketId, FEE_VAULT_ID, coin.objectId, streakId)
            : buildRedeemNoTx(redeemMarketId, FEE_VAULT_ID, coin.objectId);

      const r = await submitAndWait(dAppKit, client, tx);
      if (r.$kind !== "Transaction") {
        toast.error(friendlyMoveError(r.error, "Redeem"), { id: toastId });
        return;
      }
      if (!r.digest) {
        toast.error(friendlyMoveError(undefined, "Redeem"), { id: toastId });
        return;
      }

      toast.success(`Redeemed: ${r.digest.slice(0, 16)}…`, { id: toastId });

      // Invalidate portfolio and market list queries
      void queryClient.invalidateQueries({
        queryKey: ["portfolio", account.address],
        type: "active",
      });
      void queryClient.invalidateQueries({
        queryKey: ["marketsList"],
        type: "active",
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Redeem failed", { id: toastId });
    } finally {
      setRedeemingMarketId(null);
    }
  };

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
          icon="wallet"
          title="Wallet Disconnected"
          description="Connect your Sui wallet to view your active prediction positions. Your portfolio tracks YES/NO shares across every market you've traded."
          actionLabel="Connect Wallet"
          onAction={openConnectModal}
          previews={[
            "Active YES/NO share balances per market",
            "Current mark-to-market value in DUSDC",
            "Redeemable winners (one click → on-chain)",
            "Daily P&L streak from your predictions",
          ]}
        />
      </div>
    );
  }

  return (
    <div className="space-y-6 sm:space-y-8">
      {/* Header Section */}
      <div className="relative overflow-hidden rounded-3xl border border-white/10 bg-panel-strong p-6 sm:p-10 shadow-2xl shadow-black/40">
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
            return (
            <Link key={p.market_id} href={`/markets/${encodeURIComponent(p.market_id)}`} className="block">
              <div className="group relative overflow-hidden rounded-2xl border border-white/10 bg-panel-strong p-6 shadow-xl shadow-black/40 transition-all hover:-translate-y-1 hover:border-cyan-500/30 hover:shadow-[0_0_30px_rgba(6,182,212,0.15)] h-full">
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
                  <SuivisionLink
                    objectId={p.market_id}
                    className="absolute right-3 top-3 z-20"
                  />
                  
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
                  {p.status === "resolved" && p.outcome && (
                    ((p.outcome === "yes" && p.yes > 0) || (p.outcome === "no" && p.no > 0)) ? (
                      <button
                        onClick={(e) => handleRedeem(e, p)}
                        disabled={redeemingMarketId !== null}
                        className="mt-3 w-full rounded-xl bg-gradient-to-r from-emerald-500 to-teal-600 px-4 py-2.5 text-center text-xs font-bold text-emerald-950 hover:from-emerald-400 hover:to-teal-500 disabled:opacity-50 transition shadow-lg shadow-emerald-950/20 z-30 relative"
                      >
                        {redeemingMarketId === p.market_id
                          ? "Redeeming..."
                          : `Redeem Winning ${p.outcome.toUpperCase()} Shares`}
                      </button>
                    ) : (
                      <div className="mt-3 w-full rounded-xl border border-white/5 bg-white/[0.02] px-4 py-2 text-center text-xs text-zinc-500">
                        Position Closed (Lost or Redeemed)
                      </div>
                    )
                  )}
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
