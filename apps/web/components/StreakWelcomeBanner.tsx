"use client";

import { useCurrentAccount, useDAppKit } from "@mysten/dapp-kit-react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { buildCreateStreakTx } from "@suipredict/sdk";
import { toast } from "sonner";
import { useUserStreakId } from "@/hooks/useUserStreakId";

const REGISTRY_ID = process.env.NEXT_PUBLIC_STREAK_REGISTRY_ID ?? "";
const DISMISS_KEY = "suipredict.streak.banner.dismissed";

/**
 * Shows a one-time welcome banner when a wallet is connected but the
 * user has not yet created a streak. Dismissal is per-address so the
 * banner returns for new wallets on the same browser. Hides itself
 * automatically once a streak exists.
 */
export function StreakWelcomeBanner() {
  const account = useCurrentAccount();
  const dAppKit = useDAppKit();
  const { streakId, isLoading: idLoading } = useUserStreakId(account?.address);
  // R52 audit fix: hook up a
  // `useQueryClient` so the success
  // path can invalidate the
  // streak-related queries. Without
  // this, after `startStreak` the
  // home page's streak panel
  // (`["streakInfo", streakId]`,
  // `["userStreakId", REGISTRY_ID,
  // address]`) stays stale for the
  // hook's 30s `staleTime`, and the
  // banner itself dismisses via
  // `setDismissed(true)` after a
  // successful click — so the user
  // has no visual cue that anything
  // happened.
  const queryClient = useQueryClient();
  const [dismissed, setDismissed] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!account) {
      setDismissed(true);
      return;
    }
    const raw = window.localStorage.getItem(DISMISS_KEY);
    const dismissedAddrs: string[] = raw ? (JSON.parse(raw) as string[]) : [];
    setDismissed(dismissedAddrs.includes(account.address));
  }, [account]);

  // Surface a console warning so operators can see the banner is
  // silently gated when the env is unset. Mirrors the
  // `providers-inner` pattern for NEXT_PUBLIC_ENOKI_API_KEY.
  useEffect(() => {
    if (!REGISTRY_ID) {
      console.warn(
        "[StreakWelcomeBanner] NEXT_PUBLIC_STREAK_REGISTRY_ID is not set — the StreakProfile CTA is also gated.",
      );
    }
  }, []);

  if (!account || dismissed || idLoading || streakId) return null;
  if (!REGISTRY_ID) return null;

  async function dismiss() {
    if (!account) return;
    const raw = window.localStorage.getItem(DISMISS_KEY);
    const list: string[] = raw ? (JSON.parse(raw) as string[]) : [];
    if (!list.includes(account.address)) list.push(account.address);
    window.localStorage.setItem(DISMISS_KEY, JSON.stringify(list));
    setDismissed(true);
  }

  async function startStreak() {
    if (!REGISTRY_ID) return;
    setSubmitting(true);
    const toastId = toast.loading("Creating your streak…");
    try {
      const tx = buildCreateStreakTx(REGISTRY_ID);
      const r = await dAppKit.signAndExecuteTransaction({ transaction: tx });
      // `$kind === "Transaction"` means the fullnode accepted the tx;
      // other variants (`"Failed"`, `"EffectsCert"`) carry a different
      // shape. Without this guard, a failed ttx would still toast
      // "Streak created: ok…" (the audit's round-15 L5 finding).
      if (r.$kind === "Transaction") {
        toast.success(`Streak created: ${r.Transaction.digest.slice(0, 16)}…`, {
          id: toastId,
        });
        // R52 audit fix: invalidate
        // the streak-related
        // queries so the home
        // page's streak panel,
        // DailyPredictionCard's
        // streak badge, and the
        // /profile page all
        // refresh immediately
        // (the hook's `staleTime`
        // is 30s otherwise). Use
        // `type: "active"` to
        // match the R43 project-
        // wide convention so
        // inactive SSR preloaded
        // entries are not refetched.
        if (account?.address) {
          void queryClient.invalidateQueries({
            queryKey: ["userStreakId", REGISTRY_ID, account.address],
            type: "active",
          });
        }
        void queryClient.invalidateQueries({
          queryKey: ["streakInfo"],
          type: "active",
        });
        if (account?.address) {
          void queryClient.invalidateQueries({
            queryKey: ["portfolio", account.address],
            type: "active",
          });
          void queryClient.invalidateQueries({
            queryKey: ["marketsList"],
            type: "active",
          });
        }
      } else {
        toast.error("Streak creation failed", { id: toastId });
      }
      void dismiss();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Streak creation failed",
        { id: toastId },
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="relative overflow-hidden rounded-2xl border border-orange-500/30 bg-gradient-to-r from-orange-500/10 via-rose-500/10 to-violet-500/10 p-4 sm:p-5">
      <div className="absolute -right-12 -top-12 h-32 w-32 rounded-full bg-orange-500/20 blur-[40px] pointer-events-none" />
      <div className="relative z-10 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-orange-500/20 text-orange-300">
            <span className="text-2xl">🔥</span>
          </div>
          <div>
            <h3 className="text-sm font-bold text-white sm:text-base">
              Start your prediction streak
            </h3>
            <p className="mt-1 text-xs leading-relaxed text-zinc-300 sm:text-sm">
              Predict correctly every day to earn a multiplier up to{" "}
              <span className="font-semibold text-emerald-300">+150%</span> on
              your winning redemptions. Free to start.
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            disabled={submitting}
            onClick={startStreak}
            className="min-h-10 rounded-lg bg-gradient-to-r from-orange-500 to-rose-500 px-4 text-sm font-semibold text-white shadow-md shadow-orange-900/30 transition hover:brightness-110 disabled:opacity-50"
          >
            {submitting ? "Creating…" : "Start streak"}
          </button>
          <button
            type="button"
            onClick={dismiss}
            className="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs font-semibold text-zinc-300 transition hover:bg-white/10"
          >
            Later
          </button>
        </div>
      </div>
    </div>
  );
}
