/**
 * Gamification SQLite layer.
 *
 * Three tables back the off-chain streak / leaderboard / prize-claim surface:
 *   - daily_scores   (per user-day) — fed by `streak-sweeper` from on-chain
 *     `StreakUpdated`/`StreakBroken` events
 *   - weekly_archive (per user-week) — snapshot taken Monday 00:05 UTC by
 *     `leaderboard-worker`
 *   - prize_claims   (per user-week) — tracking the `claim_prize` PTB
 *     submitted by `prize-distributor`
 *
 * The leaderboard endpoint is computed live from these tables (no separate
 * `current_week` table — derived from `currentDayIndex()`).
 */
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, "../../data/gamification.db");

let db: Database.Database | null = null;

export interface DailyScore {
  user: string;
  day_index: number;
  participated: number; // 0/1
  all_correct: number; // 0/1
  streak_after: number;
  category: number; // 0=none, 1=AI news, 2=crypto price, 3=other
}

export interface WeeklyRow {
  user: string;
  week_index: number;
  score: number;
  rank: number;
  correct_days: number;
  longest_streak: number;
  category: number;
  claimed?: boolean;
}

export interface PrizeClaim {
  user: string;
  week_index: number;
  rank: number;
  amount: number;
  tx_digest: string | null;
  claimed_at_ms: number;
}

function getDb(): Database.Database {
  if (!db) {
    mkdirSync(dirname(DB_PATH), { recursive: true });
    db = new Database(DB_PATH);
    db.exec(`
      CREATE TABLE IF NOT EXISTS daily_scores (
        user TEXT NOT NULL,
        day_index INTEGER NOT NULL,
        participated INTEGER NOT NULL DEFAULT 0,
        all_correct INTEGER NOT NULL DEFAULT 0,
        streak_after INTEGER NOT NULL DEFAULT 0,
        category INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (user, day_index)
      );
      CREATE INDEX IF NOT EXISTS idx_daily_day ON daily_scores(day_index);

      CREATE TABLE IF NOT EXISTS weekly_archive (
        user TEXT NOT NULL,
        week_index INTEGER NOT NULL,
        score REAL NOT NULL DEFAULT 0,
        rank INTEGER NOT NULL DEFAULT 0,
        correct_days INTEGER NOT NULL DEFAULT 0,
        longest_streak INTEGER NOT NULL DEFAULT 0,
        category INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (user, week_index)
      );
      CREATE INDEX IF NOT EXISTS idx_weekly_week ON weekly_archive(week_index, score DESC);

      CREATE TABLE IF NOT EXISTS prize_claims (
        user TEXT NOT NULL,
        week_index INTEGER NOT NULL,
        rank INTEGER NOT NULL,
        amount INTEGER NOT NULL,
        tx_digest TEXT,
        claimed_at_ms INTEGER NOT NULL,
        PRIMARY KEY (user, week_index)
      );

      -- Per-day sweep lock. The streak-sweeper inserts a row when it
      -- starts and updates status='complete' on success. If a prior
      -- sweep is still 'running' (started within the last 24h) the
      -- next cron tick aborts so a slow per-user fallback doesn't
      -- race the next day's sweep.
      CREATE TABLE IF NOT EXISTS sweep_runs (
        day_index INTEGER PRIMARY KEY,
        status TEXT NOT NULL,
        started_at_ms INTEGER NOT NULL,
        finished_at_ms INTEGER
      );
    `);
  }
  return db;
}

export function recordDailyScore(score: DailyScore): void {
  getDb()
    .prepare(
      `INSERT INTO daily_scores
       (user, day_index, participated, all_correct, streak_after, category)
       VALUES (@user, @day_index, @participated, @all_correct, @streak_after, @category)
       ON CONFLICT(user, day_index) DO UPDATE SET
         participated=excluded.participated,
         all_correct=excluded.all_correct,
         streak_after=excluded.streak_after,
         category=excluded.category`,
    )
    .run({
      user: score.user,
      day_index: score.day_index,
      participated: score.participated,
      all_correct: score.all_correct,
      streak_after: score.streak_after,
      category: score.category,
    });
}

/**
 * Insert a `daily_scores` row only if the (user, day_index) key does
 * NOT already exist. Used by the streak-sweeper's idempotent path:
 * when a per-user `record_participation` returns `EAlreadyRecordedToday`,
 * the on-chain state was already written by a prior sweep (which used
 * a possibly-different outcome if the position indexer was lagging).
 * The on-chain state is the source of truth, so we must not clobber
 * the existing off-chain row with a fresher-but-disagreeing value.
 */
export function recordDailyScoreIfAbsent(score: DailyScore): boolean {
  const res = getDb()
    .prepare(
      `INSERT OR IGNORE INTO daily_scores
       (user, day_index, participated, all_correct, streak_after, category)
       VALUES (@user, @day_index, @participated, @all_correct, @streak_after, @category)`,
    )
    .run({
      user: score.user,
      day_index: score.day_index,
      participated: score.participated,
      all_correct: score.all_correct,
      streak_after: score.streak_after,
      category: score.category,
    });
  return res.changes > 0;
}

export function listDailyScoresForDay(dayIndex: number): DailyScore[] {
  return getDb()
    .prepare(`SELECT * FROM daily_scores WHERE day_index = ?`)
    .all(dayIndex) as DailyScore[];
}

export function listAllDailyScores(): DailyScore[] {
  return getDb()
    .prepare(`SELECT * FROM daily_scores ORDER BY day_index DESC`)
    .all() as DailyScore[];
}

export function clearDailyScoresBefore(dayIndex: number): number {
  const res = getDb()
    .prepare(`DELETE FROM daily_scores WHERE day_index < ?`)
    .run(dayIndex);
  return Number(res.changes ?? 0);
}

export function archiveWeekly(rows: WeeklyRow[]): void {
  const insert = getDb().prepare(
    `INSERT INTO weekly_archive
     (user, week_index, score, rank, correct_days, longest_streak, category)
     VALUES (@user, @week_index, @score, @rank, @correct_days, @longest_streak, @category)
     ON CONFLICT(user, week_index) DO UPDATE SET
       score=excluded.score, rank=excluded.rank, correct_days=excluded.correct_days,
       longest_streak=excluded.longest_streak, category=excluded.category`,
  );
  const tx = getDb().transaction((items: WeeklyRow[]) => {
    for (const r of items) insert.run(r);
  });
  tx(rows);
}

export function listWeeklyLeaderboard(
  weekIndex: number,
  limit = 100,
  category?: number,
): WeeklyRow[] {
  const baseSelect = `
    SELECT w.*, CASE WHEN c.user IS NULL THEN 0 ELSE 1 END AS claimed
    FROM weekly_archive w
    LEFT JOIN prize_claims c
      ON c.user = w.user AND c.week_index = w.week_index
    WHERE w.week_index = ?
  `;
  const rows =
    category != null && category > 0
      ? (getDb()
          .prepare(`${baseSelect} AND w.category = ? ORDER BY w.score DESC LIMIT ?`)
          .all(weekIndex, category, limit) as WeeklyRow[])
      : (getDb()
          .prepare(`${baseSelect} ORDER BY w.score DESC LIMIT ?`)
          .all(weekIndex, limit) as WeeklyRow[]);
  return rows.map(decorateClaimed);
}

export function getUserWeekRank(
  user: string,
  weekIndex: number,
): WeeklyRow | null {
  const row = getDb()
    .prepare(
      `SELECT w.*, CASE WHEN c.user IS NULL THEN 0 ELSE 1 END AS claimed
       FROM weekly_archive w
       LEFT JOIN prize_claims c
         ON c.user = w.user AND c.week_index = w.week_index
       WHERE w.user = ? AND w.week_index = ?`,
    )
    .get(user, weekIndex) as WeeklyRow | undefined;
  return row ? decorateClaimed(row) : null;
}

function decorateClaimed(row: WeeklyRow): WeeklyRow {
  row.claimed = Boolean((row as WeeklyRow & { claimed?: number }).claimed);
  return row;
}

export function recordPrizeClaim(claim: PrizeClaim): void {
  getDb()
    .prepare(
      `INSERT INTO prize_claims
       (user, week_index, rank, amount, tx_digest, claimed_at_ms)
       VALUES (@user, @week_index, @rank, @amount, @tx_digest, @claimed_at_ms)
       ON CONFLICT(user, week_index) DO UPDATE SET
         rank=excluded.rank, amount=excluded.amount,
         tx_digest=excluded.tx_digest, claimed_at_ms=excluded.claimed_at_ms`,
    )
    .run(claim);
}

export function listPrizeClaims(weekIndex?: number): PrizeClaim[] {
  if (weekIndex != null) {
    return getDb()
      .prepare(`SELECT * FROM prize_claims WHERE week_index = ?`)
      .all(weekIndex) as PrizeClaim[];
  }
  return getDb()
    .prepare(`SELECT * FROM prize_claims ORDER BY claimed_at_ms DESC`)
    .all() as PrizeClaim[];
}

/**
 * Set of user addresses that have a recorded `prize_claims` row for the
 * given `weekIndex`. Used by live rollups (which aggregate from
 * `daily_scores`, not the archive) to annotate `claimed` on each row
 * before the leaderboard REST endpoint returns them.
 */
export function claimedUsersForWeek(weekIndex: number): Set<string> {
  const rows = getDb()
    .prepare(`SELECT user FROM prize_claims WHERE week_index = ?`)
    .all(weekIndex) as { user: string }[];
  return new Set(rows.map((r) => r.user));
}

/** Returns the UTC day index for `tsMs`. */
export function dayIndexFor(tsMs: number): number {
  return Math.floor(tsMs / 86_400_000);
}

/** Returns the UTC week index (Monday 00:00 UTC = boundary) for `tsMs`. */
export function weekIndexFor(tsMs: number): number {
  return Math.floor(tsMs / (7 * 86_400_000));
}

/**
 * Returns the UTC week index for a UTC day index. Equivalent to
 * `weekIndexFor(dayIndex * 86_400_000)` but with explicit semantics so
 * callers don't have to remember that `DailyScore.day_index` is days,
 * not milliseconds.
 */
export function weekIndexForDay(dayIndex: number): number {
  return Math.floor(dayIndex / 7);
}

/** All distinct day_indices present in the daily_scores table (ascending). */
export function knownDayIndices(): number[] {
  return (
    getDb()
      .prepare(
        `SELECT DISTINCT day_index FROM daily_scores ORDER BY day_index ASC`,
      )
      .all() as { day_index: number }[]
  ).map((r) => r.day_index);
}

export interface SweepRun {
  day_index: number;
  status: "running" | "complete";
  started_at_ms: number;
  finished_at_ms: number | null;
}

export function getSweepRun(dayIndex: number): SweepRun | null {
  const row = getDb()
    .prepare(`SELECT * FROM sweep_runs WHERE day_index = ?`)
    .get(dayIndex) as SweepRun | undefined;
  return row ?? null;
}

/**
 * Try to claim the per-day sweep slot. Returns true if the caller now
 * holds the lock. A `running` row whose `started_at_ms` is within the
 * last `staleMs` window blocks a re-acquire; older `running` rows are
 * treated as crashed sweeps and the new caller takes over (UPDATE).
 *
 * `running` rows older than `staleMs` are recovered to the new caller
 * so a process that died mid-sweep doesn't permanently block the day.
 */
export function acquireSweepLock(
  dayIndex: number,
  staleMs = 24 * 60 * 60 * 1000,
): boolean {
  const now = Date.now();
  const existing = getSweepRun(dayIndex);
  if (existing?.status === "running" && now - existing.started_at_ms < staleMs) {
    return false;
  }
  if (existing) {
    getDb()
      .prepare(
        `UPDATE sweep_runs
         SET status='running', started_at_ms=?, finished_at_ms=NULL
         WHERE day_index=?`,
      )
      .run(now, dayIndex);
  } else {
    getDb()
      .prepare(
        `INSERT INTO sweep_runs (day_index, status, started_at_ms, finished_at_ms)
         VALUES (?, 'running', ?, NULL)`,
      )
      .run(dayIndex, now);
  }
  return true;
}

export function completeSweepRun(dayIndex: number): void {
  getDb()
    .prepare(
      `UPDATE sweep_runs
       SET status='complete', finished_at_ms=?
       WHERE day_index=?`,
    )
    .run(Date.now(), dayIndex);
}

export function releaseSweepLock(dayIndex: number): void {
  // Mark the in-flight sweep as complete (or remove it entirely if it
  // produced no rows — a noop sweep shouldn't lock the day). Using
  // DELETE keeps the table small.
  getDb()
    .prepare(`DELETE FROM sweep_runs WHERE day_index=? AND status='running'`)
    .run(dayIndex);
}
