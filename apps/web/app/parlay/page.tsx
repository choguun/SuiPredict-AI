"use client";

import {
  useCurrentAccount,
  useCurrentClient,
  useDAppKit,
} from "@mysten/dapp-kit-react";
import { useEffect, useMemo, useState } from "react";
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
import { ParlayHistory } from "@/components/ParlayHistory";
import { toast } from "sonner";

const MIN_LEGS = 2;
const MAX_LEGS = 5;
// 1 DUSDC = 1_000_000 atoms (matches the daily prediction card).
const COLLATERAL_ATOMS = BigInt(1_000_000);

const PARLAY_POOL_ID = process.env.NEXT_PUBLIC_PARLAY_POOL_ID ?? "";

type Leg = { marketId: string; prediction: 1 | 2 }; // 1=YES, 2=NO

interface CreatedParlay {
  parlayId: string;
  collateral: bigint;
  payoutBps: bigint;
  owner: string;
  legsRecorded: bigint;
  legsLost: bigint;
}

export default function ParlayPage() {
  const account = useCurrentAccount();
  const client = useCurrentClient();
  const dAppKit = useDAppKit();
  const queryClient = useQueryClient();

  const [markets, setMarkets] = useState<MarketInfo[]>([]);
  const [loadingMarkets, setLoadingMarkets] = useState(true);
  const [legs, setLegs] = useState<Leg[]>([]);
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

  async function refreshDusdcBalance() {
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
  }

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
        setCreated({ parlayId: created.parlayId, collateral, payoutBps: payout, owner, legsRecorded: recorded, legsLost: lost });
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
  }, [client, created?.parlayId]);

  // Refresh the DUSDC balance whenever the connected account changes.
  // Polling is overkill here — the user only needs a fresh read on
  // connect, after receiving dUSDC, or after submitting a parlay
  // (which absorbs one coin into the pool).
  useEffect(() => {
    if (!client || !account) {
      setDusdcBalance(null);
      return;
    }
    refreshDusdcBalance();
    // Also re-fetch right after a successful create — `created`
    // transitions from null to a value, which means a coin just got
    // absorbed. The refetch reads the post-absorb state.
    // (Effect deps re-run on the next render after setCreated; the
    // created?.parlayId dependency below is what makes that fire.)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, account?.address, created?.parlayId]);

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
      const coin = objects.sort((a, b) =>
        BigInt(b.balance) > BigInt(a.balance) ? 1 : -1,
      )[0]!;
      const tx = buildCreateParlayTx({
        poolId: PARLAY_POOL_ID,
        coinId: coin.objectId,
        collateralAtoms: COLLATERAL_ATOMS,
        marketIds: legs.map((l) => l.marketId),
        predictions: legs.map((l) => l.prediction),
        payoutBps,
        coinType: DUSDC_TYPE,
      });
      const r = await dAppKit.signAndExecuteTransaction({ transaction: tx });
      // R41 audit fix: the previous `throw new Error("Transaction
      // failed")` discarded the dAppKit result shape (`Failed`,
      // `EffectsCert`, etc.) and toasts a generic message. The
      // sibling admin/vault/dispute call sites toast a
      // specific error and return cleanly. Match that pattern
      // so the user can distinguish gas-exhaustion from a
      // Move abort from an effects-cert mismatch.
      if (r.$kind !== "Transaction") {
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
        r.Transaction.digest,
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
        <Card>
          <p className="text-zinc-400">Connect a wallet to build a parlay.</p>
        </Card>
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
          <p className="text-amber-300">
            NEXT_PUBLIC_PARLAY_POOL_ID is not set. Run the parlay
            bootstrap (task #19) to publish the pool, then set the env.
          </p>
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

      <Card title={`Legs (${legs.length}/${MAX_LEGS})`} className="border-white/10">
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
          <ul className="grid grid-cols-1 gap-2 md:grid-cols-2">
            {markets.map((m) => {
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
              Legs recorded: <span className="text-white">{created.legsRecorded.toString()}/{legs.length || "?"}</span>
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
