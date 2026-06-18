import {
  buildResolveMarketTx,
  executeTransaction,
  getSpotPrice,
  findNearestActiveOracle,
  marketTypeSeed,
  withMarketType,
} from "@suipredict/sdk";
import type { AgentContext, AgentResult } from "../lib.js";
import { callLlm, getSharedClient, recordResult, safeFloat } from "../lib.js";
import { getMarket, listMarkets, upsertMarket } from "../markets/store.js";

// R51 audit fix: moved the `RESOLVER_CONFIDENCE` read
// inside `runMarketResolver` so a hot-patch via
// `bootstrap-env.ts` takes effect on the next tick.
// The previous module-level capture meant a
// hot-patched value would not be seen until the
// process restarted, defeating the point of the
// hot-patch utility. The sibling `market-creator.ts`
// and `prize-admin.ts` already use this in-body
// pattern (R48 audit fix #6 / #3).

async function resolveOutcome(
  title: string,
  resolutionSource: string,
  confidenceThreshold: number,
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
      if (p.confidence >= confidenceThreshold) {
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
  // R51 audit fix: read `RESOLVER_CONFIDENCE` here
  // (function body) so a hot-patch takes effect
  // on the next tick. Clamp to [0, 100] to
  // defend against a misconfigured env value
  // (`RESOLVER_CONFIDENCE=500` would have made
  // every market "low confidence" and silently
  // stopped resolutions).
  // R55 audit fix: route through `safeFloat` so a
  // `RESOLVER_CONFIDENCE=NaN` doesn't break the resolver
  // silently. The previous `Math.max(0, Math.min(100, ...))`
  // clamped the result but didn't warn the operator that
  // the raw env was invalid.
  const confidenceThreshold = safeFloat(
    process.env.RESOLVER_CONFIDENCE,
    85,
    0,
    100,
  );
  const expired = listMarkets().filter(
    (m) => m.status === "active" && m.expiry_ms <= now && m.category !== "worldcup",
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
    confidenceThreshold,
  );

  // R57 agents audit fix: reject `outcome` values outside the
  // documented `1 = YES, 2 = NO` range before touching
  // the on-chain `buildResolveMarketTx` (which would happily
  // encode any u8) or the off-chain `upsertMarket` (which
  // would now silently coerce to "no" via the ternary). An
  // LLM that returned `0` / `3` for a malformed prompt
  // would either abort on-chain with `EInvalidOutcome`
  // (Move code 4) or, worse, record the wrong side as the
  // resolution. Surface the bad value as a `resolve_failed`
  // record and skip the tx.
  if (outcome !== 1 && outcome !== 2) {
    return recordResult("MarketResolver", {
      action: "resolve_failed",
      reasoning: `Resolver returned outcome ${outcome} for ${market.id}; must be 1 (YES) or 2 (NO). Reasoning: ${reasoning}`,
      confidence,
    });
  }

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
    // R52 audit fix: use the
    // singleton gRPC client so the
    // resolver shares the agents
    // process's single connection
    // pool. The previous
    // `createClient()` instantiates
    // a new `SuiGrpcClient` per
    // resolve tx, which under
    // batched expirations churns
    // the Sui node's per-IP rate
    // limiter. The R51 sweep
    // missed this worker.
    const client = getSharedClient();
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
