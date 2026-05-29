import {
  AGENT_POLICY_PACKAGE_ID,
  buildPausePolicyTx,
  createClient,
  executeTransaction,
  getVaultSummary,
} from "@suipredict/sdk";
import type { AgentContext, AgentResult } from "../lib.js";
import { recordResult } from "../lib.js";
import { getAgentStats } from "../store.js";

const PAUSE_UTILIZATION = 0.95;

export async function runRiskMonitor(ctx: AgentContext): Promise<AgentResult> {
  const vault = await getVaultSummary();
  const utilization = vault.utilization ?? 0;
  const stats = getAgentStats();
  const totalActions = stats.reduce((s, r) => s + r.count, 0);

  if (utilization >= PAUSE_UTILIZATION && ctx.policyId) {
    try {
      const client = createClient();
      const tx = buildPausePolicyTx(ctx.policyId, AGENT_POLICY_PACKAGE_ID);
      const result = await executeTransaction(client, tx, ctx.signer);
      return recordResult("RiskMonitor", {
        action: "pause_policy",
        reasoning: `Critical vault utilization ${(utilization * 100).toFixed(1)}% — paused agent policy.`,
        confidence: 99,
        txDigest: result.digest,
      });
    } catch (err) {
      return recordResult("RiskMonitor", {
        action: "pause_failed",
        reasoning: `High utilization but pause failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  const budgetPct = ctx.maxBudgetUsdc > 0 ? totalActions / ctx.maxBudgetUsdc : 0;

  return recordResult("RiskMonitor", {
    action: "monitor",
    reasoning: `Vault ${(utilization * 100).toFixed(1)}% utilized. ${totalActions} agent actions logged. Budget cap $${ctx.maxBudgetUsdc}.`,
    confidence: budgetPct > 0.8 ? 60 : 95,
  });
}
