/**
 * Position indexer — poll MintedEvent, RedeemedEvent, OrderPlacedEvent,
 * and SettledEvent and write to the off-chain tables so `/portfolio`,
 * `/markets/:id/book`, and `/markets/:id/orders` work without a full
 * Sui indexer.
 *
 * Uses a `last_cursor` row in the SQLite `indexer_state` table so
 * restarts resume from where we left off. Events arrive in
 * chronological order (ascending cursor).
 *
 *   - MintedEvent      → +yes_minted YES, +no_minted NO  → `positions`
 *   - RedeemedEvent    → -winning_amount of the winning side → `positions`
 *   - OrderPlacedEvent → → `chain_orders` (any user's order, not just the agent's)
 *   - SettledEvent     → → `settlements` (withdraw_settled notifications)
 *
 * `winning_amount` is the gross share count burned. To know which side
 * was burned we look up the market's outcome (set by the resolver via
 * MarketResolvedEvent and stored in the `markets.outcome` column).
 */
import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";
import type { AgentContext, AgentResult } from "../lib.js";
import { recordResult } from "../lib.js";
import {
  decrementPosition,
  getDb,
  getMarket,
  markMarketResolved,
  markOrderCancelled,
  recordChainOrder,
  recordSettlement,
  upsertMarket,
  upsertPosition,
} from "../markets/store.js";

const SUI_NETWORK = (process.env.SUI_NETWORK ?? "testnet") as
  | "testnet"
  | "mainnet"
  | "devnet"
  | "localnet";
const PREDICT_PACKAGE_ID = process.env.PREDICT_PACKAGE_ID ?? "";
const POLL_BATCH = 200;

interface EventQuery {
  MoveEventType: string;
}
type EventCursor = Parameters<SuiJsonRpcClient["queryEvents"]>[0]["cursor"];

interface MintedJson {
  market_id: string;
  user: string;
  collateral_amount: string | number;
  fee: string | number;
  yes_minted: string | number;
  no_minted: string | number;
}
interface RedeemedJson {
  market_id: string;
  user: string;
  winning_amount: string | number;
  fee: string | number;
  collateral_returned: string | number;
}
interface OrderPlacedJson {
  market_id: string;
  pool_id: string;
  client_order_id: string | number;
  is_bid: boolean;
  price: string | number;
  quantity: string | number;
  order_id: string | number;
}
interface SettledJson {
  market_id: string;
  pool_id: string;
  trader: string;
}
interface MarketResolvedJson {
  market_id: string;
  outcome: string | number;
  resolver?: string;
}
interface MarketCreatedJson {
  market_id: string;
  creator?: string;
  title?: string;
  description?: string;
  category?: string;
  expiry_ms?: string | number;
  resolution_source?: string;
  pool_id?: string;
}
interface OrderCancelledJson {
  market_id: string;
  pool_id?: string;
  order_id: string | number;
}
interface EventEnvelope {
  id: { txDigest: string; eventSeq: string };
  parsedJson: unknown;
  timestampMs?: string;
}

function readCursor(stateKey: string): EventCursor {
  const row = getDb()
    .prepare(`SELECT cursor FROM indexer_state WHERE key = ?`)
    .get(stateKey) as { cursor: string | null } | undefined;
  return (row?.cursor ?? null) as EventCursor;
}

function writeCursor(stateKey: string, cursor: EventCursor): void {
  if (cursor == null) return;
  getDb()
    .prepare(
      `INSERT INTO indexer_state (key, cursor, updated_at_ms)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET cursor=excluded.cursor, updated_at_ms=excluded.updated_at_ms`,
    )
    .run(stateKey, String(cursor), Date.now());
}

async function pollAndApply(
  client: SuiJsonRpcClient,
  eventType: string,
  stateKey: string,
  apply: (ev: EventEnvelope) => void,
): Promise<number> {
  const cursor = readCursor(stateKey);
  const page = await client.queryEvents({
    query: { MoveEventType: eventType },
    cursor,
    limit: POLL_BATCH,
    order: "ascending",
  });
  for (const ev of page.data as unknown as EventEnvelope[]) {
    apply(ev);
  }
  if (page.nextCursor) {
    writeCursor(stateKey, page.nextCursor);
  }
  return page.data.length;
}

export async function runPositionIndexer(
  _ctx: AgentContext,
): Promise<AgentResult> {
  if (!PREDICT_PACKAGE_ID) {
    return recordResult("PositionIndexer", {
      action: "skip",
      reasoning: "PREDICT_PACKAGE_ID not set — indexer inert.",
    });
  }
  const client = new SuiJsonRpcClient({
    url: getJsonRpcFullnodeUrl(SUI_NETWORK),
    network: SUI_NETWORK,
  });

  let minted = 0;
  let redeemed = 0;
  let orders = 0;
  let cancellations = 0;
  let created = 0;
  let settlements = 0;
  let resolutions = 0;
  try {
    minted = await pollAndApply(
      client,
      `${PREDICT_PACKAGE_ID}::prediction_market::MintedEvent`,
      "position_indexer.minted",
      (ev) => {
        const j = ev.parsedJson as MintedJson;
        if (!j?.market_id || !j?.user) return;
        const yes = Number(j.yes_minted ?? 0);
        const no = Number(j.no_minted ?? 0);
        if (yes <= 0 && no <= 0) return;
        upsertPosition(j.market_id, j.user, yes, no);
      },
    );
  } catch (err) {
    return recordResult("PositionIndexer", {
      action: "index_failed",
      reasoning: `Minted poll failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
  try {
    redeemed = await pollAndApply(
      client,
      `${PREDICT_PACKAGE_ID}::prediction_market::RedeemedEvent`,
      "position_indexer.redeemed",
      (ev) => {
        const j = ev.parsedJson as RedeemedJson;
        if (!j?.market_id || !j?.user) return;
        const burned = Number(j.winning_amount ?? 0);
        if (burned <= 0) return;
        // Both `redeem` and `redeem_no` emit the same RedeemedEvent
        // struct, so the only way to know which side was burned is to
        // look up the market's outcome (set by the resolver via
        // MarketResolvedEvent). Decrement that side; clamp at 0 in
        // case the on-chain mint was missed by this indexer.
        const market = getMarket(j.market_id);
        if (!market || !market.outcome) return;
        const side = market.outcome === "yes" ? "yes" : "no";
        decrementPosition(j.market_id, j.user, side, burned);
      },
    );
  } catch (err) {
    return recordResult("PositionIndexer", {
      action: "index_failed",
      reasoning: `Redeemed poll failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  // OrderPlacedEvent — every user's limit/market order on every
  // DeepBook pool, not just the agent's. Stored in `chain_orders`
  // with the chain's u128 order_id as TEXT (SQLite's INTEGER maxes
  // out well below u128::MAX).
  try {
    orders = await pollAndApply(
      client,
      `${PREDICT_PACKAGE_ID}::prediction_market::OrderPlacedEvent`,
      "position_indexer.order_placed",
      (ev) => {
        const j = ev.parsedJson as OrderPlacedJson;
        if (!j?.market_id || !j?.order_id) return;
        const ts = ev.timestampMs ? Number(ev.timestampMs) : Date.now();
        recordChainOrder({
          market_id: j.market_id,
          order_id: String(j.order_id),
          pool_id: j.pool_id ?? "",
          client_order_id: Number(j.client_order_id ?? 0),
          is_bid: Boolean(j.is_bid),
          price: Number(j.price ?? 0),
          quantity: Number(j.quantity ?? 0),
          timestamp_ms: ts,
        });
      },
    );
  } catch (err) {
    return recordResult("PositionIndexer", {
      action: "index_failed",
      reasoning: `OrderPlaced poll failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  // SettledEvent — fired when a user calls `withdraw_settled` after
  // the pool processes their match. Useful for the agent's settle
  // sweeper and for "recent activity" feeds in the UI.
  try {
    settlements = await pollAndApply(
      client,
      `${PREDICT_PACKAGE_ID}::prediction_market::SettledEvent`,
      "position_indexer.settled",
      (ev) => {
        const j = ev.parsedJson as SettledJson;
        if (!j?.market_id || !j?.trader) return;
        const ts = ev.timestampMs ? Number(ev.timestampMs) : Date.now();
        recordSettlement({
          market_id: j.market_id,
          pool_id: j.pool_id ?? "",
          trader: j.trader,
          timestamp_ms: ts,
        });
      },
    );
  } catch (err) {
    return recordResult("PositionIndexer", {
      action: "index_failed",
      reasoning: `Settled poll failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  // MarketCreatedEvent — fired when any caller (this agent, another
  // agent, or a one-off script) calls `create_market`. Indexing it
  // ensures the REST `/markets` list and `/markets/:id` page see
  // markets the local agent did not create, and that the first-ever
  // market shows up before this agent's MarketCreator tick fires.
  try {
    created = await pollAndApply(
      client,
      `${PREDICT_PACKAGE_ID}::prediction_market::MarketCreatedEvent`,
      "position_indexer.market_created",
      (ev) => {
        const j = ev.parsedJson as MarketCreatedJson;
        if (!j?.market_id) return;
        // Don't clobber a richer row written by the local MarketCreator
        // (which also knows the deepbook pool/referral IDs). Only fill
        // in fields the indexer can see in the event.
        const existing = getMarket(j.market_id);
        upsertMarket({
          id: j.market_id,
          title: existing?.title ?? j.title ?? "",
          description: existing?.description ?? j.description ?? "",
          category: existing?.category ?? j.category ?? "general",
          expiry_ms: existing?.expiry_ms ?? Number(j.expiry_ms ?? 0),
          resolution_source:
            existing?.resolution_source ?? j.resolution_source ?? "",
          status: existing?.status ?? "active",
          pool_id: existing?.pool_id ?? j.pool_id ?? null,
          deepbook_pool_id: existing?.deepbook_pool_id ?? j.pool_id ?? null,
          deepbook_pool_key:
            existing?.deepbook_pool_key ??
            (j.pool_id ? `market_${j.market_id.slice(0, 8)}` : null),
          deepbook_base_coin_type: existing?.deepbook_base_coin_type ?? null,
          deepbook_quote_coin_type: existing?.deepbook_quote_coin_type ?? null,
          deepbook_base_scalar: existing?.deepbook_base_scalar ?? 1_000_000,
          deepbook_quote_scalar: existing?.deepbook_quote_scalar ?? 1_000_000,
          referral_id: existing?.referral_id ?? null,
          created_at_ms: existing?.created_at_ms ?? Date.now(),
        });
      },
    );
  } catch (err) {
    return recordResult("PositionIndexer", {
      action: "index_failed",
      reasoning: `MarketCreated poll failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  // OrderCancelledEvent — fired by `cancel_order` / `cancel_all_orders`.
  // We mark the matching `chain_orders` row cancelled so the UI can
  // drop it from the "open orders" view.
  try {
    cancellations = await pollAndApply(
      client,
      `${PREDICT_PACKAGE_ID}::prediction_market::OrderCancelledEvent`,
      "position_indexer.order_cancelled",
      (ev) => {
        const j = ev.parsedJson as OrderCancelledJson;
        if (!j?.market_id || j?.order_id == null) return;
        const ts = ev.timestampMs ? Number(ev.timestampMs) : Date.now();
        markOrderCancelled(j.market_id, String(j.order_id), ts);
      },
    );
  } catch (err) {
    return recordResult("PositionIndexer", {
      action: "index_failed",
      reasoning: `OrderCancelled poll failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  // MarketResolvedEvent — fired when the resolver/admin calls `resolve_market`.
  // Must run BEFORE RedeemedEvent so `decrementPosition` can look up the
  // winning side. We also poll it after Redeemed below — running it first
  // here is a best-effort to avoid races on the same indexer tick.
  try {
    resolutions = await pollAndApply(
      client,
      `${PREDICT_PACKAGE_ID}::prediction_market::MarketResolvedEvent`,
      "position_indexer.market_resolved",
      (ev) => {
        const j = ev.parsedJson as MarketResolvedJson;
        if (!j?.market_id || j?.outcome == null) return;
        // outcome: 1 = YES, 2 = NO (per Move contract)
        const n = Number(j.outcome);
        if (n !== 1 && n !== 2) return;
        markMarketResolved(j.market_id, n === 1 ? "yes" : "no");
      },
    );
  } catch (err) {
    return recordResult("PositionIndexer", {
      action: "index_failed",
      reasoning: `MarketResolved poll failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  return recordResult("PositionIndexer", {
    action: "index",
    reasoning: `Indexed ${created} created, ${minted} mints, ${redeemed} redeems, ${orders} orders, ${cancellations} cancellations, ${settlements} settlements, ${resolutions} resolutions.`,
    confidence: 100,
  });
}
