import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentDecisionLog } from "@suipredict/sdk";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, "../../data/decisions.db");

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) {
    mkdirSync(dirname(DB_PATH), {recursive: true});
    db = new Database(DB_PATH);
    db.exec(`
      CREATE TABLE IF NOT EXISTS decisions (
        id TEXT PRIMARY KEY,
        agent TEXT NOT NULL,
        action TEXT NOT NULL,
        reasoning TEXT NOT NULL,
        confidence REAL,
        tx_digest TEXT,
        timestamp INTEGER NOT NULL
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
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_policy_events_policy_id ON policy_events(policy_id)`,
    );
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_policy_events_ts_ms ON policy_events(ts_ms DESC)`,
    );
  }
  return db;
}

export interface PolicyEventLog {
  id: string;
  policyId: string;
  eventType: "created" | "revoked" | "paused";
  actor: string;
  tsMs: number;
  txDigest: string;
  details?: string;
}

export function logPolicyEvent(
  entry: Omit<PolicyEventLog, "id">,
): PolicyEventLog {
  const id = `${entry.policyId}-${entry.txDigest}-${entry.eventType}`;
  const record: PolicyEventLog = {...entry, id};
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO policy_events
        (id, policy_id, event_type, actor, ts_ms, tx_digest, details)
       VALUES (@id, @policyId, @eventType, @actor, @tsMs, @txDigest, @details)`,
    )
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

export function getRecentPolicyEvents(limit = 50): PolicyEventLog[] {
  return getDb()
    .prepare(`SELECT * FROM policy_events ORDER BY ts_ms DESC LIMIT ?`)
    .all(limit)
    .map((row) => {
      const r = row as Record<string, unknown>;
      return {
        id: r.id as string,
        policyId: r.policy_id as string,
        eventType: r.event_type as PolicyEventLog["eventType"],
        actor: r.actor as string,
        tsMs: r.ts_ms as number,
        txDigest: r.tx_digest as string,
        details: (r.details as string | null) ?? undefined,
      };
    });
}

export function logDecision(entry: Omit<AgentDecisionLog, "id">): AgentDecisionLog {
  const id = `${entry.agent}-${entry.timestamp}-${Math.random().toString(36).slice(2, 8)}`;
  const record: AgentDecisionLog = { ...entry, id };
  getDb()
    .prepare(
      `INSERT INTO decisions (id, agent, action, reasoning, confidence, tx_digest, timestamp)
       VALUES (@id, @agent, @action, @reasoning, @confidence, @txDigest, @timestamp)`,
    )
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

export function getRecentDecisions(limit = 50): AgentDecisionLog[] {
  return getDb()
    .prepare(`SELECT * FROM decisions ORDER BY timestamp DESC LIMIT ?`)
    .all(limit)
    .map((row) => {
      const r = row as Record<string, unknown>;
      return {
        id: r.id as string,
        agent: r.agent as string,
        action: r.action as string,
        reasoning: r.reasoning as string,
        confidence: r.confidence as number | undefined,
        txDigest: (r.tx_digest as string) ?? undefined,
        timestamp: r.timestamp as number,
      };
    });
}
