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

// R53 audit fix: expose
// `closeDb()` so the SIGTERM
// handler in `index.ts` can
// drain the open SQLite handle
// (the better-sqlite3 `Database`
// holds an exclusive WAL writer
// lock + a `-wal`/`-shm` mmap;
// a restart under load can
// return `SQLITE_BUSY` on the
// first INSERT after the
// shutdown is initiated if the
// handle is dropped without
// `.close()`).
export function closeDb(): void {
  if (db) {
    try {
      db.close();
    } catch {
      // shutdown is best-effort
    }
    db = null;
  }
}

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
  /**
   * Optional country code, populated only on the live rollup path
   * (the `aggregateWeek()` worker output and the `weekly_archive`
   * rows both stay country-less — the archive snapshot is
   * independent of the profile mirror so an indexer lag doesn't
   * change historical rankings). The REST `/leaderboard/week` and
   * `/leaderboard/country` endpoints fill this in from
   * `getUserProfilesForUsers` after the rollup returns.
   */
  country_code?: string;
  claimed?: boolean;
}

export interface PrizeClaim {
  user: string;
  week_index: number;
  rank: number;
  amount: number;
  tx_digest: string | null;
  claimed_at_ms: number;
  // R33 audit fix: the on-chain `PrizeClaimed { pool_id, ... }` event
  // carries the pool the claim came from, but the off-chain mirror
  // silently dropped it. With a single PrizePool<PrizeCoin> per
  // deploy this was harmless (the PK `(user, week_index)` is unique
  // by construction), but the Move struct is generic and a future
  // second pool (e.g. a per-category prize pool) would silently
  // collapse two valid claims onto the same row via
  // `ON CONFLICT(user, week_index) DO UPDATE`. Surface the pool id
  // here and in the migration below.
  pool_id?: string | null;
}

function getDb(): Database.Database {
  if (!db) {
    mkdirSync(dirname(DB_PATH), { recursive: true });
    db = new Database(DB_PATH);
    // R48 audit fix: enable WAL, busy_timeout, and foreign_keys
    // on the gamification DB. The /prize/signature and
    // /prize/claims HTTP routes do concurrent reads against the
    // leaderboard/score tables while the indexer writes
    // PrizeClaimed events; without busy_timeout a transient
    // lock surfaces as a 500 to the client.
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 5000");
    db.pragma("foreign_keys = ON");
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
        pool_id TEXT,
        -- R41 audit fix: widen the PK to (pool_id, user, week_index)
        -- so a user claiming from two different prize pools in the
        -- same week no longer collapses onto a single row. The
        -- previous PK (user, week_index) silently overwrote the
        -- first claim's amount/rank/tx_digest with the second
        -- pool's via ON CONFLICT DO UPDATE. The R33 migration
        -- added pool_id as a column but never widened the PK.
        -- R40 audit flagged this and R41 confirmed it remained
        -- open. Fresh DBs get the new PK from this CREATE; pre-R41
        -- DBs are migrated via the rebuild below.
        PRIMARY KEY (pool_id, user, week_index)
      );
    `);
    // R33 migration: existing databases that pre-date the `pool_id`
    // column need it added. SQLite errors with "duplicate column"
    // if it's already there, so swallow that. The CREATE TABLE
    // above already declares the column for fresh databases; this
    // branch only runs once per pre-R33 database.
    try {
      getDb().exec(`ALTER TABLE prize_claims ADD COLUMN pool_id TEXT`);
    } catch {
      // Column already present; ignore.
    }
    // R41 migration: widen the prize_claims PK to
    // (pool_id, user, week_index). Pre-R41 DBs have the old
    // (user, week_index) PK. SQLite does not support altering
    // a PRIMARY KEY in place, so the only way is to rebuild
    // the table: copy into a new table, drop the old, rename.
    // Pre-R41 rows have a null `pool_id` (the R33 migration
    // only added the column with no default, but the
    // off-chain mirror always writes one when the on-chain
    // event is observed; rows without a pool_id predate the
    // multi-pool deploy entirely, so backfill with the empty
    // string sentinel). Conflict resolution in `recordPrizeClaim`
    // and `getPrizeClaim` is updated to match the new PK.
    try {
      const cols = getDb()
        .prepare("PRAGMA table_info(prize_claims)")
        .all() as Array<{ name: string; pk: number }>;
      const hasWidenedPK =
        cols.length > 0 &&
        cols.some((c) => c.pk > 0 && c.name === "pool_id");
      if (cols.length > 0 && !hasWidenedPK) {
        db.exec(
          [
            "CREATE TABLE IF NOT EXISTS prize_claims_new (",
            "  user TEXT NOT NULL,",
            "  week_index INTEGER NOT NULL,",
            "  rank INTEGER NOT NULL,",
            "  amount INTEGER NOT NULL,",
            "  tx_digest TEXT,",
            "  claimed_at_ms INTEGER NOT NULL,",
            "  pool_id TEXT,",
            "  PRIMARY KEY (pool_id, user, week_index)",
            ");",
            "INSERT OR IGNORE INTO prize_claims_new",
            "  (user, week_index, rank, amount, tx_digest,",
            "   claimed_at_ms, pool_id)",
            "  SELECT user, week_index, rank, amount, tx_digest,",
            "         claimed_at_ms,",
            "         COALESCE(NULLIF(pool_id, ''), '') AS pool_id",
            "    FROM prize_claims",
            "   GROUP BY user, week_index;",
            "DROP TABLE prize_claims;",
            "ALTER TABLE prize_claims_new RENAME TO prize_claims;",
            // Re-create the (pool_id, week_index) lookup index
            // that the leaderboard's claimed-annotation query
            // relies on (see claimedUsersForWeek).
            "CREATE INDEX IF NOT EXISTS idx_prize_claims_week",
            "  ON prize_claims(week_index);",
          ].join("\n"),
        );
      }
    } catch {
      // Fresh database; the CREATE TABLE above already declared
      // the widened PK. Nothing to migrate.
    }
    db.exec(`
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

      -- Streak event log. Populated by the position-indexer from the
      -- on-chain StreakUpdated / StreakBroken / MilestoneReached events
      -- (these are emitted by streak_system::record_participation and
      -- were unsubscribed before r15 — the streak page showed stale
      -- current_streak until the next indexer poll). Powers the
      -- activity feed in the streak UI and the milestones card.
      --
      -- R39 audit fix: the previous schema used a synthetic
      -- id INTEGER PRIMARY KEY AUTOINCREMENT column and a
      -- comment claiming INSERT OR IGNORE was idempotent on
      -- (user, kind, day_index). It was not — without a
      -- UNIQUE constraint on those three columns, INSERT OR
      -- IGNORE matched on the synthetic id, every re-poll
      -- produced a fresh row, and the streak activity feed
      -- accumulated duplicates. The PK is now the natural
      -- (user, kind, day_index) triple; see the migration
      -- block below for how pre-R39 databases are converted.
      CREATE TABLE IF NOT EXISTS streak_events (
        user TEXT NOT NULL,
        kind TEXT NOT NULL,            -- 'updated' | 'broken' | 'milestone'
        new_streak INTEGER,
        final_streak INTEGER,
        longest_streak INTEGER,
        multiplier_tier INTEGER,
        milestone INTEGER,             -- 1=3d, 2=7d, 3=14d, 4=30d, 5=100d
        day_index INTEGER NOT NULL,
        ts_ms INTEGER NOT NULL,
        PRIMARY KEY (user, kind, day_index)
      );
      CREATE INDEX IF NOT EXISTS idx_streak_events_user_ts
        ON streak_events(user, ts_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_streak_events_ts
        ON streak_events(ts_ms DESC);
      -- The actual migration logic that rebuilds the table with
      -- a natural PK lives OUTSIDE this template literal — see
      -- the try / catch block below that runs the
      -- ALTER/INSERT/SELECT/DROP/RENAME sequence for pre-R39
      -- databases. Putting it here would break the outer
      -- template parser.

      -- Per-pool weekly settlement state. Populated by the indexer
      -- from PoolSettled events. The leaderboard-worker uses
      -- settledWeeks to mark weeks as closed when computing the
      -- claimed annotation (a settled week is past-claim, so any
      -- unclaimed entry is "lost" the prize). Without this indexer
      -- path the leaderboard could keep offering claim txns for a
      -- week the on-chain pool has already marked settled.
      CREATE TABLE IF NOT EXISTS pool_weeks (
        pool_id TEXT NOT NULL,
        week_index INTEGER NOT NULL,
        settled INTEGER NOT NULL,      -- 0/1
        settled_at_ms INTEGER,
        PRIMARY KEY (pool_id, week_index)
      );

      -- User profiles — mirrored from on-chain user_profile events
      -- (ProfileCreated, CountryCodeSet, ForecasterKindSet).
      -- Used by the national leaderboard and the AI/bot
      -- forecaster sub-leaderboards. The country_code is the ISO-3166-1
      -- alpha-2 string the user typed (already lowercased client-side);
      -- empty string means the user has not set one (excluded from
      -- country-filtered leaderboards). forecaster_kind mirrors the
      -- on-chain u8 (0=human, 1=ai, 2=bot) so we can split the
      -- AI-forecaster category without re-deriving it from category.
      CREATE TABLE IF NOT EXISTS user_profiles (
        user TEXT PRIMARY KEY,
        country_code TEXT NOT NULL DEFAULT '',
        forecaster_kind INTEGER NOT NULL DEFAULT 0,
        updated_at_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_user_profiles_country
        ON user_profiles(country_code) WHERE country_code != '';

      -- Parlays - mirrored from on-chain parlay events. The
      -- position-indexer polls ParlayCreated / ParlayLegRecorded /
      -- ParlayFinalized and writes here so the web /parlay page
      -- can show the live leg-recording progress without a per-poll
      -- RPC read. The admin worker (parlay-worker) uses this table
      -- to know which parlays still need record_leg calls and
      -- which are ready for finalize_parlay.
      --
      -- legs_recorded and legs_lost advance with the
      -- ParlayLegRecorded events; finalized flips on
      -- ParlayFinalized. The pool_id column is included so a future
      -- cross-pool rollup can sum volume / payouts per pool.
      CREATE TABLE IF NOT EXISTS parlays (
        parlay_id TEXT PRIMARY KEY,
        pool_id TEXT NOT NULL,
        user TEXT NOT NULL,
        collateral_amount INTEGER NOT NULL,
        leg_count INTEGER NOT NULL,
        payout_bps INTEGER NOT NULL,
        legs_recorded INTEGER NOT NULL DEFAULT 0,
        legs_lost INTEGER NOT NULL DEFAULT 0,
        finalized INTEGER NOT NULL DEFAULT 0,
        won INTEGER,                    -- nullable until finalized
        payout INTEGER,                 -- nullable until finalized
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_parlays_user
        ON parlays(user);
      CREATE INDEX IF NOT EXISTS idx_parlays_pool
        ON parlays(pool_id);
      CREATE INDEX IF NOT EXISTS idx_parlays_unfinalized
        ON parlays(finalized) WHERE finalized = 0;

      -- Per-leg idempotency log. Populated by recordParlayLeg as
      -- the FIRST step; the UPDATE on the parent 'parlays' row only
      -- runs if this insert actually wrote a row. This makes the
      -- parlay-worker safe against cursor re-polls (e.g. after a
      -- restart) and against overlapping polls from multiple agent
      -- instances. The round-21 audit caught that the old code
      -- used 'legs_lost = legs_lost + ...', which inflated
      -- 'legs_lost' and would have made the web's ParlayHistory
      -- show the wrong 'won'/'lost' verdict.
      CREATE TABLE IF NOT EXISTS parlay_legs (
        parlay_id TEXT NOT NULL,
        leg_index INTEGER NOT NULL,
        market_id TEXT NOT NULL DEFAULT "",
        won INTEGER NOT NULL,
        ts_ms INTEGER NOT NULL,
        PRIMARY KEY (parlay_id, leg_index)
      );
    `);
    // R37 migration: pre-R37 parlay_legs rows don't have a
    // market_id column. SQLite errors with "duplicate column"
    // when it's already present, so swallow that. Fresh databases
    // get the column from the CREATE TABLE above.
    try {
      getDb().exec(
        `ALTER TABLE parlay_legs ADD COLUMN market_id TEXT NOT NULL DEFAULT ''`,
      );
    } catch {
      // Column already present; ignore.
    }
    // R39 migration: pre-R39 databases have a synthetic
    // id INTEGER PRIMARY KEY AUTOINCREMENT on
    // streak_events instead of the natural PK on
    // (user, kind, day_index). SQLite does not support
    // adding a PRIMARY KEY to an existing table, so the
    // only way to add the constraint is to rebuild the
    // table: copy distinct rows (deduplicating along the
    // way) into a new table, drop the old one, rename.
    // The dedup keeps the earliest row per
    // (user, kind, day_index) via MIN(ts_ms). Without
    // this migration the INSERT OR IGNORE in
    // recordStreakEvent is a no-op (matches on the
    // synthetic id) and every re-poll produces a
    // duplicate row.
    try {
      const cols = getDb()
        .prepare("PRAGMA table_info(streak_events)")
        .all() as Array<{ name: string; pk: number }>;
      const hasNaturalPK =
        cols.length > 0 &&
        cols.some(
          (c) =>
            c.pk > 0 &&
            ["user", "kind", "day_index"].includes(c.name),
        );
      if (cols.length > 0 && !hasNaturalPK) {
        db.exec(
          [
            "CREATE TABLE IF NOT EXISTS streak_events_new (",
            "  user TEXT NOT NULL,",
            "  kind TEXT NOT NULL,",
            "  new_streak INTEGER,",
            "  final_streak INTEGER,",
            "  longest_streak INTEGER,",
            "  multiplier_tier INTEGER,",
            "  milestone INTEGER,",
            "  day_index INTEGER NOT NULL,",
            "  ts_ms INTEGER NOT NULL,",
            "  PRIMARY KEY (user, kind, day_index)",
            ");",
            "INSERT OR IGNORE INTO streak_events_new",
            "  (user, kind, new_streak, final_streak, longest_streak,",
            "   multiplier_tier, milestone, day_index, ts_ms)",
            "  SELECT user, kind, new_streak, final_streak, longest_streak,",
            "         multiplier_tier, milestone, day_index, MIN(ts_ms)",
            "    FROM streak_events",
            "   GROUP BY user, kind, day_index;",
            "DROP TABLE streak_events;",
            "ALTER TABLE streak_events_new RENAME TO streak_events;",
            "CREATE INDEX IF NOT EXISTS idx_streak_events_user_ts",
            "  ON streak_events(user, ts_ms DESC);",
            "CREATE INDEX IF NOT EXISTS idx_streak_events_ts",
            "  ON streak_events(ts_ms DESC);",
          ].join("\n"),
        );
      }
    } catch {
      // Fresh database; the CREATE TABLE above already
      // declared the natural PK. Nothing to migrate.
    }
    db.exec(`

      -- StreakBadge mints - mirrored from badge_nft::BadgeMinted
      -- events. Powers the badge collection view on the streak
      -- page (showing the user which tiers they own) and the
      -- future airdrop eligibility rollups. badge_id is the
      -- primary key; the indexer is idempotent on re-poll because
      -- of the INSERT OR IGNORE.
      CREATE TABLE IF NOT EXISTS streak_badges (
        badge_id TEXT PRIMARY KEY,
        user TEXT NOT NULL,
        tier INTEGER NOT NULL,
        longest_streak_at_mint INTEGER NOT NULL,
        minted_at_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_streak_badges_user
        ON streak_badges(user);
      CREATE INDEX IF NOT EXISTS idx_streak_badges_tier
        ON streak_badges(tier);
    `);
  }
  return db;
}

/**
 * Append a row to `streak_events`. Idempotent on the natural
 * PRIMARY KEY `(user, kind, day_index)` via `INSERT OR IGNORE`
 * so a re-poll of the same Move event doesn't double-write.
 * `kind` is one of `'updated' | 'broken' | 'milestone'`.
 *
 * R39 audit fix: the previous comment claimed this was
 * idempotent but the table used a synthetic `id INTEGER
 * PRIMARY KEY AUTOINCREMENT`, so `INSERT OR IGNORE` matched
 * on `id` and every re-poll produced a duplicate row. The
 * PK is now the natural triple (see the schema and migration
 * above).
 */
export function recordStreakEvent(ev: {
  user: string;
  kind: "updated" | "broken" | "milestone";
  new_streak?: number;
  final_streak?: number;
  longest_streak?: number;
  multiplier_tier?: number;
  milestone?: number;
  day_index: number;
  ts_ms: number;
}): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO streak_events
         (user, kind, new_streak, final_streak, longest_streak,
          multiplier_tier, milestone, day_index, ts_ms)
       VALUES
         (@user, @kind, @new_streak, @final_streak, @longest_streak,
          @multiplier_tier, @milestone, @day_index, @ts_ms)`,
    )
    .run({
      user: ev.user,
      kind: ev.kind,
      new_streak: ev.new_streak ?? null,
      final_streak: ev.final_streak ?? null,
      longest_streak: ev.longest_streak ?? null,
      multiplier_tier: ev.multiplier_tier ?? null,
      milestone: ev.milestone ?? null,
      day_index: ev.day_index,
      ts_ms: ev.ts_ms,
    });
}

export interface StreakEvent {
  id: number;
  user: string;
  kind: "updated" | "broken" | "milestone";
  new_streak: number | null;
  final_streak: number | null;
  longest_streak: number | null;
  multiplier_tier: number | null;
  milestone: number | null;
  day_index: number;
  ts_ms: number;
}

/** Recent streak events for the activity feed, newest first. */
export function listStreakEvents(
  user?: string,
  limit: number = 50,
): StreakEvent[] {
  const db = getDb();
  if (user) {
    return db
      .prepare(
        `SELECT * FROM streak_events WHERE user = ? ORDER BY ts_ms DESC LIMIT ?`,
      )
      .all(user, limit) as StreakEvent[];
  }
  return db
    .prepare(
      `SELECT * FROM streak_events ORDER BY ts_ms DESC LIMIT ?`,
    )
    .all(limit) as StreakEvent[];
}

/** Mark a (pool, week) as settled. Idempotent. */
export function markPoolWeekSettled(
  poolId: string,
  weekIndex: number,
  tsMs: number,
): void {
  getDb()
    .prepare(
      `INSERT INTO pool_weeks (pool_id, week_index, settled, settled_at_ms)
       VALUES (?, ?, 1, ?)
       ON CONFLICT(pool_id, week_index) DO UPDATE SET
         settled=1, settled_at_ms=excluded.settled_at_ms`,
    )
    .run(poolId, weekIndex, tsMs);
}

/** True if a (pool, week) has been observed as settled on-chain. */
export function isPoolWeekSettled(
  poolId: string,
  weekIndex: number,
): boolean {
  const row = getDb()
    .prepare(
      `SELECT settled FROM pool_weeks WHERE pool_id = ? AND week_index = ?`,
    )
    .get(poolId, weekIndex) as { settled: number } | undefined;
  return row?.settled === 1;
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
  // R52 audit fix: bound the result set.
  // The previous un-bounded
  // `SELECT *` returned every row in
  // the table — on a 1-year mainnet
  // deploy with 4 daily markets × 1k
  // active users × 365 days =
  // 1.46M rows, the
  // `leaderboard-worker` OOMed the
  // heap (or stalled for 30s+)
  // iterating them all into a Map,
  // and the `liveRollup` route did
  // the same on every `/parlay` page
  // load. Cap at 10k rows — the
  // leaderboard is a 7-day rolling
  // window, and even a busy 7 days
  // × 1k users × 4 markets = 28k
  // rows, so 10k is a generous
  // headroom for the typical case
  // while preventing OOM in the
  // tail. The full historical set
  // is archived weekly into
  // `weekly_archive` (R49) so a
  // higher bound would just hit
  // the cap without loss.
  return getDb()
    .prepare(
      `SELECT * FROM daily_scores ORDER BY day_index DESC LIMIT 10000`,
    )
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
  category: number = 0,
): WeeklyRow | null {
  // `category = 0` keeps the call site backwards-compatible with
  // callers that haven't been updated yet (the round-17 audit found
  // the leaderboard category filter on the web side was ignored on
  // the per-user lookup). 0 = "general" — the catch-all bucket.
  const row = getDb()
    .prepare(
      `SELECT w.*, CASE WHEN c.user IS NULL THEN 0 ELSE 1 END AS claimed
       FROM weekly_archive w
       LEFT JOIN prize_claims c
         ON c.user = w.user AND c.week_index = w.week_index
       WHERE w.user = ? AND w.week_index = ? AND w.category = ?`,
    )
    .get(user, weekIndex, category) as WeeklyRow | undefined;
  return row ? decorateClaimed(row) : null;
}

function decorateClaimed(row: WeeklyRow): WeeklyRow {
  row.claimed = Boolean((row as WeeklyRow & { claimed?: number }).claimed);
  return row;
}

export function recordPrizeClaim(claim: PrizeClaim): void {
  // R33 audit fix: include `pool_id` in the INSERT / ON CONFLICT
  // UPDATE so the off-chain mirror preserves the on-chain source
  // pool.
  //
  // R41 audit fix: the conflict target must match the new
  // PRIMARY KEY (pool_id, user, week_index). Previously the
  // PK was (user, week_index) and the on-conflict clause
  // silently collapsed two valid claims from the same user
  // against different pools onto a single row, overwriting
  // the first claim's amount/rank/tx_digest with the second.
  // With the widened PK, two claims from the same user
  // against different pools in the same week produce two
  // distinct rows. See the CREATE TABLE / R41 migration
  // above for the schema.
  //
  // R44 audit fix: wrap the INSERT (or UPDATE) in a
  // `db.transaction` so the read-then-write inside
  // `getPrizeClaim` and the write here are atomic. The
  // previous straight `.run()` had a window where two
  // concurrent claim attempts (e.g. the web's
  // `POST /prize/claims` racing the position-indexer's
  // `PrizeClaimed` event poll) could both pass the
  // idempotency check in `routes.ts` and then *both*
  // write a row — producing two `prize_claims` rows for
  // the same (pool, user, week), with the second silently
  // overwriting the first's amount/rank via the ON
  // CONFLICT clause. better-sqlite3's `transaction()` is
  // synchronous and wraps BEGIN/COMMIT/ROLLBACK around
  // the callable; we don't need a separate `BEGIN` in
  // user code.
  const db = getDb();
  const tx = db.transaction((c: PrizeClaim) => {
    db.prepare(
      `INSERT INTO prize_claims
       (user, week_index, rank, amount, tx_digest, claimed_at_ms, pool_id)
       VALUES (@user, @week_index, @rank, @amount, @tx_digest, @claimed_at_ms, @pool_id)
       ON CONFLICT(pool_id, user, week_index) DO UPDATE SET
         rank=excluded.rank, amount=excluded.amount,
         tx_digest=excluded.tx_digest, claimed_at_ms=excluded.claimed_at_ms,
         pool_id=COALESCE(excluded.pool_id, prize_claims.pool_id)`,
    ).run(c);
  });
  tx(claim);
}

/**
 * Look up a single claim by (pool, user, week). Returns null if no
 * claim row exists. Used by the `POST /prize/claims` idempotency
 * check (and by future event-indexer backstops to confirm the row
 * landed).
 *
 * R41 audit fix: the previous signature took (user, week) only,
 * which is non-unique under the widened PK. A caller without
 * `poolId` would have to disambiguate by hand. Default `poolId`
 * to the empty string so the call stays backwards-compatible
 * (pre-R41 rows with no `pool_id` are looked up under the
 * empty-string sentinel — see the R41 migration above). New
 * callers should pass the explicit `poolId` from the on-chain
 * event payload.
 */
export function getPrizeClaim(
  user: string,
  weekIndex: number,
  poolId: string = "",
): PrizeClaim | null {
  const row = getDb()
    .prepare(
      `SELECT * FROM prize_claims
        WHERE pool_id IS ? AND user = ? AND week_index = ?`,
    )
    .get(poolId, user, weekIndex) as PrizeClaim | undefined;
  return row ?? null;
}

/**
 * R50 audit fix: cap the row count to prevent
 * unbounded growth in the operator-dashboard view.
 * The week 0 archive (the first rolled-up week) can
 * accumulate thousands of rows over months; the
 * previous version returned every row in a single
 * response. 500 mirrors the `/leaderboard/week`
 * cap. The `?week=N` path returns at most 500
 * rows; the unfiltered path returns at most 500
 * (most-recent-first).
 */
const PRIZE_CLAIMS_LIMIT = 500;

export function listPrizeClaims(weekIndex?: number): PrizeClaim[] {
  if (weekIndex != null) {
    return getDb()
      .prepare(
        `SELECT * FROM prize_claims WHERE week_index = ? ` +
          `ORDER BY claimed_at_ms DESC LIMIT ?`,
      )
      .all(weekIndex, PRIZE_CLAIMS_LIMIT) as PrizeClaim[];
  }
  return getDb()
    .prepare(
      `SELECT * FROM prize_claims ORDER BY claimed_at_ms DESC LIMIT ?`,
    )
    .all(PRIZE_CLAIMS_LIMIT) as PrizeClaim[];
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
 *
 * R50 audit fix: was a non-atomic read-then-write. Two
 * concurrent processes (e.g. two agents instances, or a
 * process restart during `getSweepRun`) both saw
 * `existing = null`, both issued `INSERT`, and the second
 * raised a `SQLITE_CONSTRAINT` that escaped to the
 * caller. Wrap the read+write in `db.transaction()` with
 * `INSERT ... ON CONFLICT(day_index) DO UPDATE` so the
 * PK constraint is the single source of truth — the loser
 * of the race becomes a `UPDATE` that re-claims the slot
 * if and only if the previous row's `started_at_ms` is
 * stale. The `RETURNING` clause gives us the post-write
 * row so we can return the canonical "is this caller the
 * owner" bit without a second roundtrip.
 */
export function acquireSweepLock(
  // R50 audit fix (Low #22): 24h was too coarse.
  // A SIGKILL before `releaseSweepLock`'s
  // `finally` could keep the slot blocked for a
  // full day before another sweep takes over. 6h
  // is a safer window — a sweep that takes > 6h
  // is by definition hung, and the recovery
  // path (`ON CONFLICT DO UPDATE`) gives the
  // next caller the slot without manual
  // intervention.
  dayIndex: number,
  staleMs = 6 * 60 * 60 * 1000,
): boolean {
  const now = Date.now();
  return getDb()
    .transaction(() => {
      const existing = getSweepRun(dayIndex);
      if (
        existing?.status === "running" &&
        now - existing.started_at_ms < staleMs
      ) {
        return false;
      }
      // Use ON CONFLICT so a concurrent INSERT that lost
      // the race becomes a deterministic UPDATE. The
      // UPDATE's `WHERE day_index=?` is the PK guard.
      getDb()
        .prepare(
          `INSERT INTO sweep_runs (day_index, status, started_at_ms, finished_at_ms)
           VALUES (?, 'running', ?, NULL)
           ON CONFLICT(day_index) DO UPDATE SET
             status='running',
             started_at_ms=excluded.started_at_ms,
             finished_at_ms=NULL`,
        )
        .run(dayIndex, now);
      return true;
    })
    .immediate();
}

// R39 audit fix: `completeSweepRun` was a no-op-on-disk dead
// export — imported in streak-sweeper.ts:40 (per the audit) but
// never called; the sweeper's `finally` block uses
// `releaseSweepLock` (which DELETEs the row) on both success
// and failure paths. Removing this function is safe and avoids
// confusing future readers who might wire it up and create a
// double-bookkeeping race with `acquireSweepLock`'s recovery
// logic (which treats a `status='complete'` row older than
// `staleMs` as "needs recovery" — the exact opposite of its
// apparent meaning).

export function releaseSweepLock(dayIndex: number): void {
  // Mark the in-flight sweep as complete (or remove it entirely if it
  // produced no rows — a noop sweep shouldn't lock the day). Using
  // DELETE keeps the table small.
  getDb()
    .prepare(`DELETE FROM sweep_runs WHERE day_index=? AND status='running'`)
    .run(dayIndex);
}

// ============================================================
// user_profiles — national & AI-forecaster leaderboards
// ============================================================

export interface UserProfile {
  user: string;
  country_code: string;
  forecaster_kind: number; // 0=human, 1=ai, 2=bot
  updated_at_ms: number;
}

/**
 * Upsert a user profile row. Called from the position-indexer's
 * `ProfileCreated` / `CountryCodeSet` / `ForecasterKindSet` handlers.
 * `country_code` and `forecaster_kind` are taken verbatim from the
 * event payload — the on-chain module is the source of truth, so the
 * off-chain mirror should never try to normalize or validate.
 */
export function upsertUserProfile(profile: {
  user: string;
  country_code?: string;
  forecaster_kind?: number;
  updated_at_ms: number;
}): void {
  const existing = getUserProfile(profile.user);
  const next: UserProfile = {
    user: profile.user,
    country_code: profile.country_code ?? existing?.country_code ?? "",
    forecaster_kind: profile.forecaster_kind ?? existing?.forecaster_kind ?? 0,
    updated_at_ms: profile.updated_at_ms,
  };
  getDb()
    .prepare(
      `INSERT INTO user_profiles (user, country_code, forecaster_kind, updated_at_ms)
       VALUES (@user, @country_code, @forecaster_kind, @updated_at_ms)
       ON CONFLICT(user) DO UPDATE SET
         country_code=excluded.country_code,
         forecaster_kind=excluded.forecaster_kind,
         updated_at_ms=excluded.updated_at_ms`,
    )
    .run(next);
}

export function getUserProfile(user: string): UserProfile | null {
  const row = getDb()
    .prepare(`SELECT * FROM user_profiles WHERE user = ?`)
    .get(user) as UserProfile | undefined;
  return row ?? null;
}

/**
 * Bulk lookup for a leaderboard rollup. Returns a `Map<user, profile>`
 * containing only users that have a row (no entry means the user has
 * no profile and is excluded from country/forecaster-kind filters).
 * Uses a single `WHERE user IN (...)` round-trip — the per-row
 * `getUserProfile` would issue N+1 queries.
 */
export function getUserProfilesForUsers(users: string[]): Map<string, UserProfile> {
  const out = new Map<string, UserProfile>();
  if (users.length === 0) return out;
  // better-sqlite3 caps `IN (?, ?, ...)` at 999 placeholders; chunk
  // defensively in case a leaderboard grows past that.
  const CHUNK = 500;
  for (let i = 0; i < users.length; i += CHUNK) {
    const slice = users.slice(i, i + CHUNK);
    const placeholders = slice.map(() => "?").join(",");
    const rows = getDb()
      .prepare(
        `SELECT * FROM user_profiles WHERE user IN (${placeholders})`,
      )
      .all(...slice) as UserProfile[];
    for (const r of rows) out.set(r.user, r);
  }
  return out;
}

// ============================================================
// parlays — multi-leg parlay bets
// ============================================================

export interface ParlayRow {
  parlay_id: string;
  pool_id: string;
  user: string;
  collateral_amount: number;
  leg_count: number;
  payout_bps: number;
  legs_recorded: number;
  legs_lost: number;
  finalized: number; // 0/1
  won: number | null;
  payout: number | null;
  created_at_ms: number;
  updated_at_ms: number;
}

/**
 * Insert or replace a parlay from the `ParlayCreated` event. The
 * full row is written at create time; later `ParlayLegRecorded` /
 * `ParlayFinalized` events update the progress columns.
 */
export function upsertParlayCreated(p: {
  parlay_id: string;
  pool_id: string;
  user: string;
  collateral_amount: number;
  leg_count: number;
  payout_bps: number;
  created_at_ms: number;
}): void {
  getDb()
    .prepare(
      `INSERT INTO parlays
         (parlay_id, pool_id, user, collateral_amount, leg_count,
          payout_bps, legs_recorded, legs_lost, finalized, won, payout,
          created_at_ms, updated_at_ms)
       VALUES
         (@parlay_id, @pool_id, @user, @collateral_amount, @leg_count,
          @payout_bps, 0, 0, 0, NULL, NULL,
          @created_at_ms, @created_at_ms)
       ON CONFLICT(parlay_id) DO UPDATE SET
         pool_id=excluded.pool_id,
         user=excluded.user,
         collateral_amount=excluded.collateral_amount,
         leg_count=excluded.leg_count,
         payout_bps=excluded.payout_bps,
         updated_at_ms=excluded.updated_at_ms`,
    )
    .run(p);
}

/**
 * Advance `legs_recorded` / `legs_lost` from a `ParlayLegRecorded`
 * event. Idempotent on `(parlay_id, leg_index)` via the `parlay_legs`
 * sidecar table — the `INSERT OR IGNORE` returns 0 changes on a
 * re-poll, and we only then skip the `legs_lost` increment.
 *
 * R39 audit fix: the previous SQL did an absolute assignment
 * `legs_recorded = @leg_index + 1`, which was vulnerable to
 * out-of-order delivery in the under-count direction. If leg
 * 2 arrived before leg 0, the first UPDATE set the count to
 * 3 and the second set it to 1 — a "regression" the
 * parlay-worker treats as "more legs still pending", deferring
 * finalization until the next poll. The new SQL uses
 * `MAX(legs_recorded, @leg_index + 1)` so the count can only
 * monotonically increase. The `legs_lost` increment remains
 * safe because the `INSERT OR IGNORE` above guarantees we
 * only enter the UPDATE for a newly-seen leg.
 */
export function recordParlayLeg(p: {
  parlay_id: string;
  leg_index: number;
  market_id?: string;
  won: boolean;
  ts_ms: number;
}): void {
  const won = p.won ? 1 : 0;
  // R37 audit fix: the on-chain `ParlayLegRecorded` event carries
  // `market_id`; persist it on the leg row. The parlay-worker no
  // longer needs a per-parlay `getObject` RPC call to recover the
  // leg→market mapping — it can read the mirror instead.
  const market_id = p.market_id ?? "";
  // R43 audit fix: wrap the INSERT + UPDATE in a single
  // `db.transaction` so the parlay-leg mirror and the
  // `parlays.legs_recorded` cursor advance atomically. The
  // previous two-statement path was vulnerable to a
  // crash-between-statements scenario (SIGTERM, OOM, machine
  // reboot): a process that wrote the new `parlay_legs` row
  // but not the `UPDATE parlays` left the cursor under-counted,
  // so the parlay-worker's `legs_recorded >= leg_count` gate
  // re-emitted a finalize PTB the on-chain contract then
  // aborted. Wrapping in `getDb().transaction()` makes the two
  // writes atomic in SQLite (better-sqlite3's transactions
  // are synchronous and commit/rollback as a single unit).
  const db = getDb();
  const tx = db.transaction(() => {
    const insert = db
      .prepare(
        `INSERT OR IGNORE INTO parlay_legs
           (parlay_id, leg_index, market_id, won, ts_ms)
         VALUES
           (@parlay_id, @leg_index, @market_id, @won, @ts_ms)`,
      )
      .run({
        parlay_id: p.parlay_id,
        leg_index: p.leg_index,
        market_id,
        won,
        ts_ms: p.ts_ms,
      });
    if (insert.changes === 0) return; // re-poll, already recorded
    db.prepare(
      `UPDATE parlays
         SET legs_recorded = MAX(legs_recorded, @leg_index + 1),
             legs_lost     = legs_lost + CASE WHEN @won = 0 THEN 1 ELSE 0 END,
             updated_at_ms = @ts_ms
       WHERE parlay_id = @parlay_id`,
    ).run({
      parlay_id: p.parlay_id,
      leg_index: p.leg_index,
      won,
      ts_ms: p.ts_ms,
    });
  });
  tx();
}

/**
 * Mark a parlay as finalized. `won` and `payout` come straight from
 * the `ParlayFinalized` event. `won` is normalized to 0|1 at the
 * entry boundary so a future caller that forgets the boolean→int
 * coercion can't accidentally store a truthy non-1 value (e.g.
 * `won: true` if the SQL were ever changed to bind booleans
 * directly).
 *
 * R44 audit fix: make `won` and `payout` monotonic so a re-poll
 * of the same `ParlayFinalized` event (or, worse, a stale event
 * replayed from an earlier checkpoint) cannot regress the row.
 * The previous UPDATE was unconditional — any later write with
 * `won=false` would clobber an earlier `won=true`, and any later
 * write with a smaller `payout` would clobber a larger one. The
 * parlay-worker relied on `payout > 0` to mean "claimable", and
 * the web's ParlayHistory read `won` to render the verdict
 * badge. A regression here would either hide a winnable parlay
 * (UX) or over-pay a losing one (capital). Gate the writes
 * behind `payout >= parlays.payout` (NULL treated as 0) and only
 * flip `won` from NULL/0 → 1; never 1 → 0. Updated_at_ms is
 * always advanced so the indexer poll's `WHERE finalized=0
 * ORDER BY updated_at_ms ASC` no longer returns this row.
 */
export function recordParlayFinalized(p: {
  parlay_id: string;
  pool_id?: string;
  user?: string;
  won: boolean;
  payout: number;
  legs_lost: number;
  ts_ms: number;
}): void {
  const won = p.won ? 1 : 0;
  // R36 audit fix: the on-chain `parlay::ParlayFinalized` event
  // carries `pool_id`, `user`, and `legs_lost` in addition to
  // `parlay_id`/`won`/`payout`. The off-chain indexer previously
  // only persisted the latter three, so:
  //   - `pool_id` and `user` stayed null on the row (they were set
  //     at ParlayCreated time and never overwritten, but if a
  //     pre-existing row lacked them they would stay blank),
  //   - `legs_lost` was never updated, so the web's ParlayHistory
  //     and the per-user rollup both showed `0` even on parlays
  //     that lost a leg.
  // Persist all three on finalize. COALESCE keeps any pre-existing
  // value (ParlayCreated normally wrote it) — the indexer is the
  // source of truth but the upsert-on-create path is a backstop.
  //
  // R44 audit fix: monotonic guards on `won` and `payout`. The
  // parlay-worker trusts `won=1` and `payout>0` to decide when a
  // user can claim, so a regression is load-bearing. Treat the
  // existing row as authoritative once finalized — the
  // `WHERE finalized = 0` clause in the UPDATE means a re-poll
  // of an already-finalized row is a no-op, and a first-time
  // finalize uses the new event's values.
  //
  // R47 audit fix: the prior SQL's
  // `won = COALESCE(won, @won)` only handled the
  // NULL case, despite the comment above
  // claiming a `won = NULL/0 → 1; never 1 → 0`
  // guarantee. If a process restart replayed
  // an older `ParlayFinalized{won=false}` event
  // after a newer `ParlayFinalized{won=true}`
  // had been written (the cursor reset to
  // checkpoint after the second event was
  // already applied), the COALESCE would
  // silently clobber the winning row with a
  // losing one. Strengthen the WHERE clause
  // to refuse a re-finalize when the new
  // event's outcome is worse than what's
  // already on disk.
  getDb()
    .prepare(
      `UPDATE parlays
         SET finalized = 1,
             won = CASE WHEN won = 1 THEN 1 ELSE @won END,
             payout = CASE
               WHEN payout IS NULL THEN @payout
               WHEN @payout > payout THEN @payout
               ELSE payout
             END,
             legs_lost = @legs_lost,
             pool_id = COALESCE(NULLIF(@pool_id, ''), pool_id),
             user = COALESCE(NULLIF(@user, ''), user),
             updated_at_ms = @ts_ms
       WHERE parlay_id = @parlay_id
         AND finalized = 0`,
    )
    .run({
      parlay_id: p.parlay_id,
      pool_id: p.pool_id ?? "",
      user: p.user ?? "",
      won,
      payout: p.payout,
      legs_lost: p.legs_lost,
      ts_ms: p.ts_ms,
    });
}

/**
 * Read the mirror for a single parlay. Returns null if the
 * `ParlayCreated` event hasn't been indexed yet.
 */
export function getParlay(parlayId: string): ParlayRow | null {
  const row = getDb()
    .prepare(`SELECT * FROM parlays WHERE parlay_id = ?`)
    .get(parlayId) as ParlayRow | undefined;
  return row ?? null;
}

/**
 * List every unfinalized parlay across all users. Used by the
 * parlay-worker to enumerate work without N+1 user lookups. The
 * `idx_parlays_unfinalized` partial index keeps this O(N over
 * unfinalized) — at typical parlay volume this is <100 rows.
 *
 * `leg_count` is also used as the second key in the indexer
 * (parlay.legs[].status flips are not in the off-chain mirror;
 * the on-chain `record_leg` PTB is the only authority).
 */
export function listUnfinalizedParlays(): ParlayRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM parlays
        WHERE finalized = 0
        ORDER BY updated_at_ms ASC`,
    )
    .all() as ParlayRow[];
}

/**
 * List a single user's unfinalized parlays — the active-parlays
 * view for the /parlay page's per-user list. R46 audit fix:
 * the previous route handler at routes.ts:676 called the
 * global `listUnfinalizedParlays()` and then `.filter((p) =>
 * p.user === addr)` in JS, which is O(N over all unfinalized
 * parlays in the system). At a busy market time (an AI
 * category settles, hundreds of parlays finalize, the
 * system briefly holds several thousand unfinalized rows
 * before the worker drains them) the /parlay/user/:addr
 * endpoint did an N×M scan per request, and the /parlay
 * page polls every 5s. Use a SQL-side WHERE on `user` to
 * keep this O(N over the user's parlays); the
 * `idx_parlays_user` index covers the lookup.
 */
export function listUnfinalizedParlaysForUser(
  user: string,
  limit = 200,
): ParlayRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM parlays
        WHERE user = ? AND finalized = 0
        ORDER BY created_at_ms DESC
        LIMIT ?`,
    )
    .all(user, limit) as ParlayRow[];
}

/**
 * Read the per-leg `market_id` mapping for a parlay from the
 * off-chain `parlay_legs` mirror. The on-chain `ParlayLegRecorded`
 * event carries the market id; the position-indexer (R37) persists
 * it on insert so the parlay-worker doesn't need a per-parlay
 * `getObject` RPC call.
 *
 * Returns `null` if the mirror has no rows for this parlay yet
 * (ParlayCreated was indexed but no legs have been recorded —
 * typical for a freshly-created parlay that hasn't been seen by
 * the resolver). Returns an array of length `leg_count` once the
 * indexer has caught up.
 */
export function getParlayLegMarketIds(
  parlayId: string,
  legCount: number,
): string[] | null {
  const rows = getDb()
    .prepare(
      `SELECT leg_index, market_id FROM parlay_legs
        WHERE parlay_id = ?
        ORDER BY leg_index ASC`,
    )
    .all(parlayId) as Array<{ leg_index: number; market_id: string }>;
  if (rows.length === 0) return null;
  const out: string[] = new Array(legCount).fill("");
  for (const r of rows) {
    if (r.leg_index >= 0 && r.leg_index < legCount) {
      out[r.leg_index] = r.market_id;
    }
  }
  return out;
}

/**
 * List a single user's parlays, newest first. Backs the
 * `GET /parlay/user/:addr` REST endpoint. The `idx_parlays_user`
 * index keeps this O(N over the user's parlays); at typical
 * volume (a handful per active user) the full result set fits in
 * one page. The caller applies any `limit` slicing.
 *
 * Note: this was previously a per-user `WHERE user=? AND finalized=0`
 * helper. The pre-existing `idx_parlays_user` index doesn't include
 * `finalized`, but the active-parlays slice composes with
 * `listUnfinalizedParlays()` instead — both are O(small) so the
 * extra filter pass is free.
 */
export function listAllParlaysForUser(user: string, limit = 200): ParlayRow[] {
  // R35 audit fix: previously this returned every parlay for the
  // user with no SQL `LIMIT`. A user with 10k parlays would force
  // the /parlay/user/:addr handler to materialise the entire result
  // set in memory before the caller-side `limit` slice — a 10k-row
  // DoS for the indexer + the web. Bound the SQL itself; the caller
  // can still pass a smaller `limit` for tighter pages. The 200-row
  // default matches the `Math.min(..., 200)` cap the route enforces.
  return getDb()
    .prepare(
      `SELECT * FROM parlays
        WHERE user = ?
        ORDER BY created_at_ms DESC
        LIMIT ?`,
    )
    .all(user, limit) as ParlayRow[];
}

/**
 * List parlays that have all legs recorded but aren't yet
 * finalized — the worker can call `finalize_parlay` on these.
 */
export function listReadyToFinalizeParlays(): ParlayRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM parlays
        WHERE finalized = 0
          AND legs_recorded >= leg_count
        ORDER BY updated_at_ms ASC`,
    )
    .all() as ParlayRow[];
}

// ============================================================
// streak_badges - StreakBadge NFT mints
// ============================================================

/**
 * Insert a badge mint from a BadgeMinted event. The on-chain
 * event is emitted from both mint_badge and mint_badge_to_kiosk
 * so we don't need a separate event type for the kiosk path. The
 * INSERT OR IGNORE makes re-polling the same cursor safe.
 *
 * R29: the row sits in the table for future use; no read path
 * currently consumes it. The on-chain `UserStreak.claimed_tiers`
 * boolean array is the source of truth for the web's "Badges
 * Earned" UI (see StreakProfile), so a `listBadgesForUser`
 * consumer is unnecessary until a profile page needs to render
 * the badge NFT metadata (image, kiosk id, etc).
 */
export function recordBadgeMint(b: {
  badge_id: string;
  user: string;
  tier: number;
  longest_streak_at_mint: number;
  minted_at_ms: number;
}): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO streak_badges
         (badge_id, user, tier, longest_streak_at_mint, minted_at_ms)
       VALUES
         (@badge_id, @user, @tier, @longest_streak_at_mint, @minted_at_ms)`,
    )
    .run(b);
}
