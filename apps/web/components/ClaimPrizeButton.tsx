"use client";

import { useCurrentAccount, useCurrentClient, useDAppKit } from "@mysten/dapp-kit-react";
import { useCallback, useState } from "react";
import { buildClaimPrizeTx, expectedAmountForRank } from "@suipredict/sdk";
import { toast } from "sonner";
import { useUserStreakId } from "@/hooks/useUserStreakId";

interface SignedClaimResponse {
  signatureB64: string;
  amount: string;
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
      const url = new URL(`${base}/prize/signature`);
      url.searchParams.set("week", String(weekIndex));
      url.searchParams.set("rank", String(rank));
      url.searchParams.set("user", account.address);
      url.searchParams.set("amount", amount.toString());
      url.searchParams.set("poolId", poolId);
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
      toast.loading("Submitting on-chain claim…", { id: toastId });
      const tx = buildClaimPrizeTx({
        poolId,
        prizeAdminId,
        userStreakId: streakId,
        weekIndex: BigInt(weekIndex),
        rank,
        amount: BigInt(data.amount ?? amount.toString()),
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
