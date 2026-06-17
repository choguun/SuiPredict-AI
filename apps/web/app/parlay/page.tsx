"use client";

import {
  useCurrentAccount,
  useCurrentClient,
  useDAppKit,
} from "@mysten/dapp-kit-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import {
  buildCreateParlayTx,
  DUSDC_TYPE,
  extractCreatedObjectId,
  listMarkets,
  normalizeObjectId,
  readParlayLegsLost,
  readParlayLegsRecorded,
  readParlayMaxPayoutBps,
  readParlayOwner,
  readParlayPayoutBps,
  readParlayCollateral,
  type MarketInfo,
} from "@suipredict/sdk";
import { Card } from "@/components/ui";
import { EmptyState } from "@/components/EmptyState";
import { ParlayHistory } from "@/components/ParlayHistory";
import { submitAndWait } from "@/lib/dapp-kit";
import { toast } from "sonner";

const MIN_LEGS = 2;
const MAX_LEGS = 5;
// 1 DUSDC = 1_000_000 atoms (matches the daily prediction card).
const COLLATERAL_ATOMS = BigInt(1_000_000);

const PARLAY_POOL_ID = process.env.NEXT_PUBLIC_PARLAY_POOL_ID ?? "";

// R62 audit fix: per-page "how it works"
// callout for the Parlay page. Mirrors the
// markets/[id] page's dismiss-per-market
// localStorage pattern, but uses a single
// page-scoped key (no market id) since the
// Parlay flow is the same across every
// visit. The hydration-mismatch guard
// (mounted ref) is the same R61 fix from
// markets/[id] — render `null` until the
// effect runs so SSR + first paint don't
// show a flash of the callout for returning
// users who already dismissed it.
const PARLAY_HOW_IT_WORKS_KEY = "suipredict.parlay.howItWorks.dismissed";
function readParlayHowItWorksDismissed(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(PARLAY_HOW_IT_WORKS_KEY) === "1";
  } catch {
    return false;
  }
}
function dismissParlayHowItWorks(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PARLAY_HOW_IT_WORKS_KEY, "1");
  } catch {
    /* private mode etc. */
  }
}
function HowItWorksCallout() {
  const [mounted, setMounted] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    setMounted(true);
    setDismissed(readParlayHowItWorksDismissed());
  }, []);
  if (!mounted || dismissed) return null;
  return (
    <div className="rounded-2xl border border-cyan-500/20 bg-cyan-500/5 p-4 sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-bold text-cyan-200">How a parlay works</h3>
          <p className="mt-1 text-xs text-cyan-300/80">
            A parlay bundles multiple YES/NO picks into one trade. You only win if every leg wins.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            dismissParlayHowItWorks();
            setDismissed(true);
          }}
          aria-label="Dismiss how-it-works hint"
          className="shrink-0 rounded-md p-1 text-cyan-300/60 hover:bg-cyan-500/10 hover:text-cyan-200 transition"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path strokeLinecap="round" d="M6 6l12 12M6 18L18 6" />
          </svg>
        </button>
      </div>
      <ol className="mt-3 grid gap-2 text-xs sm:grid-cols-3">
        <li className="rounded-lg border border-cyan-500/15 bg-panel p-3">
          <div className="flex items-center gap-2 text-cyan-300 font-bold">
            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-cyan-500/20 text-[10px]">1</span>
            Lock
          </div>
          <p className="mt-1 text-cyan-200/80">
            Lock 1 DUSDC as collateral. The agents worker starts
            tracking every leg you chose.
          </p>
        </li>
        <li className="rounded-lg border border-cyan-500/15 bg-panel p-3">
          <div className="flex items-center gap-2 text-cyan-300 font-bold">
            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-cyan-500/20 text-[10px]">2</span>
            Wait
          </div>
          <p className="mt-1 text-cyan-200/80">
            Each leg resolves independently as its market settles.
            Any single loss = the whole parlay loses the collateral.
          </p>
        </li>
        <li className="rounded-lg border border-cyan-500/15 bg-panel p-3">
          <div className="flex items-center gap-2 text-cyan-300 font-bold">
            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-cyan-500/20 text-[10px]">3</span>
            Payout
          </div>
          <p className="mt-1 text-cyan-200/80">
            All-win: claim <code>collateral × multiplier</code>.
            Any-loss: collateral is retained in the pool.
          </p>
        </li>
      </ol>
    </div>
  );
}

type Leg = { marketId: string; prediction: 1 | 2 }; // 1=YES, 2=NO

interface CreatedParlay {
  parlayId: string;
  collateral: bigint;
  payoutBps: bigint;
  owner: string;
  legsRecorded: bigint;
  legsLost: bigint;
  // R62 audit fix: store the original
  // leg count so the "Legs recorded:
  // X/Y" rollup survives the
  // `setLegs([])` reset on the
  // success path. Without this the
  // rollup rendered "0/?" because
  // `legs` is empty by the time the
  // success card mounts.
  legCount: number;
}

export default function ParlayPage() {
  const account = useCurrentAccount();
  const client = useCurrentClient();
  const dAppKit = useDAppKit();
  const queryClient = useQueryClient();

  const [markets, setMarkets] = useState<MarketInfo[]>([]);
  const [loadingMarkets, setLoadingMarkets] = useState(true);
  const [legs, setLegs] = useState<Leg[]>([]);
  // R62 audit fix: search/filter for the
  // "Available markets" list. The previous
  // build had no search affordance — a user
  // building a 5-leg parlay from 60+ active
  // markets had to scroll to find a
  // specific match. The search runs
  // case-insensitive against title,
  // description, and category, mirroring
  // the /markets list. A category filter
  // pill row keeps the "World Cup only" or
  // "Crypto only" use case one tap away.
  const [parlaySearch, setParlaySearch] = useState("");
  const [parlayCategory, setParlayCategory] = useState("");
  const [multiplier, setMultiplier] = useState(3); // e.g. 3x
  // Pool's on-chain max_payout_bps. Fetched once on mount; the
  // slider's `max` is clamped to this value (in bps / 10_000) so the
  // user can't pick a multiplier the chain would reject with
  // EPayoutTooLarge. Fallback to NEXT_PUBLIC_PARLAY_MAX_PAYOUT_BPS
  // while the read is in flight.
  const [maxPayoutBps, setMaxPayoutBps] = useState<number>(() => {
    const envCap = Number(
      process.env.NEXT_PUBLIC_PARLAY_MAX_PAYOUT_BPS ?? 50_000,
    );
    return Number.isFinite(envCap) && envCap > 0 ? envCap : 50_000;
  });
  const [submitting, setSubmitting] = useState(false);
  const [created, setCreated] = useState<CreatedParlay | null>(null);
  // Connected wallet's DUSDC picture. We need a single coin >= the
  // 1 DUSDC collateral for `create_parlay` (the on-chain call takes
  // one coin). Show the total balance + largest coin so the user
  // knows up front whether they can submit, and the refresh button
  // re-fetches after they receive more DUSDC.
  const [dusdcBalance, setDusdcBalance] = useState<{
    total: bigint;
    largest: bigint;
    coinCount: number;
  } | null>(null);
  const [loadingBalance, setLoadingBalance] = useState(false);

  const refreshDusdcBalance = useCallback(async () => {
    if (!client || !account) return;
    setLoadingBalance(true);
    try {
      // R51 audit fix: normalize the owner
      // address. `listCoins` is case-sensitive
      // on the wire; a mixed-case Enoki
      // zkLogin session would otherwise
      // silently return `{ objects: [] }`
      // and the user would see "— DUSDC"
      // for the duration of the tab even
      // though they hold coins.
      const { objects } = await client.core.listCoins({
        owner: normalizeObjectId(account.address),
        coinType: DUSDC_TYPE,
        // R52 audit fix: bump the default 50-coin
        // page to 100. A user with many DUSDC
        // fragments would have the total balance
        // under-count, the balance card would read
        // 0 even though they hold funds, and the
        // "consolidate" CTA wouldn't fire.
        limit: 100,
      });
      const total = objects.reduce(
        (acc, c) => acc + BigInt(c.balance),
        BigInt(0),
      );
      const largest = objects.reduce(
        (acc, c) => (BigInt(c.balance) > acc ? BigInt(c.balance) : acc),
        BigInt(0),
      );
      setDusdcBalance({ total, largest, coinCount: objects.length });
    } catch {
      // RPC outage — leave the previous balance on screen rather than
      // clearing it; the next refresh will recover.
    } finally {
      setLoadingBalance(false);
    }
  }, [client, account]);

  useEffect(() => {
    let cancelled = false;
    listMarkets()
      .then((m) => {
        if (cancelled) return;
        // Only unresolved markets can become parlay legs — the
        // on-chain `record_leg` aborts on already-resolved markets.
        setMarkets(m.filter((x) => x.status === "active"));
      })
      .catch((e) => {
        if (!cancelled) {
          toast.error(e instanceof Error ? e.message : "Failed to load markets");
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingMarkets(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Probe the pool's on-chain max_payout_bps once. If the chain
  // reports a tighter cap than the env-var fallback (or vice versa),
  // the tighter value wins — the chain is the safety net.
  useEffect(() => {
    if (!client || !PARLAY_POOL_ID) return;
    let cancelled = false;
    readParlayMaxPayoutBps(client, PARLAY_POOL_ID)
      .then((cap) => {
        if (cancelled) return;
        if (cap > BigInt(0)) {
          setMaxPayoutBps((prev) => Math.min(prev, Number(cap)));
        }
      })
      .catch(() => {
        // ignore — keep env-var fallback
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  // Poll the created parlay's on-chain state every 5s so the user can
  // see `legs_recorded` / `legs_lost` advance after the agents
  // indexer (task #17) starts calling `record_leg`.
  useEffect(() => {
    if (!client || !created?.parlayId) return;
    let cancelled = false;
    const refresh = async () => {
      if (cancelled) return;
      try {
        const [collateral, payout, owner, recorded, lost] = await Promise.all([
          readParlayCollateral(client, created.parlayId),
          readParlayPayoutBps(client, created.parlayId),
          readParlayOwner(client, created.parlayId),
          readParlayLegsRecorded(client, created.parlayId),
          readParlayLegsLost(client, created.parlayId),
        ]);
        if (cancelled) return;
        setCreated({ parlayId: created.parlayId, collateral, payoutBps: payout, owner, legsRecorded: recorded, legsLost: lost, legCount: created.legCount });
      } catch {
        // ignore — next tick will retry
      }
    };
    refresh();
    // R42 audit fix: pause the 5s refresh when the tab is
    // backgrounded. Browsers throttle background timers and a
    // user with this tab open for hours would otherwise fire
    // thousands of `getObject` requests against the indexer.
    // Skip the tick when the page is hidden; the initial
    // `refresh()` above is intentionally not gated.
    const t = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      void refresh();
    }, 5000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [client, created?.parlayId, created?.legCount]);

  // Refresh the DUSDC balance whenever the connected account changes.
  // Polling is overkill here — the user only needs a fresh read on
  // connect, after receiving dUSDC, or after submitting a parlay
  // (which absorbs one coin into the pool).
  useEffect(() => {
    if (!client || !account) {
      setDusdcBalance(null);
      return;
    }
    // R58.M3 audit fix: gate the post-create
    // refetch on `document.visibilityState ===
    // "visible"`. A 5-minute backgrounded tab
    // creates a parlay, switches to another tab,
    // and switches back: the effect re-fires
    // because `created?.parlayId` is in the dep
    // list, but the `refreshDusdcBalance()`
    // inside doesn't check the page is visible.
    // On resume the user sees a brief "Loading…"
    // spinner for the balance; on a slow node the
    // fetch can take > 1s. Skip the call when
    // hidden so the resume re-fires only when the
    // user actually looks at the page. The
    // `getSharedClient()` and the SDK already
    // handle a stale read gracefully.
    if (
      typeof document !== "undefined" &&
      document.visibilityState !== "visible"
    ) {
      return;
    }
    refreshDusdcBalance();
    // Also re-fetch right after a successful create — `created`
    // transitions from null to a value, which means a coin just got
    // absorbed. The refetch reads the post-absorb state.
    // (Effect deps re-run on the next render after setCreated; the
    // created?.parlayId dependency below is what makes that fire.)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, account?.address, created?.parlayId, refreshDusdcBalance]);

  // Auto-refresh the user's DUSDC balance on window focus / visibility change
  useEffect(() => {
    if (!client || !account) return;
    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        void refreshDusdcBalance();
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [client, account, refreshDusdcBalance]);

  const payoutBps = useMemo(() => BigInt(Math.round(multiplier * 10_000)), [multiplier]);

  const canSubmit =
    !!account &&
    !!PARLAY_POOL_ID &&
    legs.length >= MIN_LEGS &&
    legs.length <= MAX_LEGS &&
    multiplier >= 1.5 &&
    // Disabling the submit button on insufficient balance gives the
    // user a clear visual signal that the tx will reject, without
    // making them wait for the on-chain check. The actual error
    // toast at submit time still fires if the user tries (e.g. with
    // a stale balance read).
    !!dusdcBalance &&
    dusdcBalance.largest >= COLLATERAL_ATOMS;

  const handleAddLeg = (marketId: string) => {
    if (legs.length >= MAX_LEGS) return;
    if (legs.some((l) => l.marketId === marketId)) return;
    setLegs([...legs, { marketId, prediction: 1 }]);
  };
  const handleRemoveLeg = (marketId: string) => {
    setLegs(legs.filter((l) => l.marketId !== marketId));
  };
  const handleTogglePrediction = (marketId: string) => {
    setLegs(
      legs.map((l) =>
        l.marketId === marketId
          ? { ...l, prediction: l.prediction === 1 ? 2 : 1 }
          : l,
      ),
    );
  };

  const handleSubmit = async () => {
    if (!account || !client || !canSubmit) return;
    // R47 audit fix: confirm before locking funds.
    // R45 added `window.confirm` to admin
    // destructive actions (settle, rotate,
    // allocate) but missed the user-facing
    // "lock in" flows. A user who picks 3
    // legs at 10x and mis-clicks "Lock
    // 3-leg parlay at 10.0x" will lose 1
    // DUSDC with no second chance — the
    // submit PTB transfers the collateral
    // immediately and the on-chain
    // `parlay::create_parlay` is
    // irreversible (the parlay can only be
    // settled or finalized, never refunded
    // to the user). The multiplier is a
    // meaningful enough number that the
    // user benefits from a confirmation
    // prompt before signing.
    if (
      !window.confirm(
        `Lock a ${legs.length}-leg parlay at ${multiplier.toFixed(1)}x ` +
          `for ${(Number(COLLATERAL_ATOMS) / 1_000_000).toFixed(2)} DUSDC? ` +
          "This is irreversible once the transaction is signed.",
      )
    ) {
      return;
    }
    setSubmitting(true);
    try {
      // Pick the largest DUSDC coin so a single object covers the
      // collateral (parlay::create_parlay takes one coin). A user
      // with several small coins would need a separate merge PTB —
      // simpler to demand they consolidate first.
      // R51 audit fix: normalize the owner
      // address. `listCoins` is case-sensitive
      // on the wire; a mixed-case Enoki
      // zkLogin session would otherwise
      // silently return `{ objects: [] }`
      // and the user would hit the
      // "No DUSDC — request from DeepBook
      // testnet form" branch even though
      // they hold a balance.
      const { objects } = await client.core.listCoins({
        owner: normalizeObjectId(account.address),
        coinType: DUSDC_TYPE,
        // R52 audit fix: same `limit: 100`
        // rationale as the balance-card read above.
        // Without it, a 60+ fragment user would
        // hit the "No DUSDC" branch even though
        // `totalBalance` is positive.
        limit: 100,
      });
      if (objects.length === 0) {
        throw new Error("No DUSDC — request from DeepBook testnet form");
      }
      const totalBalance = objects.reduce(
        (acc, c) => acc + BigInt(c.balance),
        BigInt(0),
      );
      if (totalBalance < COLLATERAL_ATOMS) {
        throw new Error(
          `Insufficient DUSDC: need ${Number(COLLATERAL_ATOMS) / 1_000_000}, ` +
            `have ${(Number(totalBalance) / 1_000_000).toFixed(2)}.`,
        );
      }
      // R57.M3 audit fix: spread into a new array before
      // sorting. The in-place `.sort()` mutates the SDK
      // response, which is a cached array the Sui SDK
      // returns to subsequent `listCoins` calls in the
      // same component. Latent today (the SDK returns a
      // fresh array per call in practice) but the spread
      // is the safe pattern and matches the
      // `vault/page.tsx` (R55) and
      // `DailyPredictionCard.tsx` (R55) siblings.
      const sortedCoins = [...objects].sort((a, b) =>
        BigInt(b.balance) > BigInt(a.balance) ? 1 : -1,
      );
      const coin = sortedCoins[0]!;
      const tx = buildCreateParlayTx({
        poolId: PARLAY_POOL_ID,
        coinId: coin.objectId,
        collateralAtoms: COLLATERAL_ATOMS,
        marketIds: legs.map((l) => {
          const m = markets.find((x) => x.id === l.marketId);
          return m?.onchain_market_id ?? l.marketId;
        }),
        predictions: legs.map((l) => l.prediction),
        payoutBps,
        coinType: DUSDC_TYPE,
      });
      // R55 audit fix: route through `submitAndWait` so the
      // extractCreatedObjectId gRPC call and the
      // invalidateQueries that follow hit a node that has
      // already finalized the tx. The previous
      // signAndExecuteTransaction returned immediately after
      // signing and the gRPC query for the new Parlay object
      // raced on-chain finalization — a slow RPC would return
      // an empty effect and the user saw a "Parlay created but
      // ID not found" toast even though the parlay was
      // created.
      const r = await submitAndWait(dAppKit, client, tx);
      // R41 audit fix: the previous `throw new Error("Transaction
      // failed")` discarded the dAppKit result shape (`Failed`,
      // `EffectsCert`, etc.) and toasts a generic message. The
      // sibling admin/vault/dispute call sites toast a
      // specific error and return cleanly. Match that pattern
      // so the user can distinguish gas-exhaustion from a
      // Move abort from an effects-cert mismatch.
      if (r.$kind !== "Transaction" || !r.digest) {
        // R49 audit fix: drop the `(r.$kind)` interpolation. The
        // SDK variant names (`"Failed"`, `"EffectsCert"`,
        // `"Transaction"`) are internal and leaked to the user on
        // every failure. Match the `markets/[id]` page's clean
        // "Parlay create failed on-chain" toast.
        toast.error("Parlay create failed on-chain");
        return;
      }
      // Pull the new Parlay<Q> object ID from the tx effects via
      // the SDK helper. `::parlay::Parlay` is the struct suffix we
      // match against; the phantom `<DUSDC>` is in the type string
      // but the suffix match is sufficient since `extractCreatedObjectId`
      // iterates `effects.changedObjects` and filters by
      // `types[id].includes(suffix)`.
      const parlayId = await extractCreatedObjectId(
        client,
        r.digest,
        "::parlay::Parlay",
      );
      if (!parlayId) {
        toast.error("Parlay created but ID not found in tx effects");
        return;
      }
      toast.success(`Parlay created! ${parlayId.slice(0, 12)}…`);
      setCreated({
        parlayId,
        collateral: COLLATERAL_ATOMS,
        payoutBps,
        owner: account.address,
        legsRecorded: BigInt(0),
        legsLost: BigInt(0),
        // R62 audit fix: capture the leg count at
        // submit time so the "X/Y" rollup in
        // the success card doesn't degrade to
        // "0/?" after `setLegs([])` runs
        // immediately below.
        legCount: legs.length,
      });
      setLegs([]);
      // The agents indexer (task #17) will start polling ParlayCreated
      // and run record_leg as markets resolve. Invalidate the markets
      // list query so the "available to bet" list refreshes.
      //
      // R39 audit fix: the key was previously `["markets"]`,
      // which no client owns — the portfolio page uses
      // `["marketsList"]` and the daily-prediction card uses
      // `["dailyMarkets"]`. An invalidation on a non-existent
      // key is a silent no-op, so the markets list would stay
      // stale until the next 8s `refetchInterval` tick. Match
      // the actual registered keys.
      //
      // R40 audit fix: a successful parlay create draws the
      // user's collateral out of their position pool, so the
      // portfolio page (key `["portfolio", address]`) goes
      // stale for 8s without an explicit invalidation. Use
      // `type: "active"` to match the tuple form used by
      // `app/portfolio/page.tsx:32`.
      //
      // R44 audit fix: the first two invalidations were
      // missing the `type: "active"` filter. Without it, the
      // `queryKey: ["marketsList"]` call only matched
      // *exact*-key subscribers — TanStack Query v5 default
      // is `type: "all"`, which matches active and inactive,
      // but the new "active" project-wide convention
      // (introduced R43 in DailyPredictionCard.tsx) uses
      // `type: "active"` to be explicit. The DailyPredictionCard
      // code was the only place honoring the new convention;
      // this was the survivor. Apply the same here so a
      // parlay create drops the active `["marketsList"]` and
      // `["dailyMarkets"]` subscribers without
      // touching inactive ones (e.g. preloaded server-state
      // in a still-mounting child route).
      queryClient.invalidateQueries({ queryKey: ["marketsList"], type: "active" });
      queryClient.invalidateQueries({ queryKey: ["dailyMarkets"], type: "active" });
      // R50 audit fix: prefix-match on `["portfolio"]`
      // works (TanStack matches on the prefix) but
      // the registered key at `portfolio/page.tsx:42`
      // is `["portfolio", account?.address]` for
      // symmetry with `vault/page.tsx:52` and
      // `markets/[id]/page.tsx:226`. Use the full
      // key here too so the invalidation is
      // unambiguous — and so a future caller
      // registering `["portfolio", "summary"]` (a
      // global, no-address variant) doesn't get
      // accidentally nuked.
      if (account?.address) {
        queryClient.invalidateQueries({
          queryKey: ["portfolio", account.address],
          type: "active",
        });
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Submit failed");
    } finally {
      setSubmitting(false);
    }
  };

  if (!account) {
    return (
      <div className="space-y-6">
        <h1 className="text-3xl font-bold tracking-tight text-transparent bg-clip-text bg-gradient-to-r from-white to-cyan-200">
          Parlay Builder
        </h1>
        <EmptyState
          icon="parlay"
          title="Wallet Disconnected"
          description="Connect your Sui wallet to build and place multi-leg parlays. Combine 2-8 YES/NO positions across markets and earn multiplied payouts when every leg wins."
          actionLabel="Connect Wallet"
          onAction={() => {
            if (typeof window !== "undefined") {
              window.dispatchEvent(new CustomEvent("open-connect-modal"));
            }
          }}
          previews={[
            "Pick 2-8 markets, choose YES or NO on each",
            "Combined payout multiplier (legs × odds)",
            "Single on-chain PTB submits all legs atomically",
            "Daily-parlay bonus + leaderboard rank",
          ]}
        />
      </div>
    );
  }

  if (!PARLAY_POOL_ID) {
    return (
      <div className="space-y-6">
        <h1 className="text-3xl font-bold tracking-tight text-transparent bg-clip-text bg-gradient-to-r from-white to-cyan-200">
          Parlay Builder
        </h1>
        <Card>
          <div className="space-y-3 py-2">
            <p className="text-sm font-semibold text-amber-200">
              Parlays are coming soon
            </p>
            <p className="text-sm text-zinc-400">
              We&apos;re finishing the on-chain parlay pool. In the
              meantime, build single-leg positions on the markets page —
              same YES/NO mechanics, same DeepBook liquidity.
            </p>
            <Link
              href="/markets"
              className="inline-block rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-white/10"
            >
              Browse markets →
            </Link>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-transparent bg-clip-text bg-gradient-to-r from-white to-cyan-200">
          Parlay Builder
        </h1>
        <p className="mt-2 text-zinc-400">
          Pick {MIN_LEGS}–{MAX_LEGS} active markets, choose YES or NO
          for each, set a payout multiplier, and lock 1 DUSDC as
          collateral. All-win pays <code className="text-cyan-300">collateral × multiplier</code>;
          any-loss retains the collateral in the pool.
        </p>
      </div>

      {/* R62 audit fix: dismissible "How a parlay
         works" callout for first-time users. The
         Parlay page is the most complex user
         flow in the app (lock 1 DUSDC, wait
         for all legs to resolve, claim
         multiplier×payout) and a first-time
         user had no inline guidance for what
         "legs" or "multiplier" mean or what
         happens on a partial win. The callout
         follows the markets/[id] page's
         per-market localStorage pattern —
         dismissed once, never re-surfaces
         unless the user clears the key. */}
      <HowItWorksCallout />

      {/* R62 audit fix: "Clear all" affordance
         for the legs list. The pre-R62 build
         only had per-leg "Remove" buttons, so
         a user who had selected 5 markets and
         wanted to start over had to click
         "Remove" 5 times in a row. The
         clear-all button is positioned in the
         card header (which now lives in the
         body, not the `Card` `title` prop,
         because the Card primitive doesn't
         support trailing actions yet — see
         the R62 audit note on the shared
         `Card` component for the upgrade
         plan). Disabled when there are no
         legs. */}
      <Card className="border-white/10">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-xs font-bold uppercase tracking-widest text-zinc-500">
            Legs ({legs.length}/{MAX_LEGS})
          </h2>
          {legs.length > 0 && (
            <button
              type="button"
              onClick={() => setLegs([])}
              className="rounded-md border border-white/10 bg-white/5 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-300 hover:bg-rose-500/10 hover:text-rose-300 transition"
            >
              Clear all
            </button>
          )}
        </div>
        {legs.length === 0 ? (
          <p className="text-sm text-zinc-500">
            No legs yet. Add markets from the list below.
          </p>
        ) : (
          <ul className="space-y-2">
            {legs.map((leg) => {
              const m = markets.find((x) => x.id === leg.marketId);
              return (
                <li
                  key={leg.marketId}
                  className="flex items-center gap-3 rounded-lg border border-white/10 bg-black/20 p-3"
                >
                  <button
                    onClick={() => handleTogglePrediction(leg.marketId)}
                    className={`rounded-md px-3 py-1 text-xs font-bold ${
                      leg.prediction === 1
                        ? "bg-emerald-500/20 text-emerald-200 border border-emerald-500/30"
                        : "bg-rose-500/20 text-rose-200 border border-rose-500/30"
                    }`}
                    title="Click to toggle YES / NO"
                  >
                    {leg.prediction === 1 ? "YES" : "NO"}
                  </button>
                  <div className="flex-1 min-w-0">
                    <p className="truncate text-sm text-white">
                      {m?.title ?? leg.marketId}
                    </p>
                    <p className="font-mono text-[10px] text-zinc-500">
                      {leg.marketId.slice(0, 18)}…
                    </p>
                  </div>
                  <button
                    onClick={() => handleRemoveLeg(leg.marketId)}
                    className="rounded-md border border-white/10 bg-white/5 px-2 py-1 text-xs text-zinc-300 transition hover:bg-white/10"
                  >
                    Remove
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Card title="Multiplier" className="border-white/10">
        <div className="space-y-3 max-w-md">
          <div className="flex items-center gap-4">
            <input
              type="range"
              // The contract asserts `payout_bps > BPS` (strictly
              // greater than 1x) at create_parlay time — a 1.0x
              // parlay has no upside so the contract refuses it with
              // EPayoutTooLarge. The previous `min={1}` let the user
              // slide to exactly 1.0x and watch the tx abort. Start
              // one step above the boundary so every reachable value
              // is on-chain valid. (Round-23 audit finding.)
              min={1.5}
              // Clamp to the pool's on-chain max_payout_bps (read
              // above) so the user can never pick a multiplier the
              // chain would reject with EPayoutTooLarge.
              max={maxPayoutBps / 10_000}
              step={0.5}
              value={multiplier}
              onChange={(e) => setMultiplier(Number(e.target.value))}
              className="flex-1"
            />
            <span className="w-20 text-right font-mono text-2xl font-bold text-cyan-300">
              {multiplier.toFixed(1)}x
            </span>
          </div>
          <p className="text-xs text-zinc-500">
            Payout if every leg wins: 1 DUSDC × {multiplier.toFixed(2)} = {(multiplier).toFixed(2)} DUSDC.
            Pool cap: {(maxPayoutBps / 10_000).toFixed(1)}x.
            Pool must hold enough to cover worst-case payout.
          </p>
          <div className="flex items-center gap-3 border-t border-white/5 pt-3 text-xs text-zinc-400">
            <span>
              Your DUSDC:{" "}
              <span
                className={
                  dusdcBalance && dusdcBalance.largest >= COLLATERAL_ATOMS
                    ? "font-mono text-emerald-300"
                    : "font-mono text-rose-300"
                }
              >
                {dusdcBalance
                  ? `${(Number(dusdcBalance.total) / 1_000_000).toFixed(2)}`
                  : loadingBalance
                    ? "…"
                    : "—"}
              </span>{" "}
              DUSDC
              {dusdcBalance && dusdcBalance.coinCount > 1 && (
                <span className="text-zinc-500">
                  {" "}
                  (largest coin:{" "}
                  {(Number(dusdcBalance.largest) / 1_000_000).toFixed(2)})
                </span>
              )}
            </span>
            {dusdcBalance && dusdcBalance.largest < COLLATERAL_ATOMS && (
              <span className="text-rose-300">
                · need 1.00 in a single coin to submit
              </span>
            )}
            <button
              type="button"
              onClick={refreshDusdcBalance}
              disabled={loadingBalance}
              className="ml-auto rounded border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] uppercase tracking-wider text-zinc-300 transition hover:bg-white/10 disabled:opacity-40"
            >
              {loadingBalance ? "Refreshing…" : "Refresh"}
            </button>
          </div>
        </div>
      </Card>

      <Card title="Available markets" className="border-white/10">
        {loadingMarkets ? (
          <p className="text-sm text-zinc-500">Loading markets…</p>
        ) : markets.length === 0 ? (
          <p className="text-sm text-zinc-500">No active markets right now.</p>
        ) : (
          <>
            {/* R62 audit fix: search + category
                filter for the available-markets
                list. With 60+ active markets the
                flat list was unwieldy — a user
                building a 5-leg parlay had to
                scroll to find a specific match.
                The search is plain HTML form
                state (no client JS) and the
                filter pills are plain <button>s
                that update state. Mirrors the
                /markets list UX so the two
                pages feel consistent. */}
            <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center">
              <div className="relative flex-1">
                <span
                  className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-zinc-500"
                  aria-hidden="true"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="11" cy="11" r="7" />
                    <path strokeLinecap="round" d="m21 21-4.3-4.3" />
                  </svg>
                </span>
                <input
                  type="search"
                  value={parlaySearch}
                  onChange={(e) => setParlaySearch(e.target.value)}
                  placeholder="Filter markets by name or category…"
                  aria-label="Filter available markets"
                  className="w-full rounded-lg border border-white/10 bg-panel py-2 pl-9 pr-3 text-sm text-white placeholder:text-zinc-600 focus:border-emerald-500/50 focus:outline-none"
                />
              </div>
            </div>
            {(() => {
              const q = parlaySearch.trim().toLowerCase();
              const filtered = markets.filter((m) => {
                if (parlayCategory && m.category !== parlayCategory) return false;
                if (!q) return true;
                return (
                  m.title.toLowerCase().includes(q) ||
                  m.category.toLowerCase().includes(q) ||
                  (m.description ?? "").toLowerCase().includes(q)
                );
              });
              // Derive the available categories from
              // the active market list (no "Sports" /
              // "Politics" pills that produce empty
              // results, like the R57 fix on /markets).
              const cats = Array.from(
                new Set(markets.map((m) => m.category)),
              ).sort();
              if (filtered.length === 0) {
                return (
                  <p className="text-sm text-zinc-500">
                    No markets match your filter. Try clearing the search.
                  </p>
                );
              }
              return (
                <>
                  <div className="mb-3 flex flex-wrap gap-1.5">
                    <button
                      type="button"
                      onClick={() => setParlayCategory("")}
                      className={`shrink-0 rounded-full px-3 py-1 text-[10px] font-bold uppercase tracking-wider transition ${
                        parlayCategory === ""
                          ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30"
                          : "border border-white/10 bg-white/5 text-zinc-400 hover:bg-white/10"
                      }`}
                    >
                      All
                    </button>
                    {cats.map((c) => (
                      <button
                        key={c}
                        type="button"
                        onClick={() => setParlayCategory(c)}
                        className={`shrink-0 rounded-full px-3 py-1 text-[10px] font-bold uppercase tracking-wider transition ${
                          parlayCategory === c
                            ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30"
                            : "border border-white/10 bg-white/5 text-zinc-400 hover:bg-white/10"
                        }`}
                      >
                        {c}
                      </button>
                    ))}
                  </div>
                  <ul className="grid grid-cols-1 gap-2 md:grid-cols-2">
                    {filtered.map((m) => {
                      const added = legs.some((l) => l.marketId === m.id);
                      const disabled = added || legs.length >= MAX_LEGS;
                      return (
                        <li
                          key={m.id}
                          className="flex items-center justify-between gap-2 rounded-lg border border-white/10 bg-black/20 p-3"
                        >
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm text-white">{m.title}</p>
                            <p className="text-[10px] uppercase tracking-wider text-zinc-500">
                              {m.category} · {m.status}
                            </p>
                          </div>
                          <button
                            onClick={() => handleAddLeg(m.id)}
                            disabled={disabled}
                            className="rounded-md bg-cyan-500/20 border border-cyan-500/30 px-3 py-1 text-xs font-semibold text-cyan-200 transition hover:bg-cyan-500/30 disabled:opacity-40"
                          >
                            {added ? "Added" : "Add"}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </>
              );
            })()}
          </>
        )}
      </Card>

      <div className="flex justify-end">
        <button
          onClick={handleSubmit}
          disabled={!canSubmit || submitting}
          className="rounded-lg bg-gradient-to-r from-violet-600 to-cyan-600 px-6 py-3 text-sm font-bold text-white shadow-lg shadow-cyan-900/30 transition-all hover:scale-[1.02] hover:shadow-cyan-900/50 disabled:opacity-50 disabled:scale-100"
        >
          {submitting ? "Submitting…" : `Lock ${legs.length}-leg parlay at ${multiplier.toFixed(1)}x`}
        </button>
      </div>

      {created && (
        <Card title="Parlay" className="border-emerald-500/30 bg-emerald-500/5">
          <div className="space-y-1.5 text-sm">
            <p className="font-mono text-cyan-300 break-all">{created.parlayId}</p>
            <p className="text-zinc-300">
              Collateral: <span className="text-white">{(Number(created.collateral) / 1_000_000).toFixed(2)} DUSDC</span>
              {" · "}
              Payout: <span className="text-white">{(Number(created.payoutBps) / 10_000).toFixed(2)}x</span>
              {" · "}
              Legs recorded: <span className="text-white">{created.legsRecorded.toString()}/{created.legCount}</span>
              {" · "}
              Lost: <span className={created.legsLost > BigInt(0) ? "text-rose-300" : "text-emerald-300"}>{created.legsLost.toString()}</span>
            </p>
            <p className="text-xs text-zinc-500">
              Owner: {created.owner.slice(0, 10)}…{created.owner.slice(-4)}
            </p>
            <p className="text-xs text-zinc-500">
              Once all legs are recorded the agents worker calls
              `finalize_parlay` automatically. Refresh to update.
            </p>
          </div>
        </Card>
      )}

      <ParlayHistory userAddress={account?.address ?? null} />
    </div>
  );
}
