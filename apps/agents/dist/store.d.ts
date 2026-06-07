import Database from "better-sqlite3";
import type { AgentDecisionLog } from "@suipredict/sdk";
export declare function closeDb(): void;
export declare function getDb(): Database.Database;
export interface PolicyEventLog {
    id: string;
    policyId: string;
    eventType: "created" | "revoked" | "paused";
    actor: string;
    tsMs: number;
    txDigest: string;
    details?: string;
}
export declare function logPolicyEvent(entry: Omit<PolicyEventLog, "id">): PolicyEventLog;
export declare function getRecentPolicyEvents(limit?: number): PolicyEventLog[];
/**
 * R56 audit fix: persist the AgentActionEvent emitted by
 * agent_policy.move. The previous handler in position-indexer
 * was a no-op (the cursor advanced but the event was discarded);
 * an operator investigating "who authorized this $X spend at
 * policy P" had to find the txDigest and call the RPC. INSERT
 * OR IGNORE on (tx_digest) makes a re-run idempotent and
 * the cursor still advances via `guardedPoll`.
 */
export interface AgentActionLog {
    tx_digest: string;
    policy_id: string;
    agent: string;
    action: string;
    ts_ms: number;
    details?: string;
}
export declare function logAgentAction(entry: Omit<AgentActionLog, never>): void;
/**
 * R56 audit fix: persist the ReferralSetEvent so the
 * referral-keeper can verify its own writes against the
 * on-chain event (round-17 finding #4 was the audit goal,
 * but the writer was never implemented). The PK is
 * (market_id, tx_digest, event_seq) so a re-run on the
 * same event is a no-op and the cursor still advances
 * via `guardedPoll`.
 */
export interface ReferralSetupLog {
    market_id: string;
    tx_digest: string;
    event_seq: string;
    referral_id: string;
    ts_ms: number;
}
export declare function logReferralSet(entry: Omit<ReferralSetupLog, never>): void;
export declare function logDecision(entry: Omit<AgentDecisionLog, "id">): AgentDecisionLog;
export declare function getRecentDecisions(limit?: number): AgentDecisionLog[];
export declare function pruneOldDecisions(daysToKeep?: number): number;
//# sourceMappingURL=store.d.ts.map