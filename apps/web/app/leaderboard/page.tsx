import { Card } from "@/components/ui";

export const dynamic = "force-dynamic";

interface WeeklyRow {
  user: string;
  week_index: number;
  score: number;
  rank: number;
  correct_days: number;
  longest_streak: number;
  category: number;
}

interface LeaderboardResponse {
  week_index: number;
  rows: WeeklyRow[];
}

const AGENTS_URL = process.env.NEXT_PUBLIC_AGENTS_URL ?? "http://localhost:3001";
const DEFAULT_LIMIT = 20;

export default async function LeaderboardPage() {
  let rows: WeeklyRow[] = [];
  let weekIndex = 0;
  let fetchError: string | null = null;

  try {
    const res = await fetch(
      `${AGENTS_URL}/leaderboard/week?limit=${DEFAULT_LIMIT}`,
      { cache: "no-store" },
    );
    if (res.ok) {
      const data = (await res.json()) as LeaderboardResponse;
      rows = data.rows ?? [];
      weekIndex = data.week_index;
    } else {
      fetchError = `Agents responded ${res.status}`;
    }
  } catch (err) {
    fetchError = err instanceof Error ? err.message : "Agents unreachable";
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-transparent bg-clip-text bg-gradient-to-r from-white to-cyan-200">
          Leaderboard
        </h1>
        <p className="mt-2 text-zinc-400">
          Weekly streak rankings. {rows.length > 0 ? `Week ${weekIndex}.` : ""}
        </p>
      </div>

      <Card title="Rankings" className="border-white/10">
        {fetchError && (
          <p className="mb-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
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
                  <th className="pb-3 font-semibold uppercase tracking-wider text-xs">Longest Streak</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.user} className="border-b border-white/5 transition-colors hover:bg-white/5">
                    <td className="py-3 pr-4 text-zinc-500">{row.rank}</td>
                    <td className="py-3 pr-4 font-mono text-xs text-cyan-400">
                      {row.user.slice(0, 10)}…{row.user.slice(-4)}
                    </td>
                    <td className="py-3 pr-4 text-zinc-300">{row.score.toFixed(2)}</td>
                    <td className="py-3 pr-4 text-zinc-300">{row.correct_days}</td>
                    <td className="py-3 text-white font-medium">{row.longest_streak}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
