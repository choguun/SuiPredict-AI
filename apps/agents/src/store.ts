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
    mkdirSync(dirname(DB_PATH), { recursive: true });
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
  }
  return db;
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

export function getAgentStats() {
  const rows = getDb()
    .prepare(
      `SELECT agent, action, COUNT(*) as count FROM decisions GROUP BY agent, action`,
    )
    .all() as { agent: string; action: string; count: number }[];
  return rows;
}
