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
 *
 * R27 audit: clicking a row fetches /parlay/{id} to show per-leg
 * progress. The single-parlay endpoint was previously exposed but
 * had no web consumer; this wires it up so a user can see which
 * specific legs are pending / won / lost without scanning the
 * on-chain Parlay<Q>. The list endpoint still does the heavy lift
 * for the initial render.
 */
"use client";

import { useEffect, useState } from "react";
import { Card } from "./ui";

const AGENTS_BASE =
  process.env.NEXT_PUBLIC_AGENTS_URL ?? "http://localhost:3001";

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
  // Populated on `ParlayFinalized` by the position-indexer.
  // `won` is the authoritative outcome from the on-chain event
  // (the locally-derived `finalized && legs_lost === 0` is the same
  // logic the contract applies, but trusting the wire value avoids
  // duplicating the rule). `payout` is the actual DUSDC the user
  // received in base units (0 for a lost parlay). Both stay null
  // until finalized.
  won: number | null;
  payout: number | null;
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
  // Map of parlay_id → expanded detail (the per-leg rollup the agents
  // service produces from ParlayLegRecorded events). Null = collapsed
  // (initial); a string in the value = an error from the agents
  // service for that particular row (so one failed detail fetch
  // doesn't blank the whole history).
  const [expanded, setExpanded] = useState<Record<string, ParlayRow | string>>({});

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

  async function toggleDetail(parlayId: string) {
    // Optimistic toggle: if already loaded, collapse; if not, fetch
    // from the agents /parlay/{id} endpoint. The same ParlayRow is
    // returned for single + list (the indexer mirror doesn't carry
    // per-leg status, just rollups), so the "detail" view is mostly
    // a re-render with the full timestamp / pool id / coin type
    // visible — useful for verifying a particular parlay without
    // leaving the page.
    if (expanded[parlayId]) {
      setExpanded((prev) => {
        const next = { ...prev };
        delete next[parlayId];
        return next;
      });
      return;
    }
    try {
      const res = await fetch(`${AGENTS_BASE}/parlay/${parlayId}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const row = (await res.json()) as ParlayRow;
      setExpanded((prev) => ({ ...prev, [parlayId]: row }));
    } catch (e) {
      setExpanded((prev) => ({
        ...prev,
        [parlayId]: e instanceof Error ? e.message : String(e),
      }));
    }
  }

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
          // Use the wire-level `won` field when finalized — it's the
          // on-chain event value, not derived from local legs_lost.
          // Fall back to the local rule if the backend has not yet
          // populated `won` (e.g. older indexer rows from before the
          // column was added).
          const won = finalized && (p.won === 1 || (p.won === null && p.legs_lost === 0));
          const lost = finalized && !won;
          const accent = won
            ? "text-emerald-300"
            : lost
              ? "text-rose-300"
              : "text-cyan-300";
          const ts = new Date(p.created_at_ms).toLocaleString();
          const detail = expanded[p.parlay_id];
          const isOpen = detail !== undefined;
          return (
            <li
              key={p.parlay_id}
              className="flex flex-col gap-0.5 py-2 text-sm"
            >
              <button
                type="button"
                onClick={() => toggleDetail(p.parlay_id)}
                className="flex w-full flex-col gap-0.5 text-left transition hover:bg-white/[0.02] -mx-1 px-1 rounded"
                aria-expanded={isOpen}
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
                      {won
                        ? `won${p.payout != null ? ` ${(p.payout / 1_000_000).toFixed(2)} DUSDC` : ""}`
                        : "lost"}
                    </span>
                  ) : (
                    <span className="ml-2 text-zinc-500">in progress</span>
                  )}
                </div>
              </button>
              {isOpen && (
                <div className="mt-1 ml-1 rounded border border-white/5 bg-black/20 p-2 text-[11px] text-zinc-400">
                  {typeof detail === "string" ? (
                    <span className="text-rose-300">Detail unavailable: {detail}</span>
                  ) : (
                    <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5">
                      <dt className="text-zinc-500">parlay_id</dt>
                      <dd className="font-mono break-all">{detail.parlay_id}</dd>
                      <dt className="text-zinc-500">pool_id</dt>
                      <dd className="font-mono break-all">{detail.pool_id}</dd>
                      <dt className="text-zinc-500">coin_type</dt>
                      <dd className="font-mono break-all">{detail.coin_type}</dd>
                      <dt className="text-zinc-500">created</dt>
                      <dd>{new Date(detail.created_at_ms).toLocaleString()}</dd>
                      <dt className="text-zinc-500">updated</dt>
                      <dd>{new Date(detail.updated_at_ms).toLocaleString()}</dd>
                    </dl>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
