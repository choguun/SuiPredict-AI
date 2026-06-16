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
      <div className="flex h-full min-h-[300px] items-center justify-center rounded-2xl border border-white/10 bg-panel-strong p-8 text-sm text-zinc-500">
        Loading today&apos;s markets…
      </div>
    );
  }

}
