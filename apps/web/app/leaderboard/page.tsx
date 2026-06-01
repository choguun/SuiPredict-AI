import { Card } from "@/components/ui";
import { LeaderboardTable } from "@/components/LeaderboardTable";

export const dynamic = "force-dynamic";

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

const AGENTS_URL = process.env.NEXT_PUBLIC_AGENTS_URL ?? "http://localhost:3001";
const DEFAULT_LIMIT = 20;

export default async function LeaderboardPage() {
  let initialData: LeaderboardResponse | null = null;
  let initialError: string | null = null;

  try {
    const res = await fetch(
      `${AGENTS_URL}/leaderboard/week?limit=${DEFAULT_LIMIT}`,
      { cache: "no-store" },
    );
    if (res.ok) {
      initialData = (await res.json()) as LeaderboardResponse;
    } else {
      initialError = `Agents responded ${res.status}`;
    }
  } catch (err) {
    initialError = err instanceof Error ? err.message : "Agents unreachable";
  }

  const prizePoolId = process.env.NEXT_PUBLIC_PRIZE_POOL_ID ?? "";
  const prizeAdminId = process.env.NEXT_PUBLIC_PRIZE_ADMIN_ID ?? "";
  const weeklyPrize = BigInt(
    process.env.PRIZE_WEEKLY_AMOUNT ??
      process.env.NEXT_PUBLIC_PRIZE_WEEKLY_AMOUNT ??
      "0",
  );

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-transparent bg-clip-text bg-gradient-to-r from-white to-cyan-200">
          Leaderboard
        </h1>
        <p className="mt-2 text-zinc-400">
          Weekly streak rankings. Auto-refreshes every 30s.
        </p>
      </div>

      <Card title="Rankings" className="border-white/10">
        <LeaderboardTable
          initialData={initialData}
          initialError={initialError}
          prizePoolId={prizePoolId}
          prizeAdminId={prizeAdminId}
          weeklyPrize={weeklyPrize}
          limit={DEFAULT_LIMIT}
        />
      </Card>
    </div>
  );
}
