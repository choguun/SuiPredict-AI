"use client";

import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  useCurrentAccount,
  useCurrentClient,
  useDAppKit,
} from "@mysten/dapp-kit-react";
import {
  listMarkets,
  getMarketOrderBook,
  buildMintSharesBatchTx,
  DUSDC_TYPE,
  type MarketInfo,
} from "@suipredict/sdk";
import { ProbabilityBar } from "@/components/ProbabilityBar";
import { toast } from "sonner";
import Link from "next/link";

const QUOTE_COIN = DUSDC_TYPE;

const FEE_VAULT_ID =
  process.env.NEXT_PUBLIC_FEE_VAULT_ID ??
  "0x0000000000000000000000000000000000000000000000000000000000000000";

/** Daily markets: expiry within 36h from now, status active. */
const DAILY_EXPIRY_WINDOW_MS = 36 * 60 * 60 * 1000;
const DEFAULT_PARLAY_LIMIT = 5;

type Selection = boolean; // true=YES, false=NO

function txDigest(r: { $kind: string; Transaction?: { digest: string } }): string {
  return r.$kind === "Transaction" ? r.Transaction!.digest : "unknown";
}

interface DailyMarket extends MarketInfo {
  yesProbability: number;
}

// Stable empty array reference (see `dailyMarkets` derivation below).
const EMPTY_DAILY_MARKETS: DailyMarket[] = [];

export function DailyPredictionCard() {
  const account = useCurrentAccount();
  const client = useCurrentClient();
  const dAppKit = useDAppKit();
  const queryClient = useQueryClient();

  const [activeMarketIds, setActiveMarketIds] = useState<string[]>([]);
  const [selections, setSelections] = useState<Record<string, Selection>>({});
  const [submitting, setSubmitting] = useState(false);

  const dailyQuery = useQuery({
    queryKey: ["dailyMarkets"],
    staleTime: 30_000,
    queryFn: async (): Promise<DailyMarket[]> => {
      const markets = await listMarkets();
      const now = Date.now();
      const cutoff = now + DAILY_EXPIRY_WINDOW_MS;
      const candidates = markets.filter(
        (m) =>
          m.status === "active" &&
          m.expiry_ms > now &&
          m.expiry_ms <= cutoff,
      );
      const enriched = await Promise.all(
        candidates.slice(0, 12).map(async (m) => {
          try {
            const book = await getMarketOrderBook(m.id);
            return { ...m, yesProbability: book.mid_price || 0.5 };
          } catch {
            return { ...m, yesProbability: 0.5 };
          }
        }),
      );
      return enriched;
    },
  });

  // Use a stable empty-array constant so the downstream useMemo doesn't
  // see a new array reference on every render while the query is in
  // `undefined` state. The previous `dailyQuery.data ?? []` returned a
  // fresh `[]` each evaluation, which made `activeMarkets`'s useMemo
  // re-run and recompute `.filter` on every render.
  const dailyMarkets = dailyQuery.data ?? EMPTY_DAILY_MARKETS;

  const activeMarkets = useMemo(
    () => dailyMarkets.filter((m) => activeMarketIds.includes(m.id)),
    [dailyMarkets, activeMarketIds],
  );

  const activeSelectionsCount = activeMarketIds.filter(
    (id) => selections[id] !== undefined,
  ).length;
  const isComplete =
    activeMarketIds.length > 0 &&
    activeSelectionsCount === activeMarketIds.length;

  const handleAddMarket = () => {
    const nextAvailable = dailyMarkets.find(
      (m) => !activeMarketIds.includes(m.id),
    );
    if (nextAvailable) {
      setActiveMarketIds([...activeMarketIds, nextAvailable.id]);
    }
  };

  const handleRemoveMarket = (id: string) => {
    setActiveMarketIds(activeMarketIds.filter((marketId) => marketId !== id));
    const newSelections = { ...selections };
    delete newSelections[id];
    setSelections(newSelections);
  };

  const handleSubmit = async () => {
    if (!account || !client || !isComplete) return;
    setSubmitting(true);
    try {
      const { objects } = await client.core.listCoins({
        owner: account.address,
        coinType: QUOTE_COIN,
      });
      if (objects.length === 0) {
        throw new Error("No DUSDC — request from DeepBook testnet form");
      }
      // Single PTB: split the input coin N ways and mint into each market.
      // Sequential txs would consume the coin in the first tx, leaving the
      // rest with a stale object reference and a runtime error.
      const amountPerMarket = BigInt(1_000_000); // 1 DUSDC per market
      // Balance preflight: the batch tx needs `amountPerMarket * N` atoms
      // total (splitCoins requires the full input). Without this check the
      // user gets a generic Move abort on the first split — opaque and
      // confusing because the wallet-adapter spinner hides it. We sum
      // across all coins so a user with several small balances isn't
      // wrongly told they have insufficient funds.
      const required = amountPerMarket * BigInt(activeMarketIds.length);
      const totalBalance = objects.reduce(
        (acc, c) => acc + BigInt(c.balance),
        BigInt(0),
      );
      if (totalBalance < required) {
        throw new Error(
          `Insufficient DUSDC: need ${Number(required) / 1_000_000} ` +
            `(${(Number(required) / 1_000_000).toFixed(2)}), ` +
            `have ${(Number(totalBalance) / 1_000_000).toFixed(2)} ` +
            `across ${objects.length} coin(s). Request more from the DeepBook testnet form.`,
        );
      }
      // Pick the largest coin to maximize the chance a single object
      // covers the whole batch. (splitCoins on one big coin is cheaper
      // than merging first, which isn't always available without a
      // separate merge PTB.)
      const coin = objects.sort((a, b) =>
        BigInt(b.balance) > BigInt(a.balance) ? 1 : -1,
      )[0]!;
      const tx = buildMintSharesBatchTx({
        marketIds: activeMarketIds,
        vaultId: FEE_VAULT_ID,
        quoteIn: coin.objectId,
        amountPerMarket,
      });
      const r = await dAppKit.signAndExecuteTransaction({ transaction: tx });
      const digest = txDigest(r);
      toast.success(
        `Predictions locked across ${activeMarketIds.length} markets — ${digest.slice(0, 12)}…`,
      );
      // The position-indexer polls MintedEvent every ~5s but the user's
      // own session is read from the SDK directly. Invalidate the
      // relevant queries so /portfolio, the streak panel, and the
      // markets list reflect the new positions without a manual refresh.
      //
      // Query keys MUST match what the hooks actually register:
      //   useUserStreakId → ["userStreakId", REGISTRY_ID, address]
      //   useStreakInfo   → ["streakInfo", streakId]
      //   useQuery in portfolio page (if converted) → ["portfolio", address]
      // TanStack's prefix-match means a typo (e.g. "streak" vs
      // "streakInfo") silently no-ops the invalidation — the previous
      // round shipped a ["streak"] invalidation that did nothing.
      queryClient.invalidateQueries({ queryKey: ["userStreakId"] });
      queryClient.invalidateQueries({ queryKey: ["streakInfo"] });
      queryClient.invalidateQueries({ queryKey: ["portfolio", account.address] });
      queryClient.invalidateQueries({ queryKey: ["dailyMarkets"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Submit failed");
    } finally {
      setSubmitting(false);
    }
  };

  if (dailyQuery.isLoading) {
    return (
      <div className="flex h-full min-h-[300px] items-center justify-center rounded-2xl border border-white/10 bg-[#11141d] p-8 text-sm text-zinc-500">
        Loading today&apos;s markets…
      </div>
    );
  }

  if (dailyMarkets.length === 0) {
    return (
      <div className="relative flex h-full min-h-[300px] flex-col items-center justify-center overflow-hidden rounded-2xl border border-white/10 bg-[#11141d] p-8 text-center shadow-xl shadow-black/50">
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 h-64 w-64 rounded-full bg-violet-500/10 blur-[80px] -z-10" />
        <h2 className="text-xl font-bold text-white mb-2">No daily markets yet</h2>
        <p className="max-w-xs text-sm leading-relaxed text-zinc-400">
          The market creator agent publishes 5 daily markets at 00:00 UTC. Check
          back soon, or browse active markets.
        </p>
        <Link
          href="/markets"
          className="mt-4 rounded-lg border border-white/10 bg-white/5 px-4 py-2 text-xs font-semibold text-white transition hover:bg-white/10"
        >
          Browse all markets
        </Link>
      </div>
    );
  }

  if (activeMarkets.length === 0) {
    return (
      <div className="relative flex h-full min-h-[300px] flex-col items-center justify-center overflow-hidden rounded-2xl border border-white/10 bg-[#11141d] p-8 text-center shadow-xl shadow-black/50">
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 h-64 w-64 rounded-full bg-violet-500/10 blur-[80px] -z-10" />
        <h2 className="text-xl font-bold text-white mb-2">Build your daily parlay</h2>
        <p className="max-w-xs text-sm leading-relaxed text-zinc-400 mb-4">
          We found {dailyMarkets.length} market
          {dailyMarkets.length === 1 ? "" : "s"} expiring in the next 36 hours.
          Add up to {DEFAULT_PARLAY_LIMIT} to start your streak.
        </p>
        <button
          onClick={() =>
            setActiveMarketIds(
              dailyMarkets.slice(0, DEFAULT_PARLAY_LIMIT).map((m) => m.id),
            )
          }
          className="rounded-lg bg-gradient-to-r from-violet-600 to-cyan-600 px-5 py-2.5 text-sm font-bold text-white shadow-lg shadow-cyan-900/30 transition-all hover:scale-[1.02]"
        >
          Add top {Math.min(DEFAULT_PARLAY_LIMIT, dailyMarkets.length)} markets
        </button>
      </div>
    );
  }

  return (
    <div className="relative flex h-full flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#11141d] p-6 shadow-xl shadow-black/50 transition-all hover:border-violet-500/30 hover:shadow-violet-900/20">
      <div className="absolute -left-20 -bottom-20 h-64 w-64 rounded-full bg-violet-600/10 blur-[80px] -z-10" />

      <div className="mb-6 flex justify-between items-start gap-4">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-white mb-1">Your Daily Parlay</h2>
          <p className="text-sm text-zinc-400">
            Predict {activeMarketIds.length} daily market
            {activeMarketIds.length === 1 ? "" : "s"} correctly to keep your
            streak alive and earn up to{" "}
            <span className="font-semibold text-emerald-400">150% yield boost</span>.
          </p>
        </div>
        {activeMarketIds.length < Math.min(DEFAULT_PARLAY_LIMIT, dailyMarkets.length) && (
          <button
            onClick={handleAddMarket}
            className="shrink-0 flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-white/10"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
            </svg>
            Add Leg
          </button>
        )}
      </div>

      <div className="flex-1 space-y-3">
        {activeMarkets.map((market, idx) => {
          const selected = selections[market.id];
          return (
            <div
              key={market.id}
              className={`relative group flex flex-col gap-4 rounded-xl border p-4 transition-all sm:flex-row sm:items-center sm:justify-between ${
                selected !== undefined
                  ? "border-white/10 bg-white/[0.04]"
                  : "border-white/5 bg-white/[0.02] hover:border-cyan-500/30 hover:bg-[#151924]"
              }`}
            >
              <div className="flex flex-1 flex-col gap-3 pr-8 sm:pr-0">
                <div className="flex items-start gap-4">
                  <div className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold transition-colors ${
                    selected !== undefined ? "bg-white/20 text-white" : "bg-white/10 text-zinc-500 group-hover:bg-cyan-500/20 group-hover:text-cyan-400"
                  }`}>
                    {idx + 1}
                  </div>
                  <div className="flex w-full flex-col gap-2.5">
                    <Link
                      href={`/markets/${encodeURIComponent(market.id)}`}
                      className={`text-sm font-medium transition-colors hover:text-cyan-300 ${selected !== undefined ? "text-zinc-300" : "text-white"}`}
                    >
                      {market.title}
                    </Link>
                    <div className="flex items-center gap-3">
                      <ProbabilityBar yesProbability={market.yesProbability} className="h-1.5 opacity-60 group-hover:opacity-100 transition-opacity" />
                      <span className="shrink-0 text-[10px] font-bold tracking-wider text-zinc-500 uppercase">
                        {Math.round(market.yesProbability * 100)}% YES
                      </span>
                    </div>
                  </div>
                </div>
              </div>

              <button
                onClick={() => handleRemoveMarket(market.id)}
                className="absolute right-3 top-3 sm:relative sm:right-auto sm:top-auto sm:ml-2 flex h-6 w-6 items-center justify-center rounded-full text-zinc-500 transition-colors hover:bg-rose-500/20 hover:text-rose-400 sm:order-last"
                title="Remove Leg"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>

              <div className="flex shrink-0 gap-2 items-center w-full sm:w-auto mt-2 sm:mt-0">
                <button
                  onClick={() => setSelections((s) => ({ ...s, [market.id]: true }))}
                  className={`flex-1 sm:flex-none sm:w-20 rounded-lg px-3 py-2.5 text-xs font-bold transition-all ${
                    selected === true
                      ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 shadow-[0_0_15px_rgba(16,185,129,0.2)] scale-105"
                      : "bg-black/40 text-zinc-500 hover:bg-white/10 hover:text-white border border-white/5"
                  }`}
                >
                  YES
                </button>
                <button
                  onClick={() => setSelections((s) => ({ ...s, [market.id]: false }))}
                  className={`flex-1 sm:flex-none sm:w-20 rounded-lg px-3 py-2.5 text-xs font-bold transition-all ${
                    selected === false
                      ? "bg-rose-500/20 text-rose-300 border border-rose-500/40 shadow-[0_0_15px_rgba(244,63,94,0.2)] scale-105"
                      : "bg-black/40 text-zinc-500 hover:bg-white/10 hover:text-white border border-white/5"
                  }`}
                >
                  NO
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-6 border-t border-white/5 pt-6">
        <button
          onClick={handleSubmit}
          disabled={
            !account || !isComplete || submitting || activeMarketIds.length === 0
          }
          className="w-full rounded-xl bg-gradient-to-r from-violet-600 to-cyan-600 py-3.5 text-sm font-bold text-white shadow-lg shadow-cyan-900/30 transition-all hover:scale-[1.02] disabled:opacity-50 disabled:scale-100 disabled:shadow-none"
        >
          {submitting
            ? "Minting shares…"
            : !account
              ? "Connect wallet to lock in"
              : `Lock In Predictions (${activeSelectionsCount}/${activeMarketIds.length})`}
        </button>
      </div>
    </div>
  );
}
