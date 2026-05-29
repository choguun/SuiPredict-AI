import {
  createClient,
  executeTransaction,
  getVaultSummary,
  supplyPLP,
} from "@suipredict/sdk";
import type { AgentContext, AgentResult } from "../lib.js";
import { recordResult } from "../lib.js";

const HIGH_UTILIZATION = 0.6;
const LOW_UTILIZATION = 0.3;
const SUPPLY_AMOUNT = 1;

export async function runPLPManager(ctx: AgentContext): Promise<AgentResult> {
  const vault = await getVaultSummary();
  const utilization = vault.utilization ?? 0;

  if (utilization >= HIGH_UTILIZATION) {
    try {
      const client = createClient();
      const result = await supplyPLP(client, ctx.signer, SUPPLY_AMOUNT);
      return recordResult("PLPManager", {
        action: "supply_plp",
        reasoning: `Vault utilization ${(utilization * 100).toFixed(1)}% — supplied $${SUPPLY_AMOUNT} dUSDC for PLP yield.`,
        confidence: 90,
        txDigest: result.digest,
      });
    } catch (err) {
      return recordResult("PLPManager", {
        action: "supply_failed",
        reasoning: `High utilization (${(utilization * 100).toFixed(1)}%) but supply failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  if (utilization <= LOW_UTILIZATION) {
    return recordResult("PLPManager", {
      action: "hold",
      reasoning: `Vault utilization ${(utilization * 100).toFixed(1)}% — below threshold, holding PLP.`,
      confidence: 85,
    });
  }

  return recordResult("PLPManager", {
    action: "monitor",
    reasoning: `Vault utilization ${(utilization * 100).toFixed(1)}% — within normal range.`,
  });
}
