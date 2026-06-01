import {
  AGENT_POLICY_PACKAGE_ID,
  buildAuthorizeSpendTx,
  buildPausePolicyTx,
  createClient,
  dusdcToDollars,
  executeTransaction,
  getPolicyState,
  getVaultSummary,
} from "@suipredict/sdk";
import type { AgentContext, AgentResult } from "../lib.js";
import { recordResult } from "../lib.js";

const PAUSE_UTILIZATION = Number(process.env.RISK_PAUSE_UTILIZATION ?? 0.80);

export async function runRiskMonitor(ctx: AgentContext): Promise<AgentResult> {
  const vault = await getVaultSummary();
  const utilization = vault.utilization ?? 0;
  const client = createClient();

  let policySpent = 0;
  let policyBudget = ctx.maxBudgetUsdc;
  if (ctx.policyId) {
    const policy = await getPolicyState(client, ctx.policyId, AGENT_POLICY_PACKAGE_ID);
    if (policy) {
      policySpent = dusdcToDollars(BigInt(policy.spent));
      policyBudget = dusdcToDollars(BigInt(policy.max_budget));
    }
  }
  const budgetPct = policyBudget > 0 ? policySpent / policyBudget : 0;

  if (utilization >= PAUSE_UTILIZATION && ctx.policyId) {
    try {
      const tx = buildPausePolicyTx(ctx.policyId, AGENT_POLICY_PACKAGE_ID);
      const result = await executeTransaction(client, tx, ctx.signer);
      return recordResult("RiskMonitor", {
        action: "pause_policy",
        reasoning: `Critical vault utilization ${(utilization * 100).toFixed(2)}% — paused agent policy.`,
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

  return recordResult("RiskMonitor", {
    action: "monitor",
    reasoning: `Vault ${(utilization * 100).toFixed(2)}% utilized. Policy spent $${policySpent.toFixed(2)} / $${policyBudget.toFixed(2)}.`,
    confidence: budgetPct > 0.8 ? 60 : 95,
  });
}
