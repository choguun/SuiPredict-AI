import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DATA_DIR
    ? join(process.env.DATA_DIR, "decisions.db")
    : join(__dirname, "../../data/decisions.db");
let db = null;
// R53 audit fix: see the
// matching `closeDb()` in
// `gamification/store.ts` and
// `markets/store.ts` for the
// SIGTERM-handler drain.
export function closeDb() {
    if (db) {
        try {
            db.close();
        }
        catch {
            // shutdown is best-effort
        }
        db = null;
    }
}
export function getDb() {
    if (!db) {
        mkdirSync(dirname(DB_PATH), { recursive: true });
        db = new Database(DB_PATH);
        // R48 audit fix: enable WAL, busy_timeout, and foreign_keys on
        // the decisions DB. Without WAL every read in
        // getRecentDecisions holds a write-lock against the
        // cron-driven indexer writers; without busy_timeout a lock
        // contention throws and the indexer's per-event try/catch
        // swallows it (and per finding #7, the event is lost).
        db.pragma("journal_mode = WAL");
        db.pragma("busy_timeout = 5000");
        db.pragma("foreign_keys = ON");
        // R49 audit fix: cap the `reasoning` length at 4 KiB. The
        // column is a free-text field that the agent loop fills
        // with LLM-style output. A misbehaving prompt (or a
        // deliberately adversarial LLM via prompt injection in a
        // future model upgrade) could write a 10 MB string per
        // decision; 4 agents × 1 cycle/min = ~575 MB/day of
        // unindexed text. The CHECK only applies to *new* tables
        // (CREATE TABLE IF NOT EXISTS is a no-op on existing
        // schemas); the runtime truncation in `logDecision` is
        // the enforcement that actually fires today.
        db.exec(`
      CREATE TABLE IF NOT EXISTS decisions (
        id TEXT PRIMARY KEY,
        agent TEXT NOT NULL,
        action TEXT NOT NULL,
        reasoning TEXT NOT NULL,
        confidence REAL,
        tx_digest TEXT,
        timestamp INTEGER NOT NULL,
        CHECK(length(reasoning) <= 4096)
      )
    `);
        // Policy audit trail — appended by position-indexer on each
        // PolicyCreated / PolicyRevoked / PolicyPaused event from
        // agent_policy.move. The on-chain stream is the only source of
        // truth; this table is the off-chain mirror so a future
        // /admin or compliance surface can query "who paused what when"
        // without hitting the RPC for every page load. Round-26 audit
        // finding C2.
        db.exec(`
      CREATE TABLE IF NOT EXISTS policy_events (
        id TEXT PRIMARY KEY,
        policy_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        actor TEXT NOT NULL,
        ts_ms INTEGER NOT NULL,
        tx_digest TEXT NOT NULL,
        details TEXT
      )
    `);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_policy_events_policy_id ON policy_events(policy_id)`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_policy_events_ts_ms ON policy_events(ts_ms DESC)`);
        // R48 audit fix: index the `decisions.timestamp` column for
        // the getRecentDecisions `ORDER BY timestamp DESC LIMIT ?`
        // query. With 4 agents × 1 cycle/min × weeks of uptime the
        // table is 10k+ rows; the previous full-table sort cost ~1ms
        // per /decisions request, which compounds under load.
        db.exec(`CREATE INDEX IF NOT EXISTS idx_decisions_ts ON decisions(timestamp DESC)`);
        // R56 audit fix: append-only audit tables for on-chain events
        // the round-17 audit wired cursor subscriptions for but the
        // R56 audit found still have no DB writer. The AgentAction
        // and ReferralSet handlers in position-indexer were
        // no-ops; the cursor advanced on every tick, the event was
        // gone, and there was no off-chain trail for an operator
        // investigating "who authorized this $X spend" or "did the
        // referral-keeper actually set a referral_id for this
        // market". Each table is idempotent on (tx_digest) so a
        // re-run on the same event is a no-op.
        db.exec(`
      CREATE TABLE IF NOT EXISTS agent_actions (
        tx_digest TEXT PRIMARY KEY,
        policy_id TEXT NOT NULL,
        agent TEXT NOT NULL,
        action TEXT NOT NULL,
        ts_ms INTEGER NOT NULL,
        details TEXT
      )
    `);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_actions_policy_id ON agent_actions(policy_id)`);
        db.exec(`
      CREATE TABLE IF NOT EXISTS referral_setup_log (
        market_id TEXT NOT NULL,
        tx_digest TEXT NOT NULL,
        event_seq TEXT NOT NULL,
        referral_id TEXT NOT NULL,
        ts_ms INTEGER NOT NULL,
        PRIMARY KEY (market_id, tx_digest, event_seq)
      )
    `);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_referral_setup_market ON referral_setup_log(market_id)`);
    }
    return db;
}
export function logPolicyEvent(entry) {
    const id = `${entry.policyId}-${entry.txDigest}-${entry.eventType}`;
    const record = { ...entry, id };
    getDb()
        .prepare(`INSERT OR IGNORE INTO policy_events
        (id, policy_id, event_type, actor, ts_ms, tx_digest, details)
       VALUES (@id, @policyId, @eventType, @actor, @tsMs, @txDigest, @details)`)
        .run({
        id: record.id,
        policyId: record.policyId,
        eventType: record.eventType,
        actor: record.actor,
        tsMs: record.tsMs,
        txDigest: record.txDigest,
        details: record.details ?? null,
    });
    return record;
}
export function getRecentPolicyEvents(limit = 50) {
    return getDb()
        .prepare(`SELECT * FROM policy_events ORDER BY ts_ms DESC LIMIT ?`)
        .all(limit)
        .map((row) => {
        const r = row;
        return {
            id: r.id,
            policyId: r.policy_id,
            eventType: r.event_type,
            actor: r.actor,
            tsMs: r.ts_ms,
            txDigest: r.tx_digest,
            details: r.details ?? undefined,
        };
    });
}
export function logAgentAction(entry) {
    getDb()
        .prepare(`INSERT OR IGNORE INTO agent_actions
         (tx_digest, policy_id, agent, action, ts_ms, details)
       VALUES
         (@txDigest, @policyId, @agent, @action, @tsMs, @details)`)
        .run({
        txDigest: entry.tx_digest,
        policyId: entry.policy_id,
        agent: entry.agent,
        action: entry.action,
        tsMs: entry.ts_ms,
        details: entry.details ?? null,
    });
}
export function logReferralSet(entry) {
    getDb()
        .prepare(`INSERT OR IGNORE INTO referral_setup_log
         (market_id, tx_digest, event_seq, referral_id, ts_ms)
       VALUES
         (@marketId, @txDigest, @eventSeq, @referralId, @tsMs)`)
        .run({
        marketId: entry.market_id,
        txDigest: entry.tx_digest,
        eventSeq: entry.event_seq,
        referralId: entry.referral_id,
        tsMs: entry.ts_ms,
    });
}
export function logDecision(entry) {
    const id = `${entry.agent}-${entry.timestamp}-${Math.random().toString(36).slice(2, 8)}`;
    // R49 audit fix: truncate `reasoning` at the 4 KiB cap to
    // match the new schema CHECK. The CHECK only applies to
    // freshly-created tables, so an existing DB without the
    // constraint would still accept an oversize write — this
    // truncation is the source of truth. Use a 16-byte UTF-8
    // ellipsis marker so a reader can tell the string was cut.
    const MAX_REASONING_BYTES = 4096;
    const reasoning = entry.reasoning.length > MAX_REASONING_BYTES
        ? entry.reasoning.slice(0, MAX_REASONING_BYTES - 16) + "…[truncated]"
        : entry.reasoning;
    const record = { ...entry, id, reasoning };
    getDb()
        .prepare(`INSERT INTO decisions (id, agent, action, reasoning, confidence, tx_digest, timestamp)
       VALUES (@id, @agent, @action, @reasoning, @confidence, @txDigest, @timestamp)`)
        .run({
        id: record.id,
        agent: record.agent,
        action: record.action,
        reasoning: record.reasoning,
        confidence: record.confidence ?? null,
        txDigest: record.txDigest ?? null,
        timestamp: record.timestamp,
    });
    return record;
}
export function getRecentDecisions(limit = 50) {
    return getDb()
        .prepare(`SELECT * FROM decisions ORDER BY timestamp DESC LIMIT ?`)
        .all(limit)
        .map((row) => {
        const r = row;
        return {
            id: r.id,
            agent: r.agent,
            action: r.action,
            reasoning: r.reasoning,
            confidence: r.confidence,
            txDigest: r.tx_digest ?? undefined,
            timestamp: r.timestamp,
        };
    });
}
// R58.M1 audit fix: prune the `decisions` table to
// the last `daysToKeep` days. The agents were appending
// to `decisions` on every `logDecision` call (one per
// market-maker / market-resolver / parlay-worker tick
// when the LLM returned a non-null response) and
// nothing was cleaning it up. After a week of testnet
// uptime the table held ~120k rows (~80 MB); the
// /decisions admin page that calls
// `getRecentDecisions(50)` was still fast (the
// `idx_decisions_ts` index made the LIMIT cheap) but
// `VACUUM` was no-op and the file grew. Default
// retention is 30 days; the leaderboard-worker calls
// this once per tick (the same cadence as its other
// cleanup sweeps). 30 days covers any plausible
// post-incident forensic window.
export function pruneOldDecisions(daysToKeep = 30) {
    const cutoffMs = Date.now() - daysToKeep * 24 * 60 * 60 * 1000;
    const result = getDb()
        .prepare(`DELETE FROM decisions WHERE timestamp < ?`)
        .run(cutoffMs);
    return result.changes;
}
//# sourceMappingURL=store.js.map