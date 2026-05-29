import {
  AGENT_POLICY_PACKAGE_ID,
  CLOCK_OBJECT_ID,
  createClient,
  executeTransaction,
  mintPositionWithTopup,
} from "@suipredict/sdk";
import { Transaction } from "@mysten/sui/transactions";
import type { AgentContext, AgentResult } from "../lib.js";
import {
  callLlm,
  getMarketContext,
  pickAtmStrike,
  recordResult,
} from "../lib.js";

const TRADE_SIZE = 1;
const MIN_CONFIDENCE = 70;

interface StrategistDecision {
  direction: "up" | "down";
  strike?: number;
  quantity: number;
  confidence: number;
  reasoning: string;
  should_trade: boolean;
}

async function decideTrade(
  spot: number | null,
  utilization: number,
): Promise<StrategistDecision> {
  const prompt = `You are the Market Strategist Agent for DeepBook Predict BTC binaries.

Current BTC spot: $${spot?.toLocaleString() ?? "unknown"}
Vault utilization: ${(utilization * 100).toFixed(1)}%

Rules:
- Trade only if confidence >= ${MIN_CONFIDENCE}
- Max quantity: $${TRADE_SIZE}
- Prefer ATM strikes near spot
- direction: "up" if bullish momentum, "down" if bearish

Output JSON:
{
  "should_trade": true/false,
  "direction": "up" or "down",
  "strike": 75000,
  "quantity": 1,
  "confidence": 0-100,
  "reasoning": "..."
}`;

  const llmResponse = await callLlm(prompt);
  if (llmResponse) {
    try {
      const json = JSON.parse(llmResponse.replace(/```json\n?|\n?```/g, "")) as StrategistDecision;
      return json;
    } catch {
      // fall through
    }
  }

  // Rule-based fallback: trade UP if spot available (demo-safe)
  if (spot) {
    return {
      should_trade: true,
      direction: "up",
      quantity: TRADE_SIZE,
      confidence: 75,
      reasoning: "Rule fallback: mint small UP position at ATM strike (LLM unavailable).",
    };
  }

  return {
    should_trade: false,
    direction: "up",
    quantity: TRADE_SIZE,
    confidence: 0,
    reasoning: "No spot price available — skipping trade.",
  };
}

export async function runMarketStrategist(ctx: AgentContext): Promise<AgentResult> {
  const market = await getMarketContext();
  if (!market) {
    return recordResult("MarketStrategist", {
      action: "skip",
      reasoning: "No active oracles found.",
    });
  }

  const { oracle, state, vault } = market;
  const decision = await decideTrade(state.spot, vault.utilization ?? 0);

  if (!decision.should_trade || decision.confidence < MIN_CONFIDENCE) {
    return recordResult("MarketStrategist", {
      action: "skip",
      reasoning: decision.reasoning,
      confidence: decision.confidence,
    });
  }

  const strike =
    decision.strike ??
    (await pickAtmStrike(
      oracle.oracle_id,
      oracle.min_strike,
      oracle.tick_size,
    ));

  const client = createClient();

  // Authorize spend on policy if configured
  if (ctx.policyId) {
    const authTx = new Transaction();
    authTx.moveCall({
      target: `${AGENT_POLICY_PACKAGE_ID}::agent_policy::authorize_spend`,
      arguments: [
        authTx.object(ctx.policyId),
        authTx.pure.u64(BigInt(decision.quantity) * 1_000_000n),
        authTx.object(CLOCK_OBJECT_ID),
      ],
    });
    await executeTransaction(client, authTx, ctx.signer);
  }

  const result = await mintPositionWithTopup(client, ctx.signer, {
    managerId: ctx.managerId,
    oracleId: oracle.oracle_id,
    expiry: BigInt(oracle.expiry),
    strikeDollars: strike,
    direction: decision.direction,
    quantityDollars: decision.quantity,
    topupDollars: decision.quantity + 1,
  });

  return recordResult("MarketStrategist", {
    action: "mint",
    reasoning: `${decision.reasoning} → ${decision.direction.toUpperCase()} @ $${strike}`,
    confidence: decision.confidence,
    txDigest: result.digest,
  });
}
