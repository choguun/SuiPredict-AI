import {
  AGENT_POLICY_PACKAGE_ID,
  buildAuthorizeSpendTx,
  buildPausePolicyTx,
  dusdcToDollars,
  executeTransaction,
  getPolicyState,
} from "@suipredict/sdk";
import { getVaultSummaryFromEnv } from "../markets/store.js";
import type { AgentContext, AgentResult } from "../lib.js";
import { getSharedClient, recordResult } from "../lib.js";

// R44 audit fix: `RISK_PAUSE_UTILIZATION` is a runtime-tunable
// knob that an operator might hot-patch via `bootstrap-env.ts`
// (e.g. to drop the threshold from 0.80 to 0.95 after a
// liquidity event, or raise it to 0.50 during a stress test).
// Reading it at module load (the previous behavior) froze the
// value at boot time; a hot-patch landed via
// `bootstrap-env.ts` would update `process.env` but the agent
// would still compare against the old constant. Move the read
// inside `runRiskMonitor` so a hot-patch takes effect on the
// next cron tick. This matches the R43 fix in prize-admin.ts
// and market-creator.ts.
const DEFAULT_PAUSE_UTILIZATION = 0.80;

export async function runRiskMonitor(ctx: AgentContext): Promise<AgentResult> {
  const pauseUtilization = Number(
    process.env.RISK_PAUSE_UTILIZATION ?? DEFAULT_PAUSE_UTILIZATION,
  );
  // Read the suipredict ProtocolVault utilization from the agents'
  // own /vault/summary source (backed by VAULT_TOTAL_BALANCE and
  // VAULT_ALLOCATED env vars). The legacy `getVaultSummary()` from
  // @suipredict/sdk queries Mysten's predict-server — a different
  // product — so it always returns 0/404 here.
  const vault = getVaultSummaryFromEnv();
  const utilization = vault.total_balance > 0 ? vault.allocated / vault.total_balance : 0;
  // R52 audit fix: use the singleton
  // gRPC client. The R51 sweep missed
  // this worker.
  const client = getSharedClient();

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

  if (utilization >= pauseUtilization) {
    // R42 audit fix: explicitly distinguish the "high utilization
    // but no policy id configured" case from the routine monitor
    // path. The previous code combined the two into a single
    // "&& ctx.policyId" guard and silently returned `monitor` —
    // a 95% utilization reading with no policyId set would look
    // identical to a 30% utilization reading in the agents
    // dashboard. Surface a dedicated `pause_skipped_no_policy` so
    // the operator sees a red flag in the /agents/decisions feed
    // and can wire up the policy id env var.
    if (!ctx.policyId) {
      return recordResult("RiskMonitor", {
        action: "pause_skipped_no_policy",
        reasoning:
          `Vault utilization ${(utilization * 100).toFixed(2)}% ` +
          `>= ${(pauseUtilization * 100).toFixed(0)}% threshold but ` +
          `AGENT_POLICY_ID is not configured; cannot pause. Set the ` +
          `env var and restart the agents service.`,
        confidence: 95,
      });
    }
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
