import {
  createClient,
  executeTransaction,
  getDusdcBalance,
  getVaultSummary,
  supplyPLP,
} from "@suipredict/sdk";
import type { AgentContext, AgentResult } from "../lib.js";
import { recordResult } from "../lib.js";

const DEFAULT_HIGH_UTIL = Number(process.env.PLP_HIGH_UTILIZATION ?? 0.001);
const DEFAULT_LOW_UTIL = Number(process.env.PLP_LOW_UTILIZATION ?? 0.0005);
const SUPPLY_AMOUNT = Number(process.env.PLP_SUPPLY_AMOUNT ?? 1);

export async function runPLPManager(ctx: AgentContext): Promise<AgentResult> {
  const vault = await getVaultSummary();
  const utilization =
    vault.utilization ?? vault.max_payout_utilization ?? 0;
  const highThreshold = DEFAULT_HIGH_UTIL;
  const lowThreshold = DEFAULT_LOW_UTIL;

  if (utilization >= highThreshold) {
    const client = createClient();
    const address = ctx.signer.getPublicKey().toSuiAddress();
    const balance = await getDusdcBalance(client, address);
    if (balance < BigInt(SUPPLY_AMOUNT) * 1_000_000n) {
      return recordResult("PLPManager", {
        action: "skip",
        reasoning: `High utilization (${(utilization * 100).toFixed(2)}%) but insufficient dUSDC for supply.`,
      });
    }

    try {
      const result = await supplyPLP(client, ctx.signer, SUPPLY_AMOUNT);
      return recordResult("PLPManager", {
        action: "supply_plp",
        reasoning: `Vault utilization ${(utilization * 100).toFixed(2)}% — supplied $${SUPPLY_AMOUNT} dUSDC for PLP yield.`,
        confidence: 90,
        txDigest: result.digest,
      });
    } catch (err) {
      return recordResult("PLPManager", {
        action: "supply_failed",
        reasoning: `High utilization (${(utilization * 100).toFixed(2)}%) but supply failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  if (utilization <= lowThreshold) {
    return recordResult("PLPManager", {
      action: "hold",
      reasoning: `Vault utilization ${(utilization * 100).toFixed(2)}% — below threshold, holding PLP.`,
      confidence: 85,
    });
  }

  return recordResult("PLPManager", {
    action: "monitor",
    reasoning: `Vault utilization ${(utilization * 100).toFixed(2)}% — within normal range.`,
  });
}
