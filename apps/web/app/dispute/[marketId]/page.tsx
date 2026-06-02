"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  useCurrentAccount,
  useDAppKit,
} from "@mysten/dapp-kit-react";
import { buildDisputeMarketTx, getMarket } from "@suipredict/sdk";
import { Card } from "@/components/ui";

// On-chain `MAX_EVIDENCE_URI_BYTES` (packages/contracts/sources/prediction_market.move:51).
// Hard-capped at the protocol layer; the user gets `EEvidenceUriTooLong` (abort 16)
// on submit, but a client-side check avoids paying gas for a doomed tx.
const MAX_EVIDENCE_URI_BYTES = 256;

// `dispute_market` aborts with code 15 (`EMarketDisputed`) when the market
// is already disputed, and code 16 (`EEvidenceUriTooLong`) for overlong
// URIs. We surface these as friendly messages instead of raw Move aborts.
function friendlyDisputeError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/MoveAbort[^)]*\)\s*,\s*15\b/.test(msg)) {
    return "This market is already disputed and is frozen. The market creator must resolve the dispute before a new one can be filed.";
  }
  if (/MoveAbort[^)]*\)\s*,\s*16\b/.test(msg)) {
    return `Evidence URI exceeds the 256-byte on-chain limit.`;
  }
  if (/EMarketDisputed|EEvidenceUriTooLong/.test(msg)) return msg;
  return msg;
}

export default function DisputeMarketPage() {
  const { marketId: rawId } = useParams<{ marketId: string }>();
  const marketId = decodeURIComponent(rawId ?? "");
  const account = useCurrentAccount();
  const dAppKit = useDAppKit();
  const router = useRouter();
  const [evidenceUri, setEvidenceUri] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [digest, setDigest] = useState<string | null>(null);

  const [marketStatus, setMarketStatus] = useState<
    "loading" | "active" | "resolved" | "cancelled" | "disputed" | "not_found"
  >("loading");
  const [outcome, setOutcome] = useState<"yes" | "no" | null>(null);
  // Stricter signal than `m.status === "disputed"`. The boolean is
  // flipped by `markMarketDisputed` in the same SQL UPDATE that sets
  // `status = 'disputed'`, but the boolean lets us reason about
  // a hypothetical race where the indexer has set `disputed = 1`
  // for a duplicate dispute (incrementing `dispute_count`) without
  // re-writing `status` to `"disputed"`. Treat either as a block.
  const [marketDisputed, setMarketDisputed] = useState(false);

  // Pre-flight: load the market's status from the off-chain indexer so we
  // can refuse to submit a dispute against an active/cancelled/already-
  // disputed market before asking the user to sign a doomed tx. The
  // indexer mirrors the on-chain `MarketResolvedEvent` and
  // `MarketDisputedEvent` into the `markets.status` column. Status is a
  // strict subset of the on-chain state — the on-chain contract still
  // aborts if the indexer is stale, and we surface that as a friendly
  // error below.
  useEffect(() => {
    if (!marketId) {
      setMarketStatus("not_found");
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const m = await getMarket(marketId);
        if (cancelled) return;
        setMarketStatus(m.status);
        setOutcome(m.outcome ?? null);
        setMarketDisputed(Boolean(m.disputed));
      } catch {
        if (!cancelled) setMarketStatus("not_found");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [marketId]);

  const uriBytes = new TextEncoder().encode(evidenceUri.trim()).length;
  const uriTooLong = uriBytes > MAX_EVIDENCE_URI_BYTES;
  const uriEmpty = evidenceUri.trim().length === 0;

  // The on-chain `dispute_market` also asserts
  //   `now <= market.resolved_ms + DISPUTE_WINDOW_MS`
  // (a 1-hour grace after resolution). We don't have `resolved_ms` in the
  // off-chain mirror, so we can't reject stale disputes client-side — the
  // on-chain check is authoritative. Surfacing the move-abort code as a
  // friendly message is the best we can do until the indexer records
  // `resolved_ms` (filed for a follow-up).
  //
  // `marketDisputed || marketStatus === "disputed"` covers both the
  // happy-path (status flips to "disputed" the first time) and a
  // hypothetical race where the boolean is set but the status is
  // not yet refreshed.
  const statusBlocksSubmit =
    marketStatus === "loading" ||
    marketStatus === "not_found" ||
    marketStatus === "active" ||
    marketStatus === "cancelled" ||
    marketStatus === "disputed" ||
    marketDisputed;

  const canSubmit =
    !!account &&
    !!marketId &&
    marketStatus === "resolved" &&
    !uriEmpty &&
    !uriTooLong &&
    !submitting;

  let statusHint: string | null = null;
  if (marketStatus === "loading") statusHint = "Loading market…";
  else if (marketStatus === "not_found")
    statusHint = "Market not found in the indexer. It may not exist or has not been indexed yet.";
  else if (marketStatus === "active")
    statusHint = "This market is still active. Disputes can only be filed on resolved markets.";
  else if (marketStatus === "cancelled")
    statusHint = "This market was cancelled and cannot be disputed.";
  else if (marketStatus === "disputed" || marketDisputed)
    statusHint = "This market is already disputed. The market creator must resolve the dispute before a new one can be filed.";

  async function submit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const tx = buildDisputeMarketTx(marketId, evidenceUri.trim());
      const r = await dAppKit.signAndExecuteTransaction({ transaction: tx });
      setDigest(
        r.$kind === "Transaction" ? r.Transaction.digest : "submitted",
      );
    } catch (err) {
      setError(friendlyDisputeError(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-transparent bg-clip-text bg-gradient-to-r from-rose-300 via-amber-300 to-amber-500">
          Dispute Market
        </h1>
        <p className="mt-2 text-zinc-400">
          File a dispute if a resolved market&apos;s outcome is incorrect. The
          market is frozen until the creator resolves the dispute. Disputes
          are public and the evidence URI is recorded on-chain.
        </p>
      </div>

      <Card title={`Market: ${marketId.slice(0, 12)}…`} className="border-white/10">
        <div className="space-y-4">
          <div className="rounded-md border border-white/10 bg-black/20 px-3 py-2 text-xs">
            <div className="flex items-center justify-between">
              <span className="text-zinc-500">Status</span>
              <span
                className={
                  marketStatus === "resolved"
                    ? "font-semibold text-emerald-300"
                    : marketStatus === "disputed"
                      ? "font-semibold text-amber-300"
                      : "font-semibold text-zinc-300"
                }
              >
                {marketStatus}
                {marketStatus === "resolved" && outcome ? ` (${outcome.toUpperCase()})` : ""}
              </span>
            </div>
            {statusHint && (
              <p className="mt-1 text-zinc-400">{statusHint}</p>
            )}
          </div>

          <div>
            <label className="block text-xs font-semibold uppercase tracking-widest text-zinc-500 mb-1.5">
              Evidence URI
            </label>
            <input
              type="text"
              value={evidenceUri}
              onChange={(e) => setEvidenceUri(e.target.value)}
              placeholder="https:// or ipfs:// or ar://"
              disabled={statusBlocksSubmit}
              className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-white outline-none transition focus:border-amber-500/50 focus:ring-1 focus:ring-amber-500/30 disabled:opacity-50"
            />
            <div className="mt-1 flex items-center justify-between text-xs">
              <span className="text-zinc-500">
                Public link to your evidence — transaction logs, oracle
                response, screenshot, etc.
              </span>
              <span
                className={
                  uriTooLong
                    ? "font-mono text-rose-300"
                    : "font-mono text-zinc-500"
                }
              >
                {uriBytes}/{MAX_EVIDENCE_URI_BYTES} B
              </span>
            </div>
          </div>

          {error && (
            <p className="rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
              {error}
            </p>
          )}

          {digest && (
            <p className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-300">
              Dispute submitted. Digest: <code className="font-mono">{digest.slice(0, 16)}…</code>
            </p>
          )}

          <div className="flex items-center gap-3">
            <button
              disabled={!canSubmit}
              onClick={submit}
              className="rounded-lg bg-gradient-to-r from-rose-500 to-amber-500 px-4 py-2 text-sm font-semibold text-white shadow-md transition hover:brightness-110 disabled:opacity-50"
            >
              {submitting ? "Submitting…" : "File dispute"}
            </button>
            <button
              onClick={() => router.push(`/markets/${encodeURIComponent(marketId)}`)}
              className="rounded-lg border border-white/10 px-4 py-2 text-sm font-semibold text-zinc-300 transition hover:bg-white/5"
            >
              Cancel
            </button>
          </div>
          {!account && (
            <p className="text-xs text-amber-300">
              Connect a wallet to file a dispute.
            </p>
          )}
        </div>
      </Card>
    </div>
  );
}
