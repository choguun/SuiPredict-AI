import {
  buildLogActionTx,
  buildRedeemTx,
  createClient,
  executeTransaction,
  findSettledOraclesWithOpenPositions,
  strikeToDollars,
} from "@suipredict/sdk";
import type { AgentContext, AgentResult } from "../../lib.js";
import { recordResult } from "../../lib.js";

export async function runRedeemKeeper(ctx: AgentContext): Promise<AgentResult> {
  const client = createClient();
  const positions = await findSettledOraclesWithOpenPositions(ctx.managerId);

  if (positions.length === 0) {
    return recordResult("RedeemKeeper", {
      action: "skip",
      reasoning: "No settled positions awaiting redemption.",
    });
  }

  const pos = positions[0]!;
  const strikeDollars = strikeToDollars(BigInt(pos.strike));
  const quantityDollars = pos.quantity / 1e6;

  if (ctx.policyId) {
    const logTx = buildLogActionTx(ctx.policyId, "redeem_permissionless");
    await executeTransaction(client, logTx, ctx.signer);
  }

  const tx = buildRedeemTx({
    managerId: ctx.managerId,
    oracleId: pos.oracle_id,
    expiry: BigInt(pos.expiry),
    strikeDollars,
    direction: pos.is_up ? "up" : "down",
    quantityDollars,
    permissionless: true,
  });

  const result = await executeTransaction(client, tx, ctx.signer);

  return recordResult("RedeemKeeper", {
    action: "redeem_permissionless",
    reasoning: `Redeemed ${pos.is_up ? "UP" : "DOWN"} @ $${strikeDollars} qty $${quantityDollars} on settled oracle.`,
    txDigest: result.digest,
  });
}
