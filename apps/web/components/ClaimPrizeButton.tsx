"use client";

import { useCurrentAccount, useCurrentClient, useDAppKit } from "@mysten/dapp-kit-react";
import { useCallback, useState } from "react";
import { buildClaimPrizeTx, expectedAmountForRank } from "@suipredict/sdk";
import { toast } from "sonner";
import { useUserStreakId } from "@/hooks/useUserStreakId";

/**
 * Mirrors the server response from `apps/agents/src/gamification/routes.ts`
 * (the `/prize/signature` handler). The server signs the canonical claim
 * payload server-side and returns:
 *   - `payload`     — the exact bytes the Move contract will verify,
 *                     with bigint fields serialized as decimal strings.
 *   - `signatureB64` — ed25519 signature over the payload.
 *   - `expectedAmount` — the canonical reward for the user's rank, so the
 *                     client can render the amount without recomputing.
 *   - `amountSource` — `"onchain"` if the server derived the amount from
 *                     the on-chain `PrizePool.weekly_prize`, `"env"` if
 *                     the on-chain read failed and the server fell back
 *                     to the `PRIZE_WEEKLY_AMOUNT` env var. Surface this
 *                     in the console for operator visibility — an `env`
 *                     path in production is a sign the gRPC client is
 *                     down and the operator should investigate.
 *
 * The `poolId` query param the client sends is *advisory*; the server
 * always signs with the prize pool configured in its env (it must, since
 * the on-chain `claim_prize` only accepts the canonical pool for this
 * week). Sending it would let a misconfigured client hit the wrong pool,
 * so the server deliberately ignores it.
 */
interface SignedClaimResponse {
  payload: {
    poolId: string;
    weekIndex: string;
    user: string;
    rank: number;
    amount: string;
  };
  signatureB64: string;
  expectedAmount: string;
  amountSource?: "onchain" | "env";
}

interface Props {
  poolId: string;
  prizeAdminId: string;
  weekIndex: number;
  rank: number;
  // 0=general, 1=ai_news, 2=crypto_price, 3=other — must match the
  // leaderboard's category filter or the server returns 403
  // "user not on leaderboard for this week and category".
  category?: number;
  weeklyPrize: bigint;
  alreadyClaimed?: boolean;
}

export function ClaimPrizeButton(props: Props) {
  const {
    poolId,
    prizeAdminId,
    weekIndex,
    rank,
    weeklyPrize,
    alreadyClaimed,
    category,
  } = props;
  const account = useCurrentAccount();
  const client = useCurrentClient();
  const dAppKit = useDAppKit();
  const { streakId } = useUserStreakId(account?.address);
  const [loading, setLoading] = useState(false);

  const amount = expectedAmountForRank(weeklyPrize, rank);
  const amountUsdc = (Number(amount) / 1_000_000).toFixed(2);

  const onClaim = useCallback(async () => {
    if (!account) {
      toast.error("Connect your wallet to claim");
      return;
    }
    if (!streakId) {
      toast.error("Start your streak first (Streak profile on the home page)");
      return;
    }
    if (!client) {
      toast.error("Wallet client not ready");
      return;
    }
    setLoading(true);
    const toastId = toast.loading("Fetching backend signature…");
    try {
      const base = process.env.NEXT_PUBLIC_AGENTS_URL ?? "http://localhost:3001";
      // Path is `/prize/signature`; legacy `/prize/claim-payload` was
      // an earlier draft that the server no longer recognises. Sending
      // to it returns 404 and the user sees a confusing error.
      const url = new URL(`${base}/prize/signature`);
      url.searchParams.set("week", String(weekIndex));
      url.searchParams.set("rank", String(rank));
      url.searchParams.set("user", account.address);
      // Pass `category` so the server-side membership check uses the
      // same leaderboard the user is looking at. Without it, a user
      // with rank-1 in "AI news" could request a signature for the
      // "crypto price" pool (round-17 audit finding #6). Defaults to
      // 0 (general) for callers that haven't been updated yet.
      url.searchParams.set("category", String(category ?? 0));
      // `amount` is intentionally NOT sent — the server is the single
      // source of truth for the rank table (re-derives via
      // `expectedAmountForRank`) and re-derives the canonical value
      // before signing. Sending a client-computed amount would only
      // produce false-positive "rank-table mismatch" warnings when
      // `PRIZE_WEEKLY_AMOUNT` is updated server-side without a
      // web rebuild.
      const res = await fetch(url.toString());
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(
          `signature endpoint ${res.status}: ${text.slice(0, 200) || "no body"}`,
        );
      }
      const data = (await res.json()) as SignedClaimResponse;
      if (!data.signatureB64) {
        throw new Error("signature endpoint returned no signature");
      }
      // The signed amount lives at `data.payload.amount`; the server
      // has already cross-checked it against its own rank table.
      const signedAmount = data.payload?.amount ?? amount.toString();
      // Surface `amountSource` for operator visibility. An `"env"`
      // path means the agents service couldn't read the on-chain
      // `PrizePool.weekly_prize` and fell back to the env var — a
      // gRPC outage in production that the operator should know
      // about. `console.info` rather than a toast so the user isn't
      // interrupted during the claim flow.
      if (data.amountSource) {
        console.info(
          `[ClaimPrizeButton] amountSource=${data.amountSource} ` +
            `(expectedAmount=${data.expectedAmount})`,
        );
      }
      toast.loading("Submitting on-chain claim…", { id: toastId });
      const tx = buildClaimPrizeTx({
        poolId,
        prizeAdminId,
        userStreakId: streakId,
        weekIndex: BigInt(weekIndex),
        rank,
        amount: BigInt(signedAmount),
        signatureB64: data.signatureB64,
        poolIdForSig: poolId,
      });
      const r = await dAppKit.signAndExecuteTransaction({ transaction: tx });
      // $kind guard — Failed / EffectsCert variants carry no digest.
      // Previously this code called a `txDigest()` helper that
      // returned the literal string "unknown" on non-Transaction
      // results, then unconditionally toasted "Claimed X DUSDC:
      // unknown…" and POSTed `txDigest: "unknown"` to /prize/claims,
      // polluting the off-chain mirror with phantom claims. R30
      // closed the same pattern in DailyPredictionCard / VaultPage;
      // R32 closes it here.
      if (r.$kind !== "Transaction") {
        toast.error("Claim failed on-chain", { id: toastId });
        return;
      }
      const digest = r.Transaction.digest;
      toast.success(
        `Claimed ${amountUsdc} DUSDC: ${digest.slice(0, 16)}…`,
        { id: toastId },
      );
      // Notify the agents service so the off-chain `prize_claims` row
      // is updated — without this, `liveRollup` still annotates the
      // user as unclaimed and the leaderboard keeps showing the Claim
      // button. The next click would pass the server's membership
      // check (off-chain table is stale) and only fail on the on-chain
      // `EAlreadyClaimed` Move abort, surfacing as a confusing
      // "MoveAbort(...) 4" toast. The server endpoint is best-effort:
      // the on-chain tx already succeeded, so a network error here
      // just means the user has to refresh once for the UI to update.
      try {
        const recordUrl = new URL(`${base}/prize/claims`);
        await fetch(recordUrl.toString(), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            user: account.address,
            weekIndex,
            rank,
            // R50 audit fix: pass `category` so the
            // server's membership check is category-
            // scoped. Without it, a rank-1 in "AI
            // news" (category=1) would still pass the
            // server's check on the global
            // (category=0) leaderboard and the
            // off-chain mirror row would be written
            // with no category, losing the
            // attribution. The /prize/signature
            // endpoint already enforces this (round-17
            // audit, finding #6); /prize/claims was
            // the asymmetric survivor.
            category: category ?? 0,
            amount: signedAmount,
            txDigest: digest,
          }),
        });
      } catch (recordErr) {
        // Non-fatal: the on-chain claim already succeeded. The
        // position-indexer backstops this within ~1 poll cycle.
        // Without an explicit toast, the user wouldn't know their
        // claim was recorded and might re-click, hitting the on-chain
        // EAlreadyClaimed abort and seeing a confusing error.
        toast.warning(
          "Claim recorded on-chain; leaderboard will update within ~1 min.",
          { id: `${toastId}-record` },
        );
        console.warn("[ClaimPrizeButton] failed to record claim:", recordErr);
      }
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Claim failed",
        { id: toastId },
      );
    } finally {
      setLoading(false);
    }
  }, [
    account,
    client,
    dAppKit,
    streakId,
    poolId,
    prizeAdminId,
    weekIndex,
    rank,
    amount,
    amountUsdc,
    category,
  ]);

  if (alreadyClaimed) {
    return (
      <span className="inline-flex items-center gap-1 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-xs font-semibold text-emerald-300">
        Claimed
      </span>
    );
  }

  return (
    <button
      type="button"
      disabled={loading || !account || amount === BigInt(0)}
      onClick={onClaim}
      className="min-h-9 rounded-md bg-gradient-to-r from-amber-500 to-orange-400 px-3.5 text-xs font-semibold text-zinc-950 shadow-lg shadow-amber-900/30 transition-all hover:scale-[1.02] disabled:cursor-not-allowed disabled:opacity-50 disabled:scale-100"
    >
      {loading ? "Claiming…" : `Claim ${amountUsdc} DUSDC`}
    </button>
  );
}
