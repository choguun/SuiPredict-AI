/**
 * Resolve the user's `UserStreak` object id from the shared
 * `StreakRegistry`. Returns null if the user has not yet created a
 * streak, in which case the UI should show the "Start your streak"
 * CTA.
 */
"use client";

import { useQuery } from "@tanstack/react-query";
import { getSharedClient, streakIdForUser } from "@suipredict/sdk";

const REGISTRY_ID = process.env.NEXT_PUBLIC_STREAK_REGISTRY_ID ?? "";

export function useUserStreakId(address: string | null | undefined): {
  streakId: string | null;
  isLoading: boolean;
  /** Re-fetch the streak id from the registry. Bypasses
   *  the `staleTime` so a "Check again" button or a focus
   *  refetch can recover from a transient `null` (e.g. the
   *  user just signed `create_streak` via an external
   *  wallet tool and the UI cached `null` before the tx
   *  finalized). */
  refetch: () => void;
} {
  const query = useQuery<string | null>({
    queryKey: ["userStreakId", REGISTRY_ID, address],
    enabled: !!address && !!REGISTRY_ID,
    // 30s TTL is a good balance: the user doesn't see a stale
    // "no streak yet" state for long, and pages that subscribe to
    // this hook (StreakProfile, /markets/[id], ClaimPrizeButton) don't
    // burn 3 RPCs per session the way `staleTime: 0` would. When a
    // streak is actually created, StreakProfile issues a precise
    // `invalidateQueries({ queryKey: ["userStreakId"] })` so the
    // refetch happens immediately for that one transition.
    staleTime: 30_000,
    queryFn: async () => {
      if (!address || !REGISTRY_ID) return null;
      // R58.4 audit fix: route through `getSharedClient()`
      // (process-wide gRPC client singleton) instead of
      // `createClient()` which opens a fresh connection
      // per query invocation. The home page, StreakProfile,
      // and ClaimPrizeButton each fire this hook; a typical
      // session saw ~20 idle gRPC channels after a few
      // minutes. The other read hooks (useMarket, usePortfolio,
      // …) already use the shared client.
      return streakIdForUser(getSharedClient(), REGISTRY_ID, address);
    },
  });

  return {
    streakId: query.data ?? null,
    isLoading: query.isLoading,
    refetch: () => {
      void query.refetch();
    },
  };
}
