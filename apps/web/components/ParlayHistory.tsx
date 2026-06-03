/**
 * ParlayHistory — fetches the user's parlay history from the off-chain
 * mirror at /parlay/user/:addr (apps/agents/src/gamification/routes.ts)
 * and renders a list of past parlays with their leg-progress state.
 *
 * Why off-chain instead of reading on-chain `Parlay<Q>` objects?
 *   1. The position-indexer mirrors every ParlayCreated / LegRecorded /
 *      ParlayFinalized event into a SQLite `parlays` row, so reads are
 *      O(1) without a `getOwnedObjects` per row.
 *   2. The parlay-worker's progress is visible here (legs_recorded /
 *      legs_lost) without needing a follow-up RPC per parlay.
 *   3. Finalized parlays would be zero-bytes on chain (the Parlay<Q>
 *      is consumed by `finalize_parlay`) — the off-chain mirror
 *      preserves the history that the chain erases.
 */
"use client";

import { useEffect, useState } from "react";
import { Card } from "./ui";

const AGENTS_BASE =
  process.env.NEXT_PUBLIC_AGENTS_BASE_URL ?? "http://localhost:3001";

export interface ParlayRow {
  parlay_id: string;
  owner: string;
  pool_id: string;
  coin_type: string;
  leg_count: number;
  legs_recorded: number;
  legs_lost: number;
  payout_bps: number;
  collateral: number;
  finalized: number;
  created_at_ms: number;
  updated_at_ms: number;
}

interface Props {
  userAddress: string | null;
  includeFinalized?: boolean;
}

export function ParlayHistory({ userAddress, includeFinalized = true }: Props) {
  const [rows, setRows] = useState<ParlayRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!userAddress) {
      setRows(null);
      return;
    }
    const qs = includeFinalized ? "?include_finalized=1" : "";
    const url = `${AGENTS_BASE}/parlay/user/${userAddress}${qs}`;
    let cancelled = false;
    fetch(url)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j: { parlays: ParlayRow[] }) => {
        if (!cancelled) setRows(j.parlays);
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
          setRows([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [userAddress, includeFinalized]);

  if (!userAddress) return null;
  if (error) {
    return (
      <Card title="Your parlay history" className="border-white/10">
        <p className="text-sm text-rose-300">
          Could not load history: {error}
        </p>
        <p className="mt-1 text-xs text-zinc-500">
          The agents service may be down or the indexer may not have
          picked up this user yet. New parlays appear within one tick
          of the ParlayCreated event.
        </p>
      </Card>
    );
  }
  if (rows === null) {
    return (
      <Card title="Your parlay history" className="border-white/10">
        <p className="text-sm text-zinc-500">Loading…</p>
      </Card>
    );
  }
  if (rows.length === 0) {
    return (
      <Card title="Your parlay history" className="border-white/10">
        <p className="text-sm text-zinc-500">No parlays yet.</p>
      </Card>
    );
  }
  return (
    <Card title="Your parlay history" className="border-white/10">
      <ul className="divide-y divide-white/5">
        {rows.map((p) => {
          const finalized = p.finalized === 1;
          const won = finalized && p.legs_lost === 0;
          const lost = finalized && p.legs_lost > 0;
          const accent = won
            ? "text-emerald-300"
            : lost
              ? "text-rose-300"
              : "text-cyan-300";
          const ts = new Date(p.created_at_ms).toLocaleString();
          return (
            <li
              key={p.parlay_id}
              className="flex flex-col gap-0.5 py-2 text-sm"
            >
              <div className="flex items-center justify-between gap-2">
                <span className={`font-mono text-xs ${accent}`}>
                  {p.parlay_id.slice(0, 10)}…{p.parlay_id.slice(-4)}
                </span>
                <span className="text-xs text-zinc-500">{ts}</span>
              </div>
              <div className="text-zinc-300">
                {p.legs_recorded}/{p.leg_count} legs recorded
                {" · "}
                {p.legs_lost} lost
                {" · "}
                {(p.payout_bps / 10_000).toFixed(2)}x
                {" · "}
                {(p.collateral / 1_000_000).toFixed(2)} DUSDC
                {finalized ? (
                  <span className={`ml-2 ${accent}`}>
                    {won ? "won" : "lost"}
                  </span>
                ) : (
                  <span className="ml-2 text-zinc-500">in progress</span>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
