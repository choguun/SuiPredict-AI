/**
 * Resolve the user's `UserStreak` object id from the shared
 * `StreakRegistry`. Returns null if the user has not yet created a
 * streak, in which case the UI should show the "Start your streak"
 * CTA.
 */
"use client";

import { useQuery } from "@tanstack/react-query";
import { createClient, streakIdForUser } from "@suipredict/sdk";

const REGISTRY_ID = process.env.NEXT_PUBLIC_STREAK_REGISTRY_ID ?? "";

export function useUserStreakId(address: string | null | undefined): {
  streakId: string | null;
  isLoading: boolean;
} {
  const query = useQuery<string | null>({
    queryKey: ["userStreakId", REGISTRY_ID, address],
    enabled: !!address && !!REGISTRY_ID,
    // Keep the query fresh (always refetch on remount) so a freshly
    // created UserStreak is visible immediately on the markets page.
    // The previous 60s TTL meant users who clicked "Start your streak"
    // saw the redeem-without-streak branch for up to a minute on
    // `/markets/[id]`, missing the multiplier for that first claim.
    staleTime: 0,
    queryFn: async () => {
      if (!address || !REGISTRY_ID) return null;
      const client = createClient();
      return streakIdForUser(client, REGISTRY_ID, address);
    },
  });

  return {
    streakId: query.data ?? null,
    isLoading: query.isLoading,
  };
}
