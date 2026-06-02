"use client";

import { useQuery } from "@tanstack/react-query";
import { ClaimPrizeButton } from "@/components/ClaimPrizeButton";

interface WeeklyRow {
  user: string;
  week_index: number;
  score: number;
  rank: number;
  correct_days: number;
  longest_streak: number;
  category: number;
  claimed?: boolean;
}

interface LeaderboardResponse {
  week_index: number;
  rows: WeeklyRow[];
}

interface Props {
  initialData: LeaderboardResponse | null;
  initialError: string | null;
  prizePoolId: string;
  prizeAdminId: string;
  weeklyPrize: bigint;
  limit?: number;
  category?: string;
}

const AGENTS_URL = process.env.NEXT_PUBLIC_AGENTS_URL ?? "http://localhost:3001";

async function fetchLeaderboard(
  limit: number,
  category: string,
): Promise<LeaderboardResponse> {
  const qs = new URLSearchParams({ limit: String(limit) });
  if (category) qs.set("category", category);
  const res = await fetch(`${AGENTS_URL}/leaderboard/week?${qs.toString()}`, {
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`Agents responded ${res.status}`);
  }
  return (await res.json()) as LeaderboardResponse;
}

export function LeaderboardTable({
  initialData,
  initialError,
  prizePoolId,
  prizeAdminId,
  weeklyPrize,
  limit = 20,
  category = "",
}: Props) {
  const { data, error, isFetching, dataUpdatedAt } = useQuery({
    queryKey: ["leaderboard", "week", limit, category],
    queryFn: () => fetchLeaderboard(limit, category),
    initialData: initialData ?? undefined,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
    staleTime: 15_000,
  });

  const fetchError = error
    ? error instanceof Error
      ? error.message
      : "Fetch failed"
    : initialError;
  const rows = data?.rows ?? [];
  const weekIndex = data?.week_index ?? 0;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between text-xs text-zinc-500">
        <span>
          {dataUpdatedAt > 0
            ? `Updated ${new Date(dataUpdatedAt).toLocaleTimeString()}`
            : "Loading…"}
        </span>
        {isFetching && <span className="animate-pulse text-cyan-400">Refreshing…</span>}
      </div>

      {fetchError && (
        <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
          Could not reach agents service ({fetchError}). Start the backend
          with `pnpm dev:agents` to see live data.
        </p>
      )}
      {rows.length === 0 ? (
        <p className="text-sm text-zinc-500">
          No archived scores yet. The leaderboard rolls up every Monday 00:05 UTC.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/10 text-left text-zinc-400">
                <th className="pb-3 pr-4 font-semibold uppercase tracking-wider text-xs">#</th>
                <th className="pb-3 pr-4 font-semibold uppercase tracking-wider text-xs">User</th>
                <th className="pb-3 pr-4 font-semibold uppercase tracking-wider text-xs">Score</th>
                <th className="pb-3 pr-4 font-semibold uppercase tracking-wider text-xs">Correct Days</th>
                <th className="pb-3 pr-4 font-semibold uppercase tracking-wider text-xs">Longest Streak</th>
                <th className="pb-3 font-semibold uppercase tracking-wider text-xs">Prize</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.user}
                  className="border-b border-white/5 transition-colors hover:bg-white/5"
                >
                  <td className="py-3 pr-4 text-zinc-500">{row.rank}</td>
                  <td className="py-3 pr-4 font-mono text-xs text-cyan-400">
                    {row.user.slice(0, 10)}…{row.user.slice(-4)}
                  </td>
                  <td className="py-3 pr-4 text-zinc-300">{row.score.toFixed(2)}</td>
                  <td className="py-3 pr-4 text-zinc-300">{row.correct_days}</td>
                  <td className="py-3 pr-4 text-white font-medium">{row.longest_streak}</td>
                  <td className="py-3">
                    {row.rank <= 10 && prizePoolId && prizeAdminId ? (
                      <ClaimPrizeButton
                        poolId={prizePoolId}
                        prizeAdminId={prizeAdminId}
                        weekIndex={weekIndex}
                        rank={row.rank}
                        weeklyPrize={weeklyPrize}
                        alreadyClaimed={row.claimed === true}
                      />
                    ) : (
                      <span className="text-zinc-600">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
