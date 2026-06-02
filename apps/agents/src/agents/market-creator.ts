import {
  buildCreateMarketTx,
  buildMintSharesTx,
  buildRegisterMarketTx,
  buildSetupReferralTx,
  DBUSDC_TYPE,
  DUSDC_TYPE,
  extractCreatedObjectId,
  yesCoinType,
} from "@suipredict/sdk";
import { DEEP_TYPE, POOL_CREATION_FEE_DEEP } from "@suipredict/sdk";
import type { AgentContext, AgentResult } from "../lib.js";
import { callLlm, recordResult } from "../lib.js";
import { listMarkets, upsertMarket } from "../markets/store.js";

const MAX_ACTIVE = Number(process.env.MAX_ACTIVE_MARKETS ?? 5);
const DEEPBOOK_REGISTRY_ID = process.env.DEEPBOOK_REGISTRY_ID ?? "0x7c256edbda983a2cd6f946655f4bf3f00a41043993781f8674a7046e8c0e11d1";
const MARKET_REGISTRY_ID = process.env.MARKET_REGISTRY_ID ?? "";
const FEE_VAULT_ID = process.env.FEE_VAULT_ID ?? "";
const INITIAL_MINT_ATOMS = BigInt(
  process.env.MARKET_CREATOR_INITIAL_MINT_ATOMS ?? 10_000_000,
); // 10 DBUSDC default — seeds the order book with an initial position

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

async function proposeMarket(): Promise<{
  spec: MarketSpec;
  source: "llm" | "fallback";
  fallbackReason?: string;
}> {
  const prompt = `Propose one binary prediction market for a Polymarket-style exchange on Sui/DeepBook.
Respond ONLY with JSON: {"title":"...","description":"...","category":"crypto|politics|sports|defi","expiry_days":7-30,"resolution_source":"..."}`;

  // Reason the LLM path was skipped — recorded in the agent decision
  // and the boot health endpoint so an operator can tell at a glance
  // whether the agent is brainstorming or running on autopilot.
  if (!process.env.OPENAI_API_KEY) {
    return pickFallback("OPENAI_API_KEY not set");
  }
  const raw = await callLlm(prompt);
  if (!raw) {
    return pickFallback("LLM call returned null (network error, 4xx/5xx, or empty response)");
  }
  try {
    const parsed = JSON.parse(raw.replace(/```json|```/g, "").trim()) as MarketSpec;
    if (parsed.title && parsed.expiry_days >= 1 && parsed.expiry_days <= 30) {
      return { spec: parsed, source: "llm" };
    }
    return pickFallback(`LLM JSON missing required fields: ${JSON.stringify(parsed).slice(0, 80)}`);
  } catch (e) {
    return pickFallback(`LLM JSON parse error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function pickFallback(reason: string): {
  spec: MarketSpec;
  source: "fallback";
  fallbackReason: string;
} {
  const fb = FALLBACK_MARKETS[Math.floor(Math.random() * FALLBACK_MARKETS.length)]!;
  // Loud console warning so the operator sees the fallback in their
  // log stream even before checking the decision store.
  console.warn(
    `[market-creator] LLM unavailable — using FALLBACK_MARKETS. Reason: ${reason}`,
  );
  return {
    spec: {
      title: fb.title,
      description: fb.description,
      category: fb.category,
      expiry_days: fb.days,
      resolution_source: fb.resolution_source,
    },
    source: "fallback",
    fallbackReason: reason,
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

  const { spec, source, fallbackReason } = await proposeMarket();
  const expiryMs = BigInt(Date.now() + spec.expiry_days * 86_400_000);
  const sourceTag =
    source === "fallback"
      ? ` [FALLBACK: ${fallbackReason ?? "unknown reason"}]`
      : " [llm]";

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
      reasoning: `Created demo market${sourceTag}: ${spec.title}`,
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
      tickSize: BigInt(1_000_000),  // 0.001 DUSDC tick
      lotSize: BigInt(1_000_000),    // 1 YES minimum
      minSize: BigInt(1_000_000),    // 1 YES minimum
      deepCoinId: deepCoin.objectId,
    });

    const createResult = await executeTransaction(client, createTx, ctx.signer);
    const marketId = await extractCreatedObjectId(client, createResult.digest, "PredictionMarket");
    if (!marketId) throw new Error("PredictionMarket object not found in effects");

    // Step 3: setup DeepBook referral for this market's pool
    // We need the pool ID and referral ID from the market — fetch market object
    const { object } = await client.core.getObject({ objectId: marketId, include: { json: true } });
    const poolId = object?.json?.pool_id as string | undefined;
    let referralId: string | null = null;
    if (poolId) {
      const referralTx = buildSetupReferralTx(marketId, poolId, BigInt(1_000_000_000));
      const referralResult = await executeTransaction(client, referralTx, ctx.signer);
      referralId = await extractCreatedObjectId(client, referralResult.digest, "DeepBookPoolReferral");
    }

    // Step 3b: register the market in the global MarketRegistry so any
    // off-chain or on-chain consumer can list all live markets. Only the
    // registry admin (this agent) may call. Silent no-op if the registry
    // id isn't configured — keeps demo/single-market environments clean.
    if (MARKET_REGISTRY_ID) {
      try {
        const registerTx = buildRegisterMarketTx(MARKET_REGISTRY_ID, marketId);
        await executeTransaction(client, registerTx, ctx.signer);
      } catch (regErr) {
        console.warn(
          `[market-creator] register_market failed for ${marketId}:`,
          regErr instanceof Error ? regErr.message : regErr,
        );
      }
    }

    // Step 4: seed liquidity by minting initial YES+NO shares.
    // Skipped silently if the agent has no DBUSDC (common on testnet).
    let initialMintDigest: string | null = null;
    if (INITIAL_MINT_ATOMS > 0n) {
      try {
        const { objects: dbusdcCoins } = await client.core.listCoins({
          owner: agentAddr,
          coinType: DBUSDC_TYPE,
        });
        const dbusdcCoin = dbusdcCoins
          .filter((c) => BigInt(c.balance) >= INITIAL_MINT_ATOMS)
          .sort((a, b) => (BigInt(b.balance) > BigInt(a.balance) ? 1 : -1))[0];
        if (dbusdcCoin) {
          if (!FEE_VAULT_ID) {
            console.warn(
              `[market-creator] FEE_VAULT_ID not configured — skipping initial mint for ${marketId}`,
            );
          } else {
            const mintTx = buildMintSharesTx(marketId, FEE_VAULT_ID, dbusdcCoin.objectId);
            const mintResult = await executeTransaction(client, mintTx, ctx.signer);
            initialMintDigest = mintResult.digest;
          }
        } else {
          console.warn(
            `[market-creator] no DBUSDC coin with >= ${INITIAL_MINT_ATOMS} atoms — skipping initial mint for ${marketId}`,
          );
        }
      } catch (mintErr) {
        console.warn(
          `[market-creator] initial mint failed for ${marketId}:`,
          mintErr instanceof Error ? mintErr.message : mintErr,
        );
      }
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
      deepbook_pool_key: poolId ? `market_${marketId.slice(0, 8)}` : null,
      deepbook_pool_id: poolId ?? null,
      deepbook_base_coin_type: poolId ? yesCoinType() : null,
      deepbook_quote_coin_type: poolId ? DUSDC_TYPE : null,
      deepbook_base_scalar: 1_000_000,
      deepbook_quote_scalar: 1_000_000,
      referral_id: referralId,
      created_at_ms: Date.now(),
    });

    return recordResult("MarketCreator", {
      action: "create_market",
      reasoning: `On-chain market${sourceTag}: ${spec.title} (pool: ${poolId ? poolId.slice(0, 10) + "..." : "N/A"}${initialMintDigest ? ", seeded" : ", unseeded"})`,
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