import {
  buildCreateMarketTx,
  buildCreateOrderBookTx,
  createClient,
  executeTransaction,
  extractCreatedObjectId,
} from "@suipredict/sdk";
import type { AgentContext, AgentResult } from "../lib.js";
import { callLlm, recordResult } from "../lib.js";
import { listMarkets, upsertMarket } from "../markets/store.js";

const MAX_ACTIVE = Number(process.env.MAX_ACTIVE_MARKETS ?? 5);
const REGISTRY_ID = process.env.MARKET_REGISTRY_ID;

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
  const prompt = `Propose one binary prediction market for a Polymarket-style exchange.
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

  if (!REGISTRY_ID) {
    const spec = await proposeMarket();
    const id = `demo-${Date.now()}`;
    upsertMarket({
      id,
      title: spec.title,
      description: spec.description,
      category: spec.category,
      expiry_ms: Date.now() + spec.expiry_days * 86_400_000,
      resolution_source: spec.resolution_source,
      status: "active",
      order_book_id: `demo-book-${id}`,
      created_at_ms: Date.now(),
    });
    return recordResult("MarketCreator", {
      action: "demo_market",
      reasoning: `Created demo market: ${spec.title}`,
      confidence: 75,
    });
  }

  const spec = await proposeMarket();
  const client = createClient();
  const expiryMs = BigInt(Date.now() + spec.expiry_days * 86_400_000);

  try {
    const createTx = buildCreateMarketTx({
      registryId: REGISTRY_ID,
      title: spec.title,
      description: spec.description,
      category: spec.category,
      expiryMs,
      resolutionSource: spec.resolution_source,
    });
    const createResult = await executeTransaction(client, createTx, ctx.signer);
    const marketId = await extractCreatedObjectId(
      client,
      createResult.digest,
      "Market",
    );
    if (!marketId) throw new Error("Market object not found in effects");

    const bookTx = buildCreateOrderBookTx(marketId);
    const bookResult = await executeTransaction(client, bookTx, ctx.signer);
    const bookId = await extractCreatedObjectId(
      client,
      bookResult.digest,
      "OrderBook",
    );

    upsertMarket({
      id: marketId,
      title: spec.title,
      description: spec.description,
      category: spec.category,
      expiry_ms: Number(expiryMs),
      resolution_source: spec.resolution_source,
      status: "active",
      order_book_id: bookId ?? undefined,
      created_at_ms: Date.now(),
    });

    return recordResult("MarketCreator", {
      action: "create_market",
      reasoning: `On-chain market: ${spec.title}`,
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
