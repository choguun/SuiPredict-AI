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
  normalizeObjectId,
  type MarketInfo,
} from "@suipredict/sdk";
import { ProbabilityBar } from "@/components/ProbabilityBar";
import { submitAndWait } from "@/lib/dapp-kit";
import { toast } from "sonner";
import Link from "next/link";

const QUOTE_COIN = DUSDC_TYPE;

// R50 audit fix: was `?? "0x000…000"`. The `if (!FEE_VAULT_ID)`
// guard at line 114 evaluated `if (!"0x000…000")` (false), so the
// "FEE_VAULT_ID is not set" toast never fired. Mirror the
// `app/admin/page.tsx:81` `?? ""` pattern.
const FEE_VAULT_ID = process.env.NEXT_PUBLIC_FEE_VAULT_ID ?? "";

/** Daily markets: expiry within 36h from now, status active. */
const DAILY_EXPIRY_WINDOW_MS = 36 * 60 * 60 * 1000;
const DEFAULT_PARLAY_LIMIT = 5;

type Selection = boolean; // true=YES, false=NO

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
  // R62 audit fix: explicit "browse" mode for
  // choosing which daily markets to add. The
  // pre-R62 flow had a single "Add Leg" button
  // that picked the first available market in
  // the list — a user who wanted to skip the
  // boring one and start with the World Cup
  // match had to add 5 legs, remove the boring
  // one, then re-add the WC one. The browse
  // toggle expands the empty-state to a
  // checkbox list of all available daily
  // markets; the user can pick and choose
  // before locking the parlay. The state
  // collapses back to the compact view on
  // submit / on toggle.
  const [browseMode, setBrowseMode] = useState(false);

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



  const handleRemoveMarket = (id: string) => {
    setActiveMarketIds(activeMarketIds.filter((marketId) => marketId !== id));
    const newSelections = { ...selections };
    delete newSelections[id];
    setSelections(newSelections);
  };

  const handleSubmit = async () => {
    if (!account || !client || !isComplete) return;
    if (!FEE_VAULT_ID) {
      toast.error("NEXT_PUBLIC_FEE_VAULT_ID is not set in this deployment.");
      return;
    }
    setSubmitting(true);
    try {
      // R51 audit fix: normalize the owner
      // address. `listCoins` is case-sensitive
      // on the wire — a mixed-case Enoki
      // zkLogin session would otherwise
      // silently return `{ objects: [] }`
      // and the user would hit the "No
      // DUSDC" branch even though they
      // hold a balance.
      const { objects } = await client.core.listCoins({
        owner: normalizeObjectId(account.address),
        coinType: QUOTE_COIN,
        // R52 audit fix: bump default 50-coin
        // page to 100. The pre-flight sum
        // (`totalBalance`) under-counts beyond
        // the page size, so a user with 60
        // DUSDC fragments would be wrongly told
        // they have insufficient funds for a
        // 1-coin mint and the wallet spinner
        // would burn a gas fee on a doomed PTB.
        limit: 100,
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
      //
      // R57.M4 audit fix: spread into a new array before
      // sorting. The in-place `.sort()` mutates the SDK
      // response, which can be reused by subsequent
      // `listCoins` calls in the same component. The
      // R55 vault fix used the spread pattern; this
      // call site was missed.
      const sortedCoins = [...objects].sort((a, b) =>
        BigInt(b.balance) > BigInt(a.balance) ? 1 : -1,
      );
      const coin = sortedCoins[0]!;
      const tx = buildMintSharesBatchTx({
        marketIds: activeMarketIds,
        vaultId: FEE_VAULT_ID,
        quoteIn: coin.objectId,
        amountPerMarket,
      });
      // R55 audit fix: route through `submitAndWait` so the
      // invalidateQueries that follow hit a node that has
      // already finalized the tx. The previous
      // `signAndExecuteTransaction` call returned immediately
      // after signing; the React Query refetch raced on-chain
      // finalization and the user saw a stale portfolio for
      // ~1-2s.
      const r = await submitAndWait(dAppKit, client, tx);
      // $kind guard: a Failed / EffectsCert result carries no digest,
      // so toasting a success message with a real success tone would
      // lie to the user. Only proceed to the success toast when the
      // fullnode actually accepted the tx.
      if (r.$kind !== "Transaction" || !r.digest) {
        toast.error("Batch mint failed");
        return;
      }
      toast.success(
        `Predictions locked across ${activeMarketIds.length} markets — ${r.digest.slice(0, 12)}…`,
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
      //
      // R43 audit fix: pass `type: "active"` so the prefix-only
      // keys `["userStreakId"]` and `["streakInfo"]` match the
      // hook-registered 3-tuple / 2-tuple keys. Without
      // `type: "active"`, the invalidation is exact-match against
      // the prefix-less key and matches zero registered queries
      // — the success path then re-renders with stale streak
      // data. R40 added the same guard to StreakProfile.tsx;
      // DailyPredictionCard was the survivor. `["portfolio", …]`
      // and `["dailyMarkets"]` are already prefix-exact so they
      // can stay; the `type` arg is harmless there.
      queryClient.invalidateQueries({ queryKey: ["userStreakId"], type: "active" });
      queryClient.invalidateQueries({ queryKey: ["streakInfo"], type: "active" });
      queryClient.invalidateQueries({ queryKey: ["portfolio", account.address], type: "active" });
      queryClient.invalidateQueries({ queryKey: ["dailyMarkets"], type: "active" });
      // R48 audit fix: also invalidate the markets-list query that
      // the /portfolio page reads for the "X active markets"
      // subtitle. Without this, the subtitle is stale for 60s
      // after a daily batch mint.
      queryClient.invalidateQueries({ queryKey: ["marketsList"], type: "active" });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Submit failed");
    } finally {
      setSubmitting(false);
    }
  };

  if (dailyQuery.isLoading) {
    return (
      <div className="relative flex h-full flex-col overflow-hidden rounded-2xl border border-white/10 bg-panel-strong p-6 shadow-xl shadow-black/50 transition-all min-h-[350px]">
        <div className="absolute -left-20 -bottom-20 h-64 w-64 rounded-full bg-violet-600/10 blur-[80px] -z-10" />
        <div className="mb-6 flex justify-between items-start gap-4">
          <div>
            <h2 className="text-xl font-bold tracking-tight text-white mb-1">Your Daily Parlay</h2>
            <p className="text-xs text-zinc-400">
              Predict daily matches correctly to keep your streak alive and earn up to{" "}
              <span className="font-semibold text-emerald-400">150% yield boost</span>.
            </p>
          </div>
        </div>
        <div className="flex-1 flex flex-col items-center justify-center text-sm text-zinc-500">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-violet-500 mb-3" />
          <span>Loading today&apos;s matches…</span>
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex h-full flex-col overflow-hidden rounded-2xl border border-white/10 bg-panel-strong p-6 shadow-xl shadow-black/50 transition-all hover:border-violet-500/30 hover:shadow-violet-900/20 min-h-[350px]">
      <div className="absolute -left-20 -bottom-20 h-64 w-64 rounded-full bg-violet-600/10 blur-[80px] -z-10" />

      {/* Header - Always Unified */}
      <div className="mb-6 flex justify-between items-start gap-4">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-white mb-1">Your Daily Parlay</h2>
          <p className="text-xs text-zinc-400">
            Predict daily matches correctly to keep your streak alive and earn up to{" "}
            <span className="font-semibold text-emerald-400">150% yield boost</span>.
          </p>
        </div>

        {/* Toggle checklist button */}
        {dailyMarkets.length > 0 && (
          <button
            onClick={() => setBrowseMode((b) => !b)}
            className={`shrink-0 flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold transition-all ${
              browseMode
                ? "border-violet-500/50 bg-violet-500/20 text-violet-300"
                : "border-white/10 bg-white/5 text-white hover:bg-white/10"
            }`}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
              {browseMode ? (
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              ) : (
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16m-7 6h7" />
              )}
            </svg>
            {browseMode ? "Done" : "Choose Legs"}
          </button>
        )}
      </div>

      {/* Body States */}
      {dailyMarkets.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center text-center p-4">
          <h3 className="text-lg font-bold text-white mb-2">No daily markets yet</h3>
          <p className="max-w-xs text-xs leading-relaxed text-zinc-400 mb-4">
            The market creator agent publishes daily markets at 00:00 UTC. Check back soon, or browse active markets.
          </p>
          <Link
            href="/markets"
            className="rounded-lg border border-white/10 bg-white/5 px-4 py-2 text-xs font-semibold text-white transition hover:bg-white/10"
          >
            Browse all markets
          </Link>
        </div>
      ) : browseMode ? (
        /* Checklist Selection View */
        <div className="flex-1 flex flex-col gap-4">
          <div className="flex justify-between items-center px-1">
            <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">
              Pick up to {Math.min(DEFAULT_PARLAY_LIMIT, dailyMarkets.length)} legs
            </span>
            {activeMarketIds.length > 0 && (
              <button
                onClick={() => {
                  setActiveMarketIds([]);
                  setSelections({});
                }}
                className="text-[10px] font-semibold text-zinc-500 hover:text-rose-400 transition-colors"
              >
                Clear All
              </button>
            )}
          </div>

          <div className="flex-1 overflow-y-auto max-h-[260px] space-y-2 pr-1">
            {dailyMarkets.map((m) => {
              const checked = activeMarketIds.includes(m.id);
              const atCap = activeMarketIds.length >= DEFAULT_PARLAY_LIMIT;
              return (
                <label
                  key={m.id}
                  className={`flex cursor-pointer items-center gap-3 rounded-xl border p-3 transition-all ${
                    checked
                      ? "border-violet-500/40 bg-violet-500/10 shadow-[0_0_10px_rgba(139,92,246,0.05)]"
                      : atCap
                        ? "border-white/5 bg-white/[0.01] opacity-40 cursor-not-allowed"
                        : "border-white/10 bg-black/20 hover:border-cyan-500/30 hover:bg-black/30"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={!checked && atCap}
                    onChange={(e) => {
                      if (e.target.checked) {
                        setActiveMarketIds([...activeMarketIds, m.id]);
                      } else {
                        setActiveMarketIds(
                          activeMarketIds.filter((id) => id !== m.id),
                        );
                        const next = { ...selections };
                        delete next[m.id];
                        setSelections(next);
                      }
                    }}
                    className="h-4 w-4 rounded border-white/20 bg-black/40 accent-violet-500 cursor-pointer disabled:cursor-not-allowed"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-semibold text-white">{m.title}</p>
                    <p className="text-[10px] uppercase tracking-wider text-zinc-500 mt-0.5">
                      {m.category} · {Math.round(m.yesProbability * 100)}% YES
                    </p>
                  </div>
                </label>
              );
            })}
          </div>

          <button
            onClick={() => setBrowseMode(false)}
            className="w-full mt-2 rounded-xl bg-white/5 border border-white/10 py-3 text-xs font-bold text-white transition hover:bg-white/10"
          >
            Show Selection Details ({activeMarketIds.length} leg{activeMarketIds.length === 1 ? "" : "s"} added)
          </button>
        </div>
      ) : activeMarketIds.length === 0 ? (
        /* Empty selections state */
        <div className="flex-1 flex flex-col items-center justify-center text-center p-4">
          <div className="h-12 w-12 rounded-full bg-violet-500/10 flex items-center justify-center mb-3 text-violet-400">
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
            </svg>
          </div>
          <h3 className="text-sm font-bold text-white mb-1">Build Your Parlay</h3>
          <p className="max-w-xs text-xs leading-relaxed text-zinc-400 mb-5">
            We found {dailyMarkets.length} match{dailyMarkets.length === 1 ? "" : "es"} for today.
            Add up to {DEFAULT_PARLAY_LIMIT} to qualify for a streak.
          </p>
          <div className="flex flex-col gap-2 w-full max-w-[280px]">
            <button
              onClick={() => {
                setActiveMarketIds(
                  dailyMarkets.slice(0, DEFAULT_PARLAY_LIMIT).map((m) => m.id),
                );
              }}
              className="rounded-lg bg-gradient-to-r from-violet-600 to-cyan-600 py-2.5 text-xs font-bold text-white shadow-lg shadow-cyan-900/30 transition hover:scale-[1.02]"
            >
              Quick Add Top {Math.min(DEFAULT_PARLAY_LIMIT, dailyMarkets.length)} Matches
            </button>
            <button
              onClick={() => setBrowseMode(true)}
              className="rounded-lg border border-white/10 bg-white/5 py-2.5 text-xs font-bold text-white transition hover:bg-white/10"
            >
              Choose Custom Legs
            </button>
          </div>
        </div>
      ) : (
        /* Active Selected Legs List */
        <div className="flex-1 flex flex-col justify-between">
          <div className="space-y-3 overflow-y-auto max-h-[300px] pr-1">
            {activeMarkets.map((market, idx) => {
              const selected = selections[market.id];
              return (
                <div
                  key={market.id}
                  className={`relative group flex flex-col gap-3 rounded-xl border p-4 transition-all sm:flex-row sm:items-center sm:justify-between ${
                    selected !== undefined
                      ? "border-white/10 bg-white/[0.04]"
                      : "border-white/5 bg-white/[0.02] hover:border-cyan-500/30 hover:bg-panel-hover"
                  }`}
                >
                  <div className="flex flex-1 flex-col gap-2.5 pr-8 sm:pr-0 min-w-0">
                    <div className="flex items-start gap-3">
                      <div className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-bold transition-colors ${
                        selected !== undefined ? "bg-white/20 text-white" : "bg-white/10 text-zinc-500 group-hover:bg-cyan-500/20 group-hover:text-cyan-400"
                      }`}>
                        {idx + 1}
                      </div>
                      <div className="flex w-full flex-col gap-2 min-w-0">
                        <Link
                          href={`/markets/${encodeURIComponent(market.id)}`}
                          className={`text-xs font-medium transition-colors hover:text-cyan-300 truncate ${selected !== undefined ? "text-zinc-300" : "text-white"}`}
                        >
                          {market.title}
                        </Link>
                        <div className="flex items-center gap-3">
                          <ProbabilityBar yesProbability={market.yesProbability} className="h-1.5 opacity-60 group-hover:opacity-100 transition-opacity" />
                          <span className="shrink-0 text-[9px] font-bold tracking-wider text-zinc-500 uppercase">
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

                  <div className="flex shrink-0 gap-2 items-center w-full sm:w-auto mt-1 sm:mt-0">
                    <button
                      onClick={() => setSelections((s) => ({ ...s, [market.id]: true }))}
                      className={`flex-1 sm:flex-none sm:w-20 rounded-lg px-3 py-2 text-xs font-bold transition-all ${
                        selected === true
                          ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 shadow-[0_0_15px_rgba(16,185,129,0.2)] scale-105"
                          : "bg-black/40 text-zinc-500 hover:bg-white/10 hover:text-white border border-white/5"
                      }`}
                    >
                      YES
                    </button>
                    <button
                      onClick={() => setSelections((s) => ({ ...s, [market.id]: false }))}
                      className={`flex-1 sm:flex-none sm:w-20 rounded-lg px-3 py-2 text-xs font-bold transition-all ${
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
        </div>
      )}

      {/* Footer Area - Only render if daily markets are available */}
      {dailyMarkets.length > 0 && (
        <div className="mt-6 border-t border-white/5 pt-6">
          <p className="mb-2 text-center text-[10px] uppercase tracking-wider text-zinc-500">
            {!account
              ? "Sign in to lock in your predictions"
              : `Total cost: ${activeMarketIds.length} DUSDC (${
                  activeMarketIds.length
                } market${activeMarketIds.length === 1 ? "" : "s"} × 1 DUSDC)`}
          </p>
          <button
            onClick={() => {
              if (!account) {
                if (typeof window !== "undefined") {
                  window.dispatchEvent(new CustomEvent("open-connect-modal"));
                }
                return;
              }
              handleSubmit();
            }}
            disabled={
              (account && (!isComplete || activeMarketIds.length === 0)) || submitting
            }
            className="w-full rounded-xl bg-gradient-to-r from-violet-600 to-cyan-600 py-3.5 text-sm font-bold text-white shadow-lg shadow-cyan-900/30 transition-all hover:scale-[1.02] disabled:opacity-50 disabled:scale-100 disabled:shadow-none"
          >
            {submitting
              ? "Minting shares…"
              : !account
                ? "Connect wallet to lock in"
                : activeMarketIds.length === 0
                  ? "Select matches to build parlay"
                  : !isComplete
                    ? `Pick YES/NO for all ${activeMarketIds.length} matches (${activeSelectionsCount}/${activeMarketIds.length})`
                    : `Lock In Predictions (${activeSelectionsCount}/${activeMarketIds.length})`}
          </button>
        </div>
      )}
    </div>
  );
}
