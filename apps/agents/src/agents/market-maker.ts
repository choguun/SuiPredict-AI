import {
  buildAllocateForMmTx,
  buildPlaceLimitOrderTx,
  buildSplitCollateralAmountTx,
  createClient,
  executeTransaction,
  getMarketOrderBook,
} from "@suipredict/sdk";
import type { AgentContext, AgentResult } from "../lib.js";
import { recordResult } from "../lib.js";
import { getMarket, listMarkets, upsertOrder } from "../markets/store.js";

const SPREAD_THRESHOLD_BPS = Number(process.env.MM_SPREAD_THRESHOLD_BPS ?? 400);
const QUOTE_SIZE = BigInt(process.env.MM_QUOTE_SIZE ?? 10_000_000);
const VAULT_ID = process.env.VAULT_OBJECT_ID;

export async function runMarketMaker(ctx: AgentContext): Promise<AgentResult> {
  const target = listMarkets().find(
    (m) => m.status === "active" && m.order_book_id,
  );
  if (!target) {
    return recordResult("MarketMaker", {
      action: "skip",
      reasoning: "No active markets with order books to quote.",
    });
  }

  let book;
  try {
    book = await getMarketOrderBook(target.id);
  } catch {
    book = { spread_bps: 9999, mid_price: 0.5, bids: [], asks: [] };
  }

  if (book.spread_bps <= SPREAD_THRESHOLD_BPS && book.bids.length > 0 && book.asks.length > 0) {
    return recordResult("MarketMaker", {
      action: "hold",
      reasoning: `${target.title.slice(0, 40)}… spread ${book.spread_bps}bps — within target.`,
      confidence: 88,
    });
  }

  const midBps = Math.round(book.mid_price * 10_000);
  const bidBps = Math.max(100, midBps - 200);
  const askBps = Math.min(9900, midBps + 200);
  const agentAddr = ctx.signer.getPublicKey().toSuiAddress();

  if (target.id.startsWith("demo-")) {
    upsertOrder({
      market_id: target.id,
      order_id: Date.now(),
      owner: agentAddr,
      is_bid: true,
      price_bps: bidBps,
      quantity: Number(QUOTE_SIZE),
      timestamp_ms: Date.now(),
    });
    upsertOrder({
      market_id: target.id,
      order_id: Date.now() + 1,
      owner: agentAddr,
      is_bid: false,
      price_bps: askBps,
      quantity: Number(QUOTE_SIZE),
      timestamp_ms: Date.now(),
    });
    return recordResult("MarketMaker", {
      action: "quote_demo",
      reasoning: `Demo quotes ${bidBps / 100}¢ / ${askBps / 100}¢ on ${target.title.slice(0, 36)}…`,
      confidence: 80,
    });
  }

  if (!VAULT_ID || !target.order_book_id) {
    return recordResult("MarketMaker", {
      action: "skip",
      reasoning: "VAULT_OBJECT_ID or order book not configured for on-chain MM.",
    });
  }

  const client = createClient();
  try {
    const bidQuote = (QUOTE_SIZE * BigInt(bidBps)) / BigInt(10_000);
    const allocTx = buildAllocateForMmTx(VAULT_ID, QUOTE_SIZE + bidQuote);
    await executeTransaction(client, allocTx, ctx.signer);

    const { objects } = await client.core.listCoins({
      owner: agentAddr,
      coinType:
        "0xf7152c05930480cd740d7311b5b8b45c6f488e3a53a11c3f74a6fac36a52e0d7::DBUSDC::DBUSDC",
    });
    const coin = objects.find((c) => BigInt(c.balance) >= QUOTE_SIZE + bidQuote);
    if (!coin) throw new Error("No DBUSDC after vault allocation");

    const splitTx = buildSplitCollateralAmountTx(target.id, coin.objectId, QUOTE_SIZE);
    await executeTransaction(client, splitTx, ctx.signer);

    const remainingCoins = await client.core.listCoins({
      owner: agentAddr,
      coinType:
        "0xf7152c05930480cd740d7311b5b8b45c6f488e3a53a11c3f74a6fac36a52e0d7::DBUSDC::DBUSDC",
    });
    const bidCoin = remainingCoins.objects.find((c) => BigInt(c.balance) >= bidQuote);
    if (!bidCoin) throw new Error("No DBUSDC left for bid escrow");

    const bidTx = buildPlaceLimitOrderTx({
      marketId: target.id,
      orderBookId: target.order_book_id,
      isBid: true,
      priceBps: bidBps,
      quantity: QUOTE_SIZE,
      quoteCoinId: bidCoin.objectId,
    });
    const bidResult = await executeTransaction(client, bidTx, ctx.signer);

    const askTx = buildPlaceLimitOrderTx({
      marketId: target.id,
      orderBookId: target.order_book_id,
      isBid: false,
      priceBps: askBps,
      quantity: QUOTE_SIZE,
    });
    await executeTransaction(client, askTx, ctx.signer);

    return recordResult("MarketMaker", {
      action: "place_quotes",
      reasoning: `Quoted ${bidBps / 100}¢/${askBps / 100}¢ YES on ${getMarket(target.id)?.title.slice(0, 36) ?? target.id}`,
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
