import {
  buildCreateMarketTx,
  buildMintSharesTx,
  buildSetupReferralTx,
  extractCreatedObjectId,
} from "@suipredict/sdk";
import { DEEP_TYPE, POOL_CREATION_FEE_DEEP } from "@suipredict/sdk";
import type { AgentContext, AgentResult } from "../lib.js";
import { callLlm, recordResult } from "../lib.js";
import { listMarkets, upsertMarket } from "../markets/store.js";

const MAX_ACTIVE = Number(process.env.MAX_ACTIVE_MARKETS ?? 5);
const DEEPBOOK_REGISTRY_ID = process.env.DEEPBOOK_REGISTRY_ID ?? "0x7c256edbda983a2cd6f946655f4bf3f00a41043993781f8674a7046e8c0e11d1";

const FALLBACK_MARKETS = [
  {
    title: "Will ETH flip BTC market cap in 2026?",
    description: "Resolves YES if ETH market cap exceeds BTC on CoinGecko.",
    category: "crypto",
    days: 21,
    resolution_source: "CoinGecko market cap",
  },
  {
    title: "Will DeepBook V3 TVL exceed $50M by Q3?",
    description: "Resolves YES if DeepBook V3 total value locked >= $50M.",
    category: "defi",
    days: 30,
    resolution_source: "DeepBook analytics",
  },
];

interface MarketSpec {
  title: string;
  description: string;
  category: string;
  expiry_days: number;
  resolution_source: string;
}

async function proposeMarket(): Promise<MarketSpec> {
  const prompt = `Propose one binary prediction market for a Polymarket-style exchange on Sui/DeepBook.
Respond ONLY with JSON: {"title":"...","description":"...","category":"crypto|politics|sports|defi","expiry_days":7-30,"resolution_source":"..."}`;

  const raw = await callLlm(prompt);
  if (raw) {
    try {
      const parsed = JSON.parse(raw.replace(/```json|```/g, "").trim()) as MarketSpec;
      if (parsed.title && parsed.expiry_days >= 1 && parsed.expiry_days <= 30) {
        return parsed;
      }
    } catch {
      /* fallback */
    }
  }

  const fb = FALLBACK_MARKETS[Math.floor(Math.random() * FALLBACK_MARKETS.length)]!;
  return {
    title: fb.title,
    description: fb.description,
    category: fb.category,
    expiry_days: fb.days,
    resolution_source: fb.resolution_source,
  };
}

export async function runMarketCreator(ctx: AgentContext): Promise<AgentResult> {
  const active = listMarkets().filter((m) => m.status === "active");
  if (active.length >= MAX_ACTIVE) {
    return recordResult("MarketCreator", {
      action: "skip",
      reasoning: `${active.length} active markets — at cap of ${MAX_ACTIVE}.`,
      confidence: 90,
    });
  }

  const spec = await proposeMarket();
  const expiryMs = BigInt(Date.now() + spec.expiry_days * 86_400_000);

  if (!DEEPBOOK_REGISTRY_ID) {
    // Demo mode — no on-chain
    const id = `demo-${Date.now()}`;
    upsertMarket({
      id,
      title: spec.title,
      description: spec.description,
      category: spec.category,
      expiry_ms: Number(expiryMs),
      resolution_source: spec.resolution_source,
      status: "active",
      created_at_ms: Date.now(),
    });
    return recordResult("MarketCreator", {
      action: "demo_market",
      reasoning: `Created demo market: ${spec.title}`,
      confidence: 75,
    });
  }

  const { createClient, executeTransaction } = await import("@suipredict/sdk");
  const client = createClient();

  try {
    // Step 1: acquire a Coin<DEEP> with enough for pool creation fee (500 DEEP)
    const agentAddr = ctx.signer.getPublicKey().toSuiAddress();
    const { objects: deepCoins } = await client.core.listCoins({
      owner: agentAddr,
      coinType: DEEP_TYPE,
    });
    const deepCoin = deepCoins.find((c) => BigInt(c.balance) >= POOL_CREATION_FEE_DEEP);
    if (!deepCoin) {
      return recordResult("MarketCreator", {
        action: "no_deep",
        reasoning: `Need at least 500 DEEP for pool creation. Have ${deepCoins.length} DEEP coins.`,
        confidence: 50,
      });
    }

    // Step 2: create the market (includes pool creation + YES/NO coin types)
    const createTx = buildCreateMarketTx({
      title: spec.title,
      resolutionSource: spec.resolution_source,
      expiryMs,
      tickSize: 1_000_000n,      // 0.001 DBUSDC tick
      lotSize: 1_000_000n,       // 1 YES minimum
      minSize: 1_000_000n,       // 1 YES minimum
      deepCoinId: deepCoin.objectId,
    });

    const createResult = await executeTransaction(client, createTx, ctx.signer);
    const marketId = await extractCreatedObjectId(client, createResult.digest, "PredictionMarket");
    if (!marketId) throw new Error("PredictionMarket object not found in effects");

    // Step 3: setup DeepBook referral for this market's pool
    // We need the pool ID from the market — fetch market object
    const { object } = await client.core.getObject({ objectId: marketId, include: { json: true } });
    const poolId = object?.json?.pool_id as string | undefined;
    if (poolId) {
      const referralTx = buildSetupReferralTx(marketId, poolId, 1_000_000_000n);
      await executeTransaction(client, referralTx, ctx.signer);
    }

    upsertMarket({
      id: marketId,
      title: spec.title,
      description: spec.description,
      category: spec.category,
      expiry_ms: Number(expiryMs),
      resolution_source: spec.resolution_source,
      status: "active",
      pool_id: poolId ?? null,
      deepbook_pool_id: poolId ?? null,
      deepbook_base_coin_type: `${process.env.PREDICT_MARKET_PACKAGE_ID ?? "0x0"}::prediction_market::YES<0xf7152c05930480cd740d7311b5b8b45c6f488e3a53a11c3f74a6fac36a52e0d7::DBUSDC::DBUSDC>`,
      deepbook_quote_coin_type: "0xf7152c05930480cd740d7311b5b8b45c6f488e3a53a11c3f74a6fac36a52e0d7::DBUSDC::DBUSDC",
      created_at_ms: Date.now(),
    });

    return recordResult("MarketCreator", {
      action: "create_market",
      reasoning: `On-chain market: ${spec.title} (pool: ${poolId ? poolId.slice(0, 10) + "..." : "N/A"})`,
      confidence: 85,
      txDigest: createResult.digest,
    });
  } catch (err) {
    return recordResult("MarketCreator", {
      action: "create_failed",
      reasoning: `Market creation failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}