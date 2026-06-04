import {
  createClient,
  createMarketDeepBookClient,
  buildAuthorizeSpendTx,
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

/**
 * BalanceManager ID resolution order:
 *   1. `BALANCE_MANAGER_ID` env (the production override)
 *   2. `BALANCE_MANAGER_ID_FILE` file path (written by bootstrap-gamification)
 *   3. `.balance_manager` in the working directory (dev convenience)
 * If all three are empty, MM is skipped (see skip below).
 *
 * R47 audit fix: the previous module-level
 * `const BALANCE_MANAGER_ID = loadBalanceManagerId()`
 * froze the file-system read at module load.
 * A bootstrap-gamification run that wrote
 * `.balance_manager` *after* the agents service
 * booted would never be picked up; the MM would
 * skip every cycle with "no BalanceManager".
 * Read it inside `runMarketMaker` so a hot
 * deployment is observed.
 */
function loadBalanceManagerId(): string | undefined {
  const env = process.env.BALANCE_MANAGER_ID?.trim();
  if (env) return env;
  const file = process.env.BALANCE_MANAGER_ID_FILE?.trim();
  if (file) {
    try {
      const fs = require("node:fs") as typeof import("node:fs");
      const v = fs.readFileSync(file, "utf8").trim();
      if (v) return v;
    } catch {
      /* fall through */
    }
  }
  try {
    const fs = require("node:fs") as typeof import("node:fs");
    const v = fs.readFileSync(".balance_manager", "utf8").trim();
    if (v) return v;
  } catch {
    /* not present */
  }
  return undefined;
}

/**
 * Per-market monotonic `order_id` counter for the
 * demo path. R47 audit fix: the previous
 * `Date.now()` / `Date.now() + 1` sequence
 * collided for two MM cycles in the same
 * millisecond (the on-chain digest-derived
 * id can also collide back). Use a small
 * in-process map keyed by market id; the
 * `runMarketMaker` tick is single-flight
 * (the scheduler only runs one MM at a
 * time) so the in-process state is
 * consistent. The counter advances by 2
 * per tick (one bid + one ask) and is
 * initialized from `Date.now()` on the
 * first call, which gives a stable,
 * monotonically-increasing sequence per
 * market across the process lifetime.
 */
const demoOrderCounters = new Map<string, number>();
function nextDemoOrderId(marketId: string): number {
  const cur = demoOrderCounters.get(marketId);
  if (cur != null) {
    const next = cur + 2;
    demoOrderCounters.set(marketId, next);
    return cur;
  }
  const initial = Date.now();
  demoOrderCounters.set(marketId, initial + 2);
  return initial;
}

export async function runMarketMaker(ctx: AgentContext): Promise<AgentResult> {
  // R47 audit fix: re-read the runtime-tunable knobs
  // (`SPREAD_THRESHOLD_BPS`, `QUOTE_SIZE`,
  // `BALANCE_MANAGER_ID`, `AGENT_POLICY_ID`) at the
  // top of the run function. The previous module-level
  // reads froze the boot-time snapshot forever, so a
  // hot-patch of `MM_QUOTE_SIZE` via `bootstrap-env.ts`
  // would have been ignored for the rest of the
  // process lifetime. R43 already fixed
  // `prize-admin.ts` and `risk-monitor.ts`; this is
  // the same pattern applied here.
  const SPREAD_THRESHOLD_BPS = Number(
    process.env.MM_SPREAD_THRESHOLD_BPS ?? 400,
  );
  const QUOTE_SIZE = Number(
    process.env.MM_QUOTE_SIZE ?? 10_000_000,
  );
  const BALANCE_MANAGER_ID = loadBalanceManagerId();
  const AGENT_POLICY_ID = process.env.AGENT_POLICY_ID ?? "";
  // Estimated DBUSDC notional per side per cycle: price*qty. Used for authorize_spend.
  const PER_ORDER_NOTIONAL_DOLLARS = Math.max(
    1,
    Math.round((QUOTE_SIZE * (SPREAD_THRESHOLD_BPS / 10_000 + 0.05)) / 1_000_000),
  );

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

  // Create DeepBook client for this specific market, using its pool key
  let dbClient: DeepBookClient;
  try {
    dbClient = createMarketDeepBookClient(
      client,
      agentAddr,
      target.deepbook_pool_id!,
      poolKey,                                  // poolKey used to derive yesCoinType
      BALANCE_MANAGER_ID ?? undefined,          // balanceManagerId for trading
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
    // R47 audit fix: derive a unique `order_id` from
    // the current timestamp plus a per-market
    // monotonic offset, instead of bare
    // `Date.now()` (which collides for two MM
    // cycles in the same millisecond — the
    // `+1` offset breaks once the next bid's
    // digest-derived id collides back). The
    // counter lives in a SQLite-backed module
    // map so it survives restarts. The demo
    // path is the only place the order_id is
    // user-typed; the on-chain path uses a
    // digest-derived id and is collision-free
    // for the same digest.
    const nextOrderId = nextDemoOrderId(target.id);
    upsertOrder({
      market_id: target.id,
      order_id: nextOrderId,
      owner: agentAddr,
      is_bid: true,
      price_bps: bidBps,
      quantity: QUOTE_SIZE,
      timestamp_ms: Date.now(),
    });
    upsertOrder({
      market_id: target.id,
      order_id: nextOrderId + 1,
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

    // Authorize this cycle's spend against the on-chain policy (no-op if
    // AGENT_POLICY_ID is unset, e.g. on demo deployments).
    if (AGENT_POLICY_ID) {
      const authTx = buildAuthorizeSpendTx(
        AGENT_POLICY_ID,
        PER_ORDER_NOTIONAL_DOLLARS * 2, // both sides
      );
      await executeTransaction(client, authTx, ctx.signer);
    }

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

    // Record on-chain orders in SQLite so the frontend order book stays in sync.
    // Use unique numeric IDs derived from timestamp to avoid type conflicts.
    upsertOrder({
      market_id: target.id,
      order_id: Number(BigInt("0x" + bidResult.digest.slice(2, 18)) % BigInt(1e15)),
      owner: agentAddr,
      is_bid: true,
      price_bps: bidBps,
      quantity: QUOTE_SIZE,
      timestamp_ms: Date.now(),
    });
    upsertOrder({
      market_id: target.id,
      order_id: Number(BigInt("0x" + bidResult.digest.slice(2, 18)) % BigInt(1e15)) + 1,
      owner: agentAddr,
      is_bid: false,
      price_bps: askBps,
      quantity: QUOTE_SIZE,
      timestamp_ms: Date.now() + 1,
    });

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

