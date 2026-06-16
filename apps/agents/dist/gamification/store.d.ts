export declare function closeDb(): void;
export interface DailyScore {
    user: string;
    day_index: number;
    participated: number;
    all_correct: number;
    streak_after: number;
    category: number;
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
    pool_id?: string | null;
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
export declare function recordStreakEvent(ev: {
    user: string;
    kind: "updated" | "broken" | "milestone";
    new_streak?: number;
    final_streak?: number;
    longest_streak?: number;
    multiplier_tier?: number;
    milestone?: number;
    day_index: number;
    ts_ms: number;
}): void;
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
export declare function listStreakEvents(user?: string, limit?: number): StreakEvent[];
/** Mark a (pool, week) as settled. Idempotent. */
export declare function markPoolWeekSettled(poolId: string, weekIndex: number, tsMs: number): void;
/** True if a (pool, week) has been observed as settled on-chain. */
export declare function isPoolWeekSettled(poolId: string, weekIndex: number): boolean;
export declare function recordDailyScore(score: DailyScore): void;
/**
 * Insert a `daily_scores` row only if the (user, day_index) key does
 * NOT already exist. Used by the streak-sweeper's idempotent path:
 * when a per-user `record_participation` returns `EAlreadyRecordedToday`,
 * the on-chain state was already written by a prior sweep (which used
 * a possibly-different outcome if the position indexer was lagging).
 * The on-chain state is the source of truth, so we must not clobber
 * the existing off-chain row with a fresher-but-disagreeing value.
 */
export declare function recordDailyScoreIfAbsent(score: DailyScore): boolean;
export declare function listDailyScoresForDay(dayIndex: number): DailyScore[];
export declare function listAllDailyScores(): DailyScore[];
export declare function clearDailyScoresBefore(dayIndex: number): number;
export declare function archiveWeekly(rows: WeeklyRow[]): void;
/**
 * R56 audit fix: archive + clear in a single transaction.
 * The previous leaderboard-worker called `archiveWeekly(weekly)`
 * followed by `clearDailyScoresBefore(cutoffDay)` as two
 * separate SQLite calls. A SIGTERM between them left the prior
 * week's daily_scores rows intact AND no archived row; the
 * next tick would re-archive (idempotent on PK) but the
 * clear intent was lost. Wrap both in a transaction so either
 * both succeed or neither does.
 */
export declare function archiveAndClearAtomic(weekly: WeeklyRow[], cutoffDay: number): {
    archived: number;
    cleared: number;
};
export declare function listWeeklyLeaderboard(weekIndex: number, limit?: number, category?: number): WeeklyRow[];
export declare function getUserWeekRank(user: string, weekIndex: number, category?: number): WeeklyRow | null;
export declare function recordPrizeClaim(claim: PrizeClaim): void;
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
export declare function getPrizeClaim(user: string, weekIndex: number, poolId?: string): PrizeClaim | null;
export declare function listPrizeClaims(weekIndex?: number): PrizeClaim[];
/**
 * Set of user addresses that have a recorded `prize_claims` row for the
 * given `weekIndex`. Used by live rollups (which aggregate from
 * `daily_scores`, not the archive) to annotate `claimed` on each row
 * before the leaderboard REST endpoint returns them.
 */
export declare function claimedUsersForWeek(weekIndex: number): Set<string>;
/** Returns the UTC day index for `tsMs`. */
export declare function dayIndexFor(tsMs: number): number;
/** Returns the UTC week index (Monday 00:00 UTC = boundary) for `tsMs`. */
export declare function weekIndexFor(tsMs: number): number;
/**
 * Returns the UTC week index for a UTC day index. Equivalent to
 * `weekIndexFor(dayIndex * 86_400_000)` but with explicit semantics so
 * callers don't have to remember that `DailyScore.day_index` is days,
 * not milliseconds.
 */
export declare function weekIndexForDay(dayIndex: number): number;
/** All distinct day_indices present in the daily_scores table (ascending). */
export declare function knownDayIndices(): number[];
export interface SweepRun {
    day_index: number;
    status: "running" | "complete";
    started_at_ms: number;
    finished_at_ms: number | null;
}
export declare function getSweepRun(dayIndex: number): SweepRun | null;
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
export declare function acquireSweepLock(dayIndex: number, staleMs?: number): boolean;
export declare function releaseSweepLock(dayIndex: number): void;
export interface UserProfile {
    user: string;
    country_code: string;
    forecaster_kind: number;
    updated_at_ms: number;
}
/**
 * Upsert a user profile row. Called from the position-indexer's
 * `ProfileCreated` / `CountryCodeSet` / `ForecasterKindSet` handlers.
 * `country_code` and `forecaster_kind` are taken verbatim from the
 * event payload — the on-chain module is the source of truth, so the
 * off-chain mirror should never try to normalize or validate.
 */
export declare function upsertUserProfile(profile: {
    user: string;
    country_code?: string;
    forecaster_kind?: number;
    updated_at_ms: number;
}): void;
export declare function getUserProfile(user: string): UserProfile | null;
/**
 * Bulk lookup for a leaderboard rollup. Returns a `Map<user, profile>`
 * containing only users that have a row (no entry means the user has
 * no profile and is excluded from country/forecaster-kind filters).
 * Uses a single `WHERE user IN (...)` round-trip — the per-row
 * `getUserProfile` would issue N+1 queries.
 */
export declare function getUserProfilesForUsers(users: string[]): Map<string, UserProfile>;
export interface ParlayRow {
    parlay_id: string;
    pool_id: string;
    user: string;
    collateral_amount: number;
    leg_count: number;
    payout_bps: number;
    legs_recorded: number;
    legs_lost: number;
    finalized: number;
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
export declare function upsertParlayCreated(p: {
    parlay_id: string;
    pool_id: string;
    user: string;
    collateral_amount: number;
    leg_count: number;
    payout_bps: number;
    created_at_ms: number;
}): void;
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
export declare function recordParlayLeg(p: {
    parlay_id: string;
    leg_index: number;
    market_id?: string;
    won: boolean;
    ts_ms: number;
}): void;
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
export declare function recordParlayFinalized(p: {
    parlay_id: string;
    pool_id?: string;
    user?: string;
    won: boolean;
    payout: number;
    legs_lost: number;
    ts_ms: number;
    payout_source?: "onchain" | "missing";
}): void;
/**
 * Read the mirror for a single parlay. Returns null if the
 * `ParlayCreated` event hasn't been indexed yet.
 */
export declare function getParlay(parlayId: string): ParlayRow | null;
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
export declare function listUnfinalizedParlays(): ParlayRow[];
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
export declare function listUnfinalizedParlaysForUser(user: string, limit?: number): ParlayRow[];
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
export declare function getParlayLegMarketIds(parlayId: string, legCount: number): string[] | null;
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
export declare function listAllParlaysForUser(user: string, limit?: number): ParlayRow[];
/**
 * List parlays that have all legs recorded but aren't yet
 * finalized — the worker can call `finalize_parlay` on these.
 */
export declare function listReadyToFinalizeParlays(): ParlayRow[];
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
export declare function recordBadgeMint(b: {
    badge_id: string;
    user: string;
    tier: number;
    longest_streak_at_mint: number;
    minted_at_ms: number;
}): void;
//# sourceMappingURL=store.d.ts.map