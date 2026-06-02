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
}

interface Props {
  poolId: string;
  prizeAdminId: string;
  weekIndex: number;
  rank: number;
  weeklyPrize: bigint;
  alreadyClaimed?: boolean;
}

function txDigest(r: { $kind: string; Transaction?: { digest: string } }): string {
  return r.$kind === "Transaction" ? r.Transaction!.digest : "unknown";
}

export function ClaimPrizeButton(props: Props) {
  const {
    poolId,
    prizeAdminId,
    weekIndex,
    rank,
    weeklyPrize,
    alreadyClaimed,
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
      toast.success(
        `Claimed ${amountUsdc} DUSDC: ${txDigest(r).slice(0, 16)}…`,
        { id: toastId },
      );
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
