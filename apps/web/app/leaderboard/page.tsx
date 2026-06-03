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

/**
 * PRD §4.3 mentions country / AI / friends leaderboards. The AI
 * category and the country filter are both implemented. The country
 * filter requires a `UserProfile.country_code` row, which the
 * position-indexer mirrors from on-chain `CountryCodeSet` events
 * (round-18). A user without a profile is excluded from the
 * country leaderboard but still appears on the global one.
 *
 * The `?country` and `?category` params compose: a query like
 * `?country=us&category=1` shows the US AI-news ranking.
 */
const CATEGORY_OPTIONS = [
  { value: "", label: "All categories" },
  { value: "0", label: "General" },
  { value: "1", label: "AI" },
  { value: "2", label: "Crypto" },
  { value: "3", label: "Other" },
];

export default async function LeaderboardPage({
  searchParams,
}: {
  searchParams: Promise<{ category?: string; addr?: string; country?: string; view?: string }>;
}) {
  const sp = await searchParams;
  const category = sp?.category ?? "";
  const addr = sp?.addr ?? "";
  // `view=country` switches the table to the national leaderboard.
  // Default is the global view; the country filter below narrows
  // whichever view is active.
  const view = sp?.view === "country" ? "country" : "global";
  // `country` is a lowercased ISO-3166-1 alpha-2 (or alpha-3 / BCP-47
  // up to 8 bytes). Empty string = no country filter, the agents
  // route returns an empty result set for invalid codes so we
  // additionally guard client-side.
  const country = (sp?.country ?? "").toLowerCase();
  const limit = DEFAULT_LIMIT;

  let initialData: LeaderboardResponse | null = null;
  let initialError: string | null = null;

  // Pick the right agents route based on `view`. The country route
  // accepts `?code=…&category=…`; the global route ignores `code`.
  const routePath = view === "country" && country
    ? "/leaderboard/country"
    : "/leaderboard/week";

  try {
    const qs = new URLSearchParams({ limit: String(limit) });
    if (category) qs.set("category", category);
    if (view === "country" && country) qs.set("code", country);
    const res = await fetch(
      `${AGENTS_URL}${routePath}?${qs.toString()}`,
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

  let userRow: WeeklyRow | null = null;
  let userError: string | null = null;
  if (addr) {
    try {
      const res = await fetch(
        `${AGENTS_URL}/leaderboard/user/${addr}`,
        { cache: "no-store" },
      );
      if (res.ok) {
        userRow = (await res.json()) as WeeklyRow;
      } else if (res.status !== 404) {
        userError = `Agents responded ${res.status}`;
      }
    } catch (err) {
      userError = err instanceof Error ? err.message : "Agents unreachable";
    }
  }

  const prizePoolId = process.env.NEXT_PUBLIC_PRIZE_POOL_ID ?? "";
  const prizeAdminId = process.env.NEXT_PUBLIC_PRIZE_ADMIN_ID ?? "";
  // Server-side `PRIZE_WEEKLY_AMOUNT` (no `NEXT_PUBLIC_` prefix) is
  // not inlined into the client bundle — Next.js only inlines
  // `NEXT_PUBLIC_*` at build time, so reading the unprefixed var
  // here always returned `undefined` in the browser. The on-chain
  // PrizePool `current_pot` is the source of truth on the API side
  // (returned by /prize/manifest); this value is only the static
  // fallback for first render.
  const weeklyPrize = BigInt(
    process.env.NEXT_PUBLIC_PRIZE_WEEKLY_AMOUNT ?? "0",
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

      <Card title="Filter" className="border-white/10">
        <form className="flex flex-wrap items-end gap-3" method="get">
          <label className="flex flex-col text-xs text-zinc-400">
            View
            <select
              name="view"
              defaultValue={view}
              className="mt-1 min-w-40 rounded-md border border-white/10 bg-black/30 px-3 py-2 text-sm text-white"
            >
              <option value="global">Global</option>
              <option value="country">By country</option>
            </select>
          </label>
          {view === "country" && (
            <label className="flex flex-col text-xs text-zinc-400">
              Country code
              <input
                name="country"
                defaultValue={country}
                placeholder="us, th, jp…"
                maxLength={8}
                pattern="[A-Za-z]{2,8}"
                className="mt-1 w-32 rounded-md border border-white/10 bg-black/30 px-3 py-2 font-mono text-xs text-white"
              />
            </label>
          )}
          <label className="flex flex-col text-xs text-zinc-400">
            Category
            <select
              name="category"
              defaultValue={category}
              className="mt-1 min-w-40 rounded-md border border-white/10 bg-black/30 px-3 py-2 text-sm text-white"
            >
              {CATEGORY_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col text-xs text-zinc-400">
            Look up address (optional)
            <input
              name="addr"
              defaultValue={addr}
              placeholder="0x…"
              className="mt-1 w-96 max-w-full rounded-md border border-white/10 bg-black/30 px-3 py-2 font-mono text-xs text-white"
            />
          </label>
          <button
            type="submit"
            className="rounded-md bg-white/10 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-white/20"
          >
            Apply
          </button>
        </form>
        {addr && (
          <div className="mt-4 rounded-md border border-white/10 bg-black/20 p-3 text-sm">
            {userError && <p className="text-amber-300">{userError}</p>}
            {!userError && !userRow && (
              <p className="text-zinc-400">
                <span className="font-mono text-cyan-300">{addr.slice(0, 10)}…{addr.slice(-4)}</span>{" "}
                is not on this week&apos;s leaderboard.
              </p>
            )}
            {userRow && (
              <p className="text-zinc-300">
                <span className="font-mono text-cyan-300">{userRow.user.slice(0, 10)}…{userRow.user.slice(-4)}</span>{" "}
                — rank{" "}
                <span className="font-semibold text-white">#{userRow.rank}</span>,{" "}
                score {userRow.score.toFixed(2)}, longest streak {userRow.longest_streak},{" "}
                {userRow.claimed ? "prize claimed" : "prize unclaimed"}
              </p>
            )}
          </div>
        )}
      </Card>

      <Card
        title={
          view === "country" && country
            ? `Rankings — ${country.toUpperCase()}`
            : "Rankings"
        }
        className="border-white/10"
      >
        <LeaderboardTable
          initialData={initialData}
          initialError={initialError}
          prizePoolId={prizePoolId}
          prizeAdminId={prizeAdminId}
          weeklyPrize={weeklyPrize}
          limit={limit}
          category={category}
        />
      </Card>
    </div>
  );
}
