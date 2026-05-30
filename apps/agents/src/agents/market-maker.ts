import {
  createClient,
  createMarketDeepBookClient,
  buildPlaceYesLimitOrderTx,
  buildWithdrawSettledTx,
  getOrderBookDepth,
  getMidPrice,
  PREDICT_DEEPBOOK_POOL_KEY,
  executeTransaction,
  DeepBookClient,
} from "@suipredict/sdk";
import type { AgentContext, AgentResult } from "../lib.js";
import { recordResult } from "../lib.js";
import { getMarket, listMarkets, upsertOrder } from "../markets/store.js";

const SPREAD_THRESHOLD_BPS = Number(process.env.MM_SPREAD_THRESHOLD_BPS ?? 400);
const QUOTE_SIZE = Number(process.env.MM_QUOTE_SIZE ?? 10_000_000);
const BALANCE_MANAGER_ID = process.env.BALANCE_MANAGER_ID;

export async function runMarketMaker(ctx: AgentContext): Promise<AgentResult> {
  // Find an active market that has a DeepBook pool
  const target = listMarkets().find(
    (m) => m.status === "active" && m.deepbook_pool_id,
  );
  if (!target) {
    return recordResult("MarketMaker", {
      action: "skip",
      reasoning: "No active markets with DeepBook pools.",
    });
  }

  const poolKey = target.deepbook_pool_key ?? PREDICT_DEEPBOOK_POOL_KEY;
  const client = createClient();
  const agentAddr = ctx.signer.getPublicKey().toSuiAddress();

  // Create DeepBook client for this specific market
  let dbClient: DeepBookClient;
  try {
    dbClient = createMarketDeepBookClient(
      client,
      agentAddr,
      target.deepbook_pool_id!,
      BALANCE_MANAGER_ID ?? undefined,
    );
  } catch (err) {
    return recordResult("MarketMaker", {
      action: "skip",
      reasoning: `No BalanceManager configured: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  // Get current order book depth
  let book;
  try {
    book = await getOrderBookDepth(dbClient, poolKey, 0.01, 0.99);
  } catch {
    book = { bids: [], asks: [] };
  }

  const bestBid = book.bids[0]?.[0] ?? 0;
  const bestAsk = book.asks[0]?.[0] ?? 0;
  const spreadBps =
    bestBid > 0 && bestAsk > 0 ? Math.round((bestAsk - bestBid) * 10_000) : 9999;

  if (spreadBps <= SPREAD_THRESHOLD_BPS && book.bids.length > 0 && book.asks.length > 0) {
    return recordResult("MarketMaker", {
      action: "hold",
      reasoning: `${target.title.slice(0, 40)}... spread ${spreadBps}bps -- tight, hold.`,
      confidence: 88,
    });
  }

  // Derive quote prices from mid price
  const midPrice = await getMidPrice(dbClient, poolKey);
  if (midPrice <= 0) {
    return recordResult("MarketMaker", {
      action: "skip",
      reasoning: "Could not determine mid price from DeepBook order book.",
    });
  }

  const midBps = Math.round(midPrice * 10_000);
  const bidBps = Math.max(100, midBps - 200);
  const askBps = Math.min(9900, midBps + 200);

  if (target.id.startsWith("demo-")) {
    upsertOrder({
      market_id: target.id,
      order_id: Date.now(),
      owner: agentAddr,
      is_bid: true,
      price_bps: bidBps,
      quantity: QUOTE_SIZE,
      timestamp_ms: Date.now(),
    });
    upsertOrder({
      market_id: target.id,
      order_id: Date.now() + 1,
      owner: agentAddr,
      is_bid: false,
      price_bps: askBps,
      quantity: QUOTE_SIZE,
      timestamp_ms: Date.now(),
    });
    return recordResult("MarketMaker", {
      action: "quote_demo",
      reasoning: `Demo quotes ${bidBps / 100}¢ / ${askBps / 100}¢ on ${target.title.slice(0, 36)}...`,
      confidence: 80,
    });
  }

  try {
    // Withdraw any previously settled amounts first (housekeeping)
    const withdrawTx = buildWithdrawSettledTx(dbClient, poolKey);
    await executeTransaction(client, withdrawTx, ctx.signer);

    // Place bid limit order (buy YES shares)
    const bidTx = buildPlaceYesLimitOrderTx(dbClient, poolKey, {
      price: bidBps / 10_000,
      quantity: QUOTE_SIZE,
      isBid: true,
      clientOrderId: `mm-${target.id}-bid-${Date.now()}`,
      expiration: Math.floor(Date.now() / 1000) + 3600,
    });
    const bidResult = await executeTransaction(client, bidTx, ctx.signer);

    // Place ask limit order (sell YES shares / go short YES)
    const askTx = buildPlaceYesLimitOrderTx(dbClient, poolKey, {
      price: askBps / 10_000,
      quantity: QUOTE_SIZE,
      isBid: false,
      clientOrderId: `mm-${target.id}-ask-${Date.now()}`,
      expiration: Math.floor(Date.now() / 1000) + 3600,
    });
    await executeTransaction(client, askTx, ctx.signer);

    return recordResult("MarketMaker", {
      action: "place_quotes",
      reasoning: `Quoted ${bidBps / 100}¢/${askBps / 100}¢ on ${target.title.slice(0, 36)}...`,
      confidence: 85,
      txDigest: bidResult.digest,
    });
  } catch (err) {
    return recordResult("MarketMaker", {
      action: "quote_failed",
      reasoning: `MM failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

