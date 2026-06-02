import {
  AGENT_POLICY_PACKAGE_ID,
  buildAuthorizeSpendTx,
  buildPausePolicyTx,
  createClient,
  dusdcToDollars,
  executeTransaction,
  getPolicyState,
} from "@suipredict/sdk";
import { getVaultSummaryFromEnv } from "../markets/store.js";
import type { AgentContext, AgentResult } from "../lib.js";
import { recordResult } from "../lib.js";

const PAUSE_UTILIZATION = Number(process.env.RISK_PAUSE_UTILIZATION ?? 0.80);

export async function runRiskMonitor(ctx: AgentContext): Promise<AgentResult> {
  // Read the suipredict ProtocolVault utilization from the agents'
  // own /vault/summary source (backed by VAULT_TOTAL_BALANCE and
  // VAULT_ALLOCATED env vars). The legacy `getVaultSummary()` from
  // @suipredict/sdk queries Mysten's predict-server — a different
  // product — so it always returns 0/404 here.
  const vault = getVaultSummaryFromEnv();
  const utilization = vault.total_balance > 0 ? vault.allocated / vault.total_balance : 0;
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
