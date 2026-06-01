"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  useCurrentAccount,
  useDAppKit,
} from "@mysten/dapp-kit-react";
import { buildDisputeMarketTx } from "@suipredict/sdk";
import { Card } from "@/components/ui";

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

  const canSubmit =
    !!account && !!marketId && evidenceUri.trim().length > 0 && !submitting;

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
      setError(err instanceof Error ? err.message : String(err));
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
          <div>
            <label className="block text-xs font-semibold uppercase tracking-widest text-zinc-500 mb-1.5">
              Evidence URI
            </label>
            <input
              type="text"
              value={evidenceUri}
              onChange={(e) => setEvidenceUri(e.target.value)}
              placeholder="https:// or ipfs:// or ar://"
              className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-white outline-none transition focus:border-amber-500/50 focus:ring-1 focus:ring-amber-500/30"
            />
            <p className="mt-1 text-xs text-zinc-500">
              Public link to your evidence — transaction logs, oracle
              response, screenshot, etc. Max length is bounded by the
              on-chain vector size.
            </p>
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
