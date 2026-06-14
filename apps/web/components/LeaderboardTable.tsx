"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ClaimPrizeButton } from "@/components/ClaimPrizeButton";
import { useFriends } from "@/lib/friends";

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
    // R43 audit fix: pause the 30s refetch while the tab is
    // hidden. A 1h backgrounded tab previously fired 120
    // `fetchLeaderboard` calls per hour against the agents
    // service. Returning `false` from the interval function
    // is TanStack's canonical "pause polling" signal;
    // `refetchOnWindowFocus: true` below ensures a single
    // catch-up refetch fires when the user returns. R42
    // added the same guard to the markets/[id], vault, and
    // parlay pages; LeaderboardTable was the survivor.
    refetchInterval: () => {
      if (typeof document === "undefined") return 30_000;
      return document.visibilityState === "visible" ? 30_000 : false;
    },
    refetchOnWindowFocus: true,
    staleTime: 15_000,
  });

  const fetchError = error
    ? error instanceof Error
      ? error.message
      : "Fetch failed"
    : initialError;
  // Friends-only filter: when the user has friends, show only
  // rows whose user is in the friends list. (Toggling resets the
  // refetch interval timer but the data itself is shared — no
  // extra network round-trip.)
  const { friends } = useFriends();
  const [friendsOnly, setFriendsOnly] = useState(false);
  useEffect(() => {
    // If the user just unfollowed their last friend, drop back
    // to the global view automatically.
    if (friendsOnly && friends.length === 0) setFriendsOnly(false);
  }, [friendsOnly, friends.length]);
  const baseRows = data?.rows ?? [];
  const rows = friendsOnly
    ? baseRows.filter((r) => friends.includes(r.user))
    : baseRows;
  const weekIndex = data?.week_index ?? 0;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between text-xs text-zinc-500">
        <span className="flex items-center gap-2">
          {dataUpdatedAt > 0
            ? `Updated ${new Date(dataUpdatedAt).toLocaleTimeString()}`
            : "Loading…"}
          {/* R62 audit fix: surface the current
             week index in the meta row. The
             previous build only printed the
             "Updated HH:MM:SS" string, and a
             user landing on the page on a
             Sunday evening (just before the
             Monday 00:05 UTC rollup) had no
             way to know whether they were
             looking at this week or last
             week's archived scores. The week
             index is the same `week_index`
             the backend already returns; we
             just render it next to the
             timestamp with a short "Week
             #N" prefix. The same pattern
             is also exposed via the page
             header below the title. */}
          {weekIndex > 0 && (
            <span className="rounded-md border border-white/10 bg-white/5 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-zinc-400">
              Week #{weekIndex}
            </span>
          )}
        </span>
        <div className="flex items-center gap-3">
          {friends.length > 0 && (
            <label className="inline-flex items-center gap-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={friendsOnly}
                onChange={(e) => setFriendsOnly(e.target.checked)}
                className="h-3.5 w-3.5 rounded border-white/20 bg-black/40"
              />
              <span className="text-zinc-300">Friends only</span>
            </label>
          )}
          {isFetching && <span className="animate-pulse text-cyan-400">Refreshing…</span>}
        </div>
      </div>

      {fetchError && (
        <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
          Could not reach agents service ({fetchError}). Start the agents
          service with `pnpm --filter @suipredict/agents dev` (port 3001)
          to see live data.
        </p>
      )}
      {rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-white/10 bg-white/[0.02] p-6 text-center">
          <div className="mb-2 text-3xl">🏆</div>
          {/* R30 sweep fix: friendlier empty
              state. The previous build was a
              bare 1-line paragraph that was
              easy to miss. The new state
              surfaces the icon, the canonical
              "rollup Monday 00:05 UTC" rule,
              and (when no scores are
              archived yet) a CTA back to the
              markets so the user can place
              their first prediction and start
              building a streak. */}
          <p className="text-sm text-zinc-300">
            {friendsOnly
              ? "None of your friends are on this week's leaderboard yet."
              : "No archived scores yet."}
          </p>
          {!friendsOnly && (
            <p className="mt-1 text-xs text-zinc-500">
              The leaderboard rolls up every Monday at 00:05 UTC. Place your
              first prediction to start building a streak.
            </p>
          )}
          {!friendsOnly && (
            <Link
              href="/markets"
              className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-emerald-500/20 px-3 py-1.5 text-xs font-bold text-emerald-300 border border-emerald-500/30 hover:bg-emerald-500/30 transition"
            >
              Browse markets →
            </Link>
          )}
        </div>
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
                        category={row.category}
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
