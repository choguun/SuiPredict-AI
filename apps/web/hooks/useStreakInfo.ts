/**
 * Streak info hook — TanStack Query wrapper for `getStreakInfo`.
 *
 * Accepts an optional `streakId`. If undefined, returns a "no streak"
 * shape so the caller can show the "Start your streak" CTA without
 * branching.
 */
"use client";

import { useQuery } from "@tanstack/react-query";
import {
  computeMultiplierBps,
  createClient,
  getStreakInfo,
  type StreakInfo,
} from "@suipredict/sdk";

export interface UseStreakInfoResult {
  info: StreakInfo | null;
  isLoading: boolean;
  isError: boolean;
  hasStreak: boolean;
  /** Multiplier in bps (10_000 = 1.0x). */
  multiplierBps: number;
  /** Human-readable multiplier (e.g. 1.3 for +30%). */
  multiplier: number;
  /** Next milestone threshold, or null if at the top tier. */
  nextMilestoneDays: number | null;
  /** Days until next milestone (clamped at 0). */
  daysToNext: number;
}

const TIER_THRESHOLDS = [3, 7, 14, 30, 100];

function pickNextThreshold(current: number): number | null {
  for (const t of TIER_THRESHOLDS) {
    if (current < t) return t;
  }
  return null;
}

export function useStreakInfo(streakId: string | null | undefined): UseStreakInfoResult {
  const query = useQuery<StreakInfo | null>({
    queryKey: ["streakInfo", streakId],
    enabled: !!streakId,
    staleTime: 30_000,
    queryFn: async () => {
      if (!streakId) return null;
      const client = createClient();
      return getStreakInfo(client, streakId);
    },
  });

  const info = query.data ?? null;
  const hasStreak = !!info;
  const current = info?.current_streak ?? 0;
  const tier = info?.multiplier_tier ?? 0;
  const multiplierBps = hasStreak ? info!.multiplier_bps : computeMultiplierBps(tier);
  const next = pickNextThreshold(current);

  return {
    info,
    isLoading: query.isLoading,
    isError: query.isError,
    hasStreak,
    multiplierBps,
    multiplier: multiplierBps / 10_000,
    nextMilestoneDays: next,
    daysToNext: next ? Math.max(0, next - current) : 0,
  };
}
