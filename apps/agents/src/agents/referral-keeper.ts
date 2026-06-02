/**
 * Referral Keeper — claims accumulated DeepBook trading fee rebates
 * for all markets that have a referral_id set.
 *
 * Run on a schedule (e.g. every 15 min). Rewards accumulate in the
 * DeepBook pool's referral ledger and are paid to the agent's
 * signer; the agent then forwards them to the treasury.
 *
 * Setup path (post round-4): the `MarketCreator` agent now calls
 * `buildSetupReferralTx` for every market it creates (see
 * market-creator.ts:178), so each market's row in the local store
 * carries a populated `referral_id`. This agent still no-ops if no
 * markets match the filter, which is the expected steady state on
 * a fresh deploy before the first market has accrued any trading
 * fees.
 */
import { buildClaimReferralRewardsTx, createClient, executeTransaction, REFERRAL_TREASURY_ADDRESS } from "@suipredict/sdk";
import type { AgentContext, AgentResult } from "../lib.js";
import { recordResult } from "../lib.js";
import { listMarkets, upsertMarket } from "../markets/store.js";

export async function runReferralKeeper(ctx: AgentContext): Promise<AgentResult> {
  const markets = listMarkets().filter(
    (m) => m.status === "active" && m.deepbook_pool_id && m.referral_id,
  );

  if (markets.length === 0) {
    return recordResult("ReferralKeeper", {
      action: "skip",
      reasoning: "No active markets with referrals configured.",
      confidence: 95,
    });
  }

  const client = createClient();
  const agentAddr = ctx.signer.getPublicKey().toSuiAddress();
  const results: string[] = [];
  const errors: string[] = [];

  for (const market of markets) {
    if (!market.deepbook_pool_id || !market.referral_id) continue;

    try {
      const tx = buildClaimReferralRewardsTx(
        market.deepbook_pool_id,
        market.referral_id,
      );
      const result = await executeTransaction(client, tx, ctx.signer);
      results.push(
        `${market.id.slice(0, 12)}... referral sweep → ${result.digest.slice(0, 8)}`,
      );
    } catch (err) {
      // Referral rewards may be zero — don't treat as failure
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("zero") || msg.includes("amount") || msg.includes("InsufficientBalance")) {
        results.push(`${market.id.slice(0, 12)}... no rewards yet`);
      } else {
        errors.push(`${market.id.slice(0, 12)}: ${msg}`);
      }
    }
  }

  if (errors.length > 0) {
    return recordResult("ReferralKeeper", {
      action: "partial",
      reasoning: `Sweep done. Errors: ${errors.join("; ")}`,
      confidence: 70,
    });
  }

  return recordResult("ReferralKeeper", {
    action: "sweep",
    reasoning: `Swept ${results.length} markets. ${results.join(" | ")}`,
    confidence: 88,
  });
}
