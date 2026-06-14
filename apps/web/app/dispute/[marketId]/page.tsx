"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import {
  useCurrentAccount,
  useCurrentClient,
  useDAppKit,
} from "@mysten/dapp-kit-react";
import { buildDisputeMarketTx, getMarket, isMoveAbortCode, normalizeObjectId } from "@suipredict/sdk";
import { Card } from "@/components/ui";
import { submitAndWait } from "@/lib/dapp-kit";
import { toast } from "sonner";

// On-chain `MAX_EVIDENCE_URI_BYTES` (packages/contracts/sources/prediction_market.move:51).
// Hard-capped at the protocol layer; the user gets `EEvidenceUriTooLong` (abort 16)
// on submit, but a client-side check avoids paying gas for a doomed tx.
const MAX_EVIDENCE_URI_BYTES = 256;

// `dispute_market` aborts with code 15 (`EMarketDisputed`) when the market
// is already disputed, and code 16 (`EEvidenceUriTooLong`) for overlong
// URIs. We surface these as friendly messages instead of raw Move aborts.
// Codes resolved via the shared SDK helper (`@suipredict/sdk/move-errors`)
// so the dispute page doesn't maintain its own regex.
function friendlyDisputeError(err: unknown): string {
  if (isMoveAbortCode(err, "prediction_market", 15)) {
    return "This market is already disputed and is frozen. The market creator must resolve the dispute before a new one can be filed.";
  }
  if (isMoveAbortCode(err, "prediction_market", 16)) {
    return `Evidence URI exceeds the 256-byte on-chain limit.`;
  }
  const msg = err instanceof Error ? err.message : String(err);
  if (/EMarketDisputed|EEvidenceUriTooLong/.test(msg)) return msg;
  return msg;
}

export default function DisputeMarketPage() {
  const { marketId: rawId } = useParams<{ marketId: string }>();
  const marketId = decodeURIComponent(rawId ?? "");
  const account = useCurrentAccount();
  const client = useCurrentClient();
  const dAppKit = useDAppKit();
  const router = useRouter();
  // R56.6 audit fix: invalidate cross-page caches after a
  // successful dispute. The success branch toasts
  // "Dispute filed" but never refetches the indexer-backed
  // state on the markets list / market detail page; a user
  // who navigates back to `/markets/${marketId}` immediately
  // after the dispute toast sees the pre-dispute
  // `status === "resolved"` for ~30s (the indexer mirror's
  // lag). They can re-click "File dispute" and hit the
  // on-chain `EMarketDisputed` abort. R55 audited the
  // markets/[id] page's 6 invalidation sites; the dispute
  // success path was missed.
  const queryClient = useQueryClient();
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
        const m = await getMarket(normalizeObjectId(marketId));
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
    // R56.9 audit fix: gate on `client` like every other
    // submitAndWait call site. The non-null assertion
    // `client!` (line below) throws when dapp-kit is
    // still initializing (race on initial mount) or
    // after a wallet disconnect mid-render. The sibling
    // markets/[id], vault, and parlay pages all gate on
    // `!account || !client || !...` BEFORE calling
    // `submitAndWait`; the dispute page was the survivor.
    if (!client) {
      toast.error("Wallet not ready");
      return;
    }
    setSubmitting(true);
    setError(null);
    const toastId = toast.loading("Filing dispute...");
    try {
      const tx = buildDisputeMarketTx(marketId, evidenceUri.trim());
      // R54 audit fix: route through `submitAndWait` so the
      // subsequent `invalidateQueries` / state refetch hits a
      // node that has already finalized the tx. The previous
      // raw `signAndExecuteTransaction` returned the moment
      // the wallet signed, so a user who navigated to
      // `/markets/${marketId}` immediately after the dispute
      // toast saw the pre-dispute `status === "resolved"`
      // (stale indexer) and re-clicked "File dispute",
      // hitting `EMarketDisputed` on-chain.
      const r = await submitAndWait(dAppKit, client, tx);
      // R37 audit fix: bail with an explicit error rather than
      // rendering the "Digest: submitted..." card on a Failed /
      // EffectsCert variant. The old code displayed "submitted" as
      // if it were a real digest, so a failed dispute looked
      // identical to a successful one minus the txblock link.
      if (r.$kind !== "Transaction") {
        // R48 audit fix: also surface a toast in addition to the
        // inline `setError`. The inline block sits below the form
        // and is easy to miss on a long page where the user has
        // scrolled to the top to re-read the evidence URI; the
        // toast pins to the top-right and persists for 5s. The
        // sibling markets/[id] page uses the toast pattern for the
        // same $kind failure.
        setError("Dispute failed on-chain");
        toast.error("Dispute failed on-chain", { id: toastId });
        return;
      }
      setDigest(r.digest);
      toast.success("Dispute filed", { id: toastId });
      // R56.6 audit fix: invalidate the cross-page caches
      // that surface market state. `["marketsList"]` is
      // the home / markets list; `["market", marketId]`
      // is the per-market detail page that the user is
      // about to navigate back to. The local `setDigest`
      // above keeps the success card on this page; the
      // invalidation ensures the next page-mount
      // (or the user's browser back button) sees the
      // fresh indexer state, not a 30s-stale
      // `status === "resolved"`.
      void queryClient.invalidateQueries({
        queryKey: ["marketsList"],
        type: "active",
      });
      void queryClient.invalidateQueries({
        queryKey: ["market", normalizeObjectId(marketId)],
        type: "active",
      });
    } catch (err) {
      const msg = friendlyDisputeError(err);
      setError(msg);
      toast.error(msg, { id: toastId });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6 pb-12">
      {/* R30 sweep fix: back link to the
         originating market page so a user
         who navigated into the dispute
         flow from /markets/:id can return
         in one click. The pre-R30 build
         had no navigation back, so a
         user who changed their mind had
         to manually retype the URL or
         use the browser back button
         (which would re-trigger the
         preflight fetch in `useEffect`). */}
      <Link
        href={`/markets/${encodeURIComponent(marketId)}`}
        className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 -ml-2 text-sm font-medium text-zinc-400 transition hover:bg-white/5 hover:text-white"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 18l-6-6 6-6" />
        </svg>
        Back to market
      </Link>
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
          {/^0x[0-9a-fA-F]{64}$/.test(marketId) && (
            <a
              href={`https://${process.env.NEXT_PUBLIC_SUI_NETWORK ?? "testnet"}.suivision.xyz/object/${marketId}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-md border border-cyan-500/30 bg-cyan-500/10 px-2 py-1 text-xs font-semibold text-cyan-300 hover:bg-cyan-500/20 transition"
            >
              <span>View on SuiVision</span>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                <path strokeLinecap="round" d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
              </svg>
            </a>
          )}
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
            <label
              // R48 audit fix: bind the label to the input via
              // `htmlFor` + `id` so screen readers can navigate
              // from the label text to the field. R47 added the
              // same pattern to the admin withdraw form; the
              // dispute evidence URI input was missed.
              htmlFor="dispute-evidence-uri"
              className="block text-xs font-semibold uppercase tracking-widest text-zinc-500 mb-1.5"
            >
              Evidence URI
            </label>
            <input
              id="dispute-evidence-uri"
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
