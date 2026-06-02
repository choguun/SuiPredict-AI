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
  readParlayLegsLost,
  readParlayLegsRecorded,
  readParlayOwner,
  readParlayPayoutBps,
  readParlayCollateral,
  type MarketInfo,
} from "@suipredict/sdk";
import { Card } from "@/components/ui";
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
  const [submitting, setSubmitting] = useState(false);
  const [created, setCreated] = useState<CreatedParlay | null>(null);

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
    const t = setInterval(refresh, 5000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [client, created?.parlayId]);

  const payoutBps = useMemo(() => BigInt(Math.round(multiplier * 10_000)), [multiplier]);

  const canSubmit =
    !!account &&
    !!PARLAY_POOL_ID &&
    legs.length >= MIN_LEGS &&
    legs.length <= MAX_LEGS &&
    multiplier >= 1;

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
    setSubmitting(true);
    try {
      // Pick the largest DUSDC coin so a single object covers the
      // collateral (parlay::create_parlay takes one coin). A user
      // with several small coins would need a separate merge PTB —
      // simpler to demand they consolidate first.
      const { objects } = await client.core.listCoins({
        owner: account.address,
        coinType: DUSDC_TYPE,
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
        marketIds: legs.map((l) => l.marketId),
        predictions: legs.map((l) => l.prediction),
        payoutBps,
        coinType: DUSDC_TYPE,
      });
      const r = await dAppKit.signAndExecuteTransaction({ transaction: tx });
      if (r.$kind !== "Transaction") {
        throw new Error("Transaction failed");
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
      // query so the "available to bet" list refreshes.
      queryClient.invalidateQueries({ queryKey: ["markets"] });
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
              min={1}
              max={10}
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
            Pool must hold enough to cover worst-case payout.
          </p>
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
    </div>
  );
}
