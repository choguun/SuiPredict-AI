import {
  buildResolveMarketTx,
  createClient,
  executeTransaction,
  getSpotPrice,
  findNearestActiveOracle,
} from "@suipredict/sdk";
import type { AgentContext, AgentResult } from "../lib.js";
import { callLlm, recordResult } from "../lib.js";
import { getMarket, listMarkets, upsertMarket } from "../markets/store.js";

const CONFIDENCE_THRESHOLD = Number(process.env.RESOLVER_CONFIDENCE ?? 85);

async function resolveOutcome(
  title: string,
  resolutionSource: string,
): Promise<{ outcome: 1 | 2; confidence: number; reasoning: string }> {
  let spot: number | null = null;
  try {
    const oracle = await findNearestActiveOracle();
    if (oracle) spot = await getSpotPrice(oracle.oracle_id);
  } catch {
    /* optional oracle */
  }

  const prompt = `Resolve this prediction market.
Title: ${title}
Source: ${resolutionSource}
${spot != null ? `BTC spot reference: $${spot}` : ""}
Respond ONLY JSON: {"outcome":"yes"|"no","confidence":0-100,"reasoning":"..."}`;

  const raw = await callLlm(prompt);
  if (raw) {
    try {
      const p = JSON.parse(raw.replace(/```json|```/g, "").trim()) as {
        outcome: string;
        confidence: number;
        reasoning: string;
      };
      if (p.confidence >= CONFIDENCE_THRESHOLD) {
        return {
          outcome: p.outcome === "yes" ? 1 : 2,
          confidence: p.confidence,
          reasoning: p.reasoning,
        };
      }
    } catch {
      /* fallback */
    }
  }

  if (title.toLowerCase().includes("btc") && spot != null) {
    const yes = title.includes("100k") ? spot >= 100_000 : spot > 90_000;
    return {
      outcome: yes ? 1 : 2,
      confidence: 88,
      reasoning: `Rule fallback: BTC spot $${spot.toLocaleString()}.`,
    };
  }

  return {
    outcome: 2,
    confidence: 70,
    reasoning: "Rule fallback: insufficient evidence — default NO.",
  };
}

export async function runMarketResolver(ctx: AgentContext): Promise<AgentResult> {
  const now = Date.now();
  const expired = listMarkets().filter(
    (m) => m.status === "active" && m.expiry_ms <= now,
  );

  if (expired.length === 0) {
    return recordResult("MarketResolver", {
      action: "monitor",
      reasoning: "No markets past expiry awaiting resolution.",
      confidence: 95,
    });
  }

  const market = expired[0]!;
  const { outcome, confidence, reasoning } = await resolveOutcome(
    market.title,
    market.resolution_source,
  );

  if (market.id.startsWith("demo-")) {
    upsertMarket({
      ...market,
      status: "resolved",
      outcome: outcome === 1 ? "yes" : "no",
    });
    return recordResult("MarketResolver", {
      action: "resolve_demo",
      reasoning: `${market.title.slice(0, 40)}… → ${outcome === 1 ? "YES" : "NO"}. ${reasoning}`,
      confidence,
    });
  }

  try {
    const client = createClient();
    const tx = buildResolveMarketTx(market.id, outcome);
    const result = await executeTransaction(client, tx, ctx.signer);
    upsertMarket({
      ...market,
      status: "resolved",
      outcome: outcome === 1 ? "yes" : "no",
    });
    return recordResult("MarketResolver", {
      action: "resolve_market",
      reasoning: `Resolved ${market.title.slice(0, 36)}… as ${outcome === 1 ? "YES" : "NO"}. ${reasoning}`,
      confidence,
      txDigest: result.digest,
    });
  } catch (err) {
    return recordResult("MarketResolver", {
      action: "resolve_failed",
      reasoning: `Resolve failed for ${market.id}: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}
