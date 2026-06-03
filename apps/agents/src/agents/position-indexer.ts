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
 *   - PrizeClaimed     → → `prize_claims` (backstops the POST /prize/claims
 *                        web notification; converges the off-chain table
 *                        even when the POST fails)
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
  markMarketDisputed,
  markMarketResolved,
  markMarketUndisputed,
  markOrderCancelled,
  recordChainOrder,
  recordRegisteredMarket,
  recordRegistry,
  recordSettlement,
  recordVaultFlow,
  upsertMarket,
  upsertPosition,
} from "../markets/store.js";
import { logPolicyEvent } from "../store.js";
import {
  recordPrizeClaim,
  recordStreakEvent,
  markPoolWeekSettled,
  upsertUserProfile,
  upsertParlayCreated,
  recordParlayLeg,
  recordParlayFinalized,
  recordBadgeMint,
} from "../gamification/store.js";

const SUI_NETWORK = (process.env.SUI_NETWORK ?? "testnet") as
  | "testnet"
  | "mainnet"
  | "devnet"
  | "localnet";
// Read AGENT_POLICY_PACKAGE_ID at call time, not at module load. The
// `bootstrapEnv()` function in index.ts syncs `PREDICT_PACKAGE_ID`
// from this value (legacy alias for the old DeepBook Predict
// contracts), but reading the canonical env directly avoids the
// implicit coupling — a refactor that drops the alias would silently
// break all 20 event subscriptions below.
const POLL_BATCH = 200;

interface EventQuery {
  MoveEventType: string;
}
type EventCursor = Parameters<SuiJsonRpcClient["queryEvents"]>[0]["cursor"];

// On-chain `category` is a u8 (0=none/general, 1=ai_news, 2=crypto_price,
// 3=other) — see prediction_market.move `MarketCreatedEvent`. The
// `markets.category` SQLite column is free text, so map to the
// vocabulary the rest of the system already uses. Used by the
// `MarketCreated` handler below to avoid dropping the on-chain value
// for markets not created by this agent's MarketCreator.
function categoryLabel(code: number): string {
  switch (code) {
    case 1:
      return "ai_news";
    case 2:
      return "crypto_price";
    case 3:
      return "other";
    default:
      return "general";
  }
}

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
  expiry_ms?: string | number;
  pool_id?: string;
  balance_manager_id?: string;
  // `category` was added to the on-chain event in r14 so the
  // streak-sweeper can read the leaderboard topic without consulting
  // the local markets row. Older events (pre-r14 deploys) won't
  // carry it; the sweeper falls back to 0 ("none").
  category?: string | number;
}
interface MarketDisputedJson {
  market_id: string;
  disputer?: string;
  evidence_uri?: string | number[];
  dispute_count?: string | number;
}
interface MarketUndisputedJson {
  market_id: string;
  final_outcome?: string | number;
  resolver?: string;
}
interface PrizeClaimedJson {
  pool_id: string;
  week_index: string | number;
  user: string;
  rank: string | number;
  amount: string | number;
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
  const predictPackageId = process.env.AGENT_POLICY_PACKAGE_ID ?? "";
  if (!predictPackageId) {
    return recordResult("PositionIndexer", {
      action: "skip",
      reasoning: "AGENT_POLICY_PACKAGE_ID not set — indexer inert.",
    });
  }
  // DUSDC_TYPE is the type parameter for the parlay events
  // (parlay::ParlayCreated<0x…::dusdc::DUSDC> etc.). If it's empty,
  // the parlay subscriptions build a `parlay::*<>` filter that never
  // matches any on-chain event, and the cursor still advances —
  // hiding the misconfig in the log. Refuse to run the indexer
  // until DUSDC_TYPE is set, same as the package-id guard above.
  // (The boot validator in src/index.ts also marks DUSDC_TYPE as
  // required, so a fresh deploy will hard-fail there before the
  // indexer ever gets called — this is a defense-in-depth check.)
  const dusdcType = process.env.DUSDC_TYPE ?? "";
  if (!dusdcType) {
    return recordResult("PositionIndexer", {
      action: "skip",
      reasoning: "DUSDC_TYPE not set — parlay event subscriptions would be inert. " +
        "Set DUSDC_TYPE in .env (full type string e.g. 0x…::dusdc::DUSDC).",
    });
  }
  const client = new SuiJsonRpcClient({
    url: getJsonRpcFullnodeUrl(SUI_NETWORK),
    network: SUI_NETWORK,
  });

  // Each event-type poller is independent. A failure on one (e.g. a
  // transient RPC blip on `queryEvents(MarketResolvedEvent)`) must
  // not skip the other 8 pollers — losing a single event type for a
  // tick is recoverable on the next pass; losing all of them because
  // one threw would leave the indexer silently stale for minutes.
  // Each try/catch logs a warning and continues; failures are
  // surfaced in the final reasoning string so the operator can spot
  // a chronically-broken event type in /decisions.
  const failures: string[] = [];
  const guardedPoll = async (
    label: string,
    eventType: string,
    stateKey: string,
    apply: (ev: EventEnvelope) => void,
  ): Promise<number> => {
    try {
      return await pollAndApply(client, eventType, stateKey, apply);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failures.push(`${label}: ${msg.slice(0, 60)}`);
      console.warn(`[position-indexer] ${label} poll failed: ${msg}`);
      return 0;
    }
  };

  const minted = await guardedPoll(
    "Minted",
    `${predictPackageId}::prediction_market::MintedEvent`,
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

  const redeemed = await guardedPoll(
    "Redeemed",
    `${predictPackageId}::prediction_market::RedeemedEvent`,
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

  // MarketResolvedEvent — fired when the resolver/admin calls
  // `resolve_market`. Polled AFTER RedeemedEvent so the most recent
  // resolution cursor is used; the on-chain `RedeemedEvent` always
  // references a market whose resolution has already been emitted
  // (the contract gates `redeem` on `market.resolved == true`).
  // We poll it here — outside the redeem hot path — so the next
  // tick's rede lookups see the outcome.
  //
  // (Earlier versions of this file polled MarketResolvedEvent FIRST
  // and dropped the RedeemedEvent that arrived in the same tick if
  // the resolution wasn't yet seen. That ordering was the wrong
  // direction: redeem-on-resolved-market is the only legal redeem,
  // so the resolution cursor is always ≤ the redeem cursor.)
  const resolutions = await guardedPoll(
    "MarketResolved",
    `${predictPackageId}::prediction_market::MarketResolvedEvent`,
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

  // OrderPlacedEvent — every user's limit/market order on every
  // DeepBook pool, not just the agent's. Stored in `chain_orders`
  // with the chain's u128 order_id as TEXT (SQLite's INTEGER maxes
  // out well below u128::MAX).
  const orders = await guardedPoll(
    "OrderPlaced",
    `${predictPackageId}::prediction_market::OrderPlacedEvent`,
    "position_indexer.order_placed",
    (ev) => {
      const j = ev.parsedJson as OrderPlacedJson;
      if (!j?.market_id || !j?.order_id) return;
      const ts = ev.timestampMs ? Number(ev.timestampMs) : Date.now();
      recordChainOrder({
        market_id: j.market_id,
        order_id: String(j.order_id),
        pool_id: j.pool_id ?? "",
        // Keep the on-chain u64 as a string — JS Number coercion
        // would lose precision above 2^53-1. See chain_orders schema
        // comment in markets/store.ts.
        client_order_id: String(j.client_order_id ?? "0"),
        is_bid: Boolean(j.is_bid),
        price: Number(j.price ?? 0),
        quantity: Number(j.quantity ?? 0),
        timestamp_ms: ts,
      });
    },
  );

  // SettledEvent — fired when a user calls `withdraw_settled` after
  // the pool processes their match. Useful for the agent's settle
  // sweeper and for "recent activity" feeds in the UI.
  const settlements = await guardedPoll(
    "Settled",
    `${predictPackageId}::prediction_market::SettledEvent`,
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

  // MarketCreatedEvent — fired when any caller (this agent, another
  // agent, or a one-off script) calls `create_market`. Indexing it
  // ensures the REST `/markets` list and `/markets/:id` page see
  // markets the local agent did not create, and that the first-ever
  // market shows up before this agent's MarketCreator tick fires.
  const created = await guardedPoll(
    "MarketCreated",
    `${predictPackageId}::prediction_market::MarketCreatedEvent`,
    "position_indexer.market_created",
    (ev) => {
      const j = ev.parsedJson as MarketCreatedJson;
      if (!j?.market_id) return;
      // Don't clobber a richer row written by the local MarketCreator
      // (which also knows the deepbook pool/referral IDs). The on-chain
      // `MarketCreatedEvent` struct (prediction_market.move:182-196)
      // carries {market_id, pool_id, balance_manager_id, title,
      // expiry_ms, creator, category: u8} — description and
      // resolution_source still come from the local MarketCreator
      // row. The on-chain `category` is a u8 (0=none, 1=ai_news,
      // 2=crypto_price, 3=other) added in r14; for markets not
      // created by this agent, falling through to `existing.category`
      // would silently drop the on-chain value to "general".
      const existing = getMarket(j.market_id);
      const onChainCategory = j.category != null ? categoryLabel(Number(j.category)) : null;
      // Prefer the on-chain emission timestamp (always present on
      // Sui events) over the host clock. Host-clock skew would
      // mis-order the leaderboard after the local MarketCreator
      // writes a row first and the indexer races with it.
      const onChainTs = ev.timestampMs ? Number(ev.timestampMs) : 0;
      upsertMarket({
        id: j.market_id,
        title: existing?.title ?? j.title ?? "",
        description: existing?.description ?? "",
        category: existing?.category ?? onChainCategory ?? "general",
        expiry_ms: existing?.expiry_ms ?? Number(j.expiry_ms ?? 0),
        resolution_source: existing?.resolution_source ?? "",
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
        created_at_ms:
          existing?.created_at_ms ?? (onChainTs || Date.now()),
      });
    },
  );

  // OrderCancelledEvent — fired by `cancel_order` / `cancel_all_orders`.
  // We mark the matching `chain_orders` row cancelled so the UI can
  // drop it from the "open orders" view.
  const cancellations = await guardedPoll(
    "OrderCancelled",
    `${predictPackageId}::prediction_market::OrderCancelledEvent`,
    "position_indexer.order_cancelled",
    (ev) => {
      const j = ev.parsedJson as OrderCancelledJson;
      if (!j?.market_id || j?.order_id == null) return;
      const ts = ev.timestampMs ? Number(ev.timestampMs) : Date.now();
      markOrderCancelled(j.market_id, String(j.order_id), ts);
    },
  );

  // OrdersBatchCancelledEvent — fired by `cancel_orders` (the batch
  // path). `cancel_orders` calls `pool::cancel_live_orders`, which
  // already emits per-order `OrderCancelledEvent` for each id, so this
  // handler is **redundant for correctness** — but subscribing keeps
  // the cursor advancing through batch events even if a per-order
  // emission is dropped (Sui node pruning, RPC gap) and gives us a
  // single transaction-level view of bulk cancellations for the audit
  // log. `order_ids` is a `vector<u128>`; the JSON view renders it as
  // either `string[]` or `number[]` depending on value size.
  const batchCancellations = await guardedPoll(
    "OrdersBatchCancelled",
    `${predictPackageId}::prediction_market::OrdersBatchCancelledEvent`,
    "position_indexer.orders_batch_cancelled",
    (ev) => {
      const j = ev.parsedJson as {
        market_id?: string;
        order_ids?: Array<string | number>;
      };
      if (!j?.market_id || !Array.isArray(j.order_ids)) return;
      const ts = ev.timestampMs ? Number(ev.timestampMs) : Date.now();
      for (const id of j.order_ids) {
        markOrderCancelled(j.market_id, String(id), ts);
      }
    },
  );

  // MarketDisputedEvent — fired when a user calls `dispute_market` within
  // the 1-hour post-resolution window. The /markets/:id UI shows a
  // "Disputed" badge and the redeem button is hidden until the dispute
  // resolves. We persist `dispute_count` so the UI can show
  // "Disputed (3)" if multiple users raise the same challenge.
  const disputes = await guardedPoll(
    "MarketDisputed",
    `${predictPackageId}::prediction_market::MarketDisputedEvent`,
    "position_indexer.market_disputed",
    (ev) => {
      const j = ev.parsedJson as MarketDisputedJson;
      if (!j?.market_id) return;
      const ts = ev.timestampMs ? Number(ev.timestampMs) : Date.now();
      const evidence =
        typeof j.evidence_uri === "string"
          ? j.evidence_uri
          : Array.isArray(j.evidence_uri)
            ? String.fromCharCode(...(j.evidence_uri as number[]))
            : "";
      const count = Number(j.dispute_count ?? 1);
      markMarketDisputed(j.market_id, evidence, count, ts);
    },
  );

  // MarketUndisputedEvent — fired when the creator/admin calls
  // `resolve_dispute` to finalize a disputed market. The outcome may
  // differ from the original resolution; we store the override.
  const undisputed = await guardedPoll(
    "MarketUndisputed",
    `${predictPackageId}::prediction_market::MarketUndisputedEvent`,
    "position_indexer.market_undisputed",
    (ev) => {
      const j = ev.parsedJson as MarketUndisputedJson;
      if (!j?.market_id || j?.final_outcome == null) return;
      const n = Number(j.final_outcome);
      if (n !== 1 && n !== 2) return;
      markMarketUndisputed(j.market_id, n === 1 ? "yes" : "no");
    },
  );

  // PrizeClaimed — fired by `prize_pool::claim_prize` whenever any
  // user (web, agent, or scripted) successfully claims. We write to
  // the off-chain `prize_claims` table so `liveRollup`'s `claimed`
  // annotation is correct even when the web's `POST /prize/claims`
  // notification fails (network blip, agents restart mid-tx, etc.).
  //
  // Idempotency: `recordPrizeClaim` is `ON CONFLICT(user, week) DO
  // UPDATE`, so a successful POST plus a successful indexer poll for
  // the same on-chain event both leave the same row. We do NOT
  // short-circuit on `getPrizeClaim(j.user, weekIndex)` because the
  // web POST can have written a stale amount (e.g. before
  // PRIZE_WEEKLY_AMOUNT was updated server-side) that the on-chain
  // event now corrects. Skipping the indexer write would let the
  // wrong amount persist forever.
  const prizeClaims = await guardedPoll(
    "PrizeClaimed",
    `${predictPackageId}::prize_pool::PrizeClaimed`,
    "position_indexer.prize_claimed",
    (ev) => {
      const j = ev.parsedJson as PrizeClaimedJson;
      if (!j?.user || j.week_index == null || j.rank == null) return;
      const weekIndex = Number(j.week_index);
      if (!Number.isFinite(weekIndex) || weekIndex < 0) return;
      const ts = ev.timestampMs ? Number(ev.timestampMs) : Date.now();
      recordPrizeClaim({
        user: j.user,
        week_index: weekIndex,
        rank: Number(j.rank),
        amount: Number(j.amount ?? 0),
        tx_digest: ev.id?.txDigest ?? null,
        claimed_at_ms: ts,
        // R33 audit fix: surface the source pool from the on-chain
        // `PrizeClaimed { pool_id, ... }` event so the off-chain
        // mirror preserves the multi-pool attribution.
        pool_id: j.pool_id ?? null,
      });
    },
  );

  // StreakUpdated / StreakBroken / MilestoneReached — fired by
  // `streak_system::record_participation`. Before r15 these were
  // unsubscribed, so the streak UI's activity feed was always empty
  // and milestones (3d / 7d / 14d / 30d / 100d) silently passed. We
  // log to `streak_events` (idempotent on user+kind+day_index) so
  // the leaderboard can show the user's history and the operator
  // dashboard can spot a stuck sweep.
  const streakUpdated = await guardedPoll(
    "StreakUpdated",
    `${predictPackageId}::streak_system::StreakUpdated`,
    "position_indexer.streak_updated",
    (ev) => {
      const j = ev.parsedJson as {
        user?: string;
        new_streak?: string | number;
        longest_streak?: string | number;
        multiplier_tier?: string | number;
        day_index?: string | number;
      };
      if (!j?.user || j.day_index == null) return;
      const ts = ev.timestampMs ? Number(ev.timestampMs) : Date.now();
      recordStreakEvent({
        user: j.user,
        kind: "updated",
        new_streak: Number(j.new_streak ?? 0),
        longest_streak: Number(j.longest_streak ?? 0),
        multiplier_tier: Number(j.multiplier_tier ?? 0),
        day_index: Number(j.day_index),
        ts_ms: ts,
      });
    },
  );

  const streakBroken = await guardedPoll(
    "StreakBroken",
    `${predictPackageId}::streak_system::StreakBroken`,
    "position_indexer.streak_broken",
    (ev) => {
      const j = ev.parsedJson as {
        user?: string;
        final_streak?: string | number;
        day_index?: string | number;
      };
      if (!j?.user || j.day_index == null) return;
      const ts = ev.timestampMs ? Number(ev.timestampMs) : Date.now();
      recordStreakEvent({
        user: j.user,
        kind: "broken",
        final_streak: Number(j.final_streak ?? 0),
        day_index: Number(j.day_index),
        ts_ms: ts,
      });
    },
  );

  const milestoneReached = await guardedPoll(
    "MilestoneReached",
    `${predictPackageId}::streak_system::MilestoneReached`,
    "position_indexer.milestone_reached",
    (ev) => {
      const j = ev.parsedJson as {
        user?: string;
        milestone?: string | number;
        day_index?: string | number;
      };
      if (!j?.user || j.day_index == null) return;
      const ts = ev.timestampMs ? Number(ev.timestampMs) : Date.now();
      recordStreakEvent({
        user: j.user,
        kind: "milestone",
        milestone: Number(j.milestone ?? 0),
        day_index: Number(j.day_index),
        ts_ms: ts,
      });
    },
  );

  // PoolSettled — fired by `prize_pool::settle_week` when the admin
  // closes a week. After this, the leaderboard should mark any
  // unclaimed top-10 entry as "lost the prize". Without this
  // subscription the leaderboard kept offering claim txns for a
  // closed week, and the on-chain `claim_prize` would abort with
  // `EPoolSettled` (a confusing UX).
  const poolSettled = await guardedPoll(
    "PoolSettled",
    `${predictPackageId}::prize_pool::PoolSettled`,
    "position_indexer.pool_settled",
    (ev) => {
      const j = ev.parsedJson as {
        pool_id?: string;
        week_index?: string | number;
      };
      if (!j?.pool_id || j.week_index == null) return;
      const ts = ev.timestampMs ? Number(ev.timestampMs) : Date.now();
      markPoolWeekSettled(j.pool_id, Number(j.week_index), ts);
    },
  );

  // PrizePoolFunded — informational. Anyone can call `fund_pool` to
  // top up the prize. We log it for the activity feed so the
  // leaderboard page can display "Sponsored by <funder>" or similar.
  // No business logic depends on this row.
  const prizePoolFunded = await guardedPoll(
    "PrizePoolFunded",
    `${predictPackageId}::prize_pool::PrizePoolFunded`,
    "position_indexer.prize_pool_funded",
    (_ev) => {
      // No-op: we don't have a sponsor-feed table yet, but the poll
      // confirms the subscription is healthy and bumps the cursor.
      // When a sponsor feed ships, write to it here.
    },
  );

  // VaultCreated / Deposited / Withdrawn / Allocated / Deallocated —
  // fired by `vault.move`. The /vault page reads the live summary
  // directly from the SDK, so these subscriptions are for the
  // activity feed only. They keep the indexer cursor advancing
  // through vault events so a future re-poll doesn't re-fetch the
  // entire history.
  const vaultCreated = await guardedPoll(
    "VaultCreated",
    `${predictPackageId}::vault::VaultCreated`,
    "position_indexer.vault_created",
    (ev) => {
      const j = ev.parsedJson as { vault_id?: string; admin?: string };
      if (!j?.vault_id) return;
      const ts = ev.timestampMs ? Number(ev.timestampMs) : Date.now();
      recordVaultFlow({
        vault_id: j.vault_id,
        kind: "created",
        actor: j.admin ?? undefined,
        ts_ms: ts,
      });
    },
  );

  const vaultDeposited = await guardedPoll(
    "VaultDeposited",
    `${predictPackageId}::vault::Deposited`,
    "position_indexer.vault_deposited",
    (ev) => {
      const j = ev.parsedJson as {
        vault_id?: string;
        user?: string;
        amount?: string | number;
        vlp_minted?: string | number;
      };
      if (!j?.vault_id) return;
      const ts = ev.timestampMs ? Number(ev.timestampMs) : Date.now();
      recordVaultFlow({
        vault_id: j.vault_id,
        kind: "deposit",
        actor: j.user ?? undefined,
        amount: Number(j.amount ?? 0),
        vlp_delta: Number(j.vlp_minted ?? 0),
        ts_ms: ts,
      });
    },
  );

  const vaultWithdrawn = await guardedPoll(
    "VaultWithdrawn",
    `${predictPackageId}::vault::Withdrawn`,
    "position_indexer.vault_withdrawn",
    (ev) => {
      const j = ev.parsedJson as {
        vault_id?: string;
        user?: string;
        amount?: string | number;
        vlp_burned?: string | number;
      };
      if (!j?.vault_id) return;
      const ts = ev.timestampMs ? Number(ev.timestampMs) : Date.now();
      recordVaultFlow({
        vault_id: j.vault_id,
        kind: "withdraw",
        actor: j.user ?? undefined,
        amount: Number(j.amount ?? 0),
        vlp_delta: -Number(j.vlp_burned ?? 0),
        ts_ms: ts,
      });
    },
  );

  const vaultAllocated = await guardedPoll(
    "VaultAllocated",
    `${predictPackageId}::vault::Allocated`,
    "position_indexer.vault_allocated",
    (ev) => {
      const j = ev.parsedJson as {
        vault_id?: string;
        amount?: string | number;
        total_allocated?: string | number;
      };
      if (!j?.vault_id) return;
      const ts = ev.timestampMs ? Number(ev.timestampMs) : Date.now();
      recordVaultFlow({
        vault_id: j.vault_id,
        kind: "allocate",
        amount: Number(j.amount ?? 0),
        total_allocated: Number(j.total_allocated ?? 0),
        ts_ms: ts,
      });
    },
  );

  const vaultDeallocated = await guardedPoll(
    "VaultDeallocated",
    `${predictPackageId}::vault::Deallocated`,
    "position_indexer.vault_deallocated",
    (ev) => {
      const j = ev.parsedJson as {
        vault_id?: string;
        amount?: string | number;
        total_allocated?: string | number;
      };
      if (!j?.vault_id) return;
      const ts = ev.timestampMs ? Number(ev.timestampMs) : Date.now();
      recordVaultFlow({
        vault_id: j.vault_id,
        kind: "deallocate",
        amount: Number(j.amount ?? 0),
        total_allocated: Number(j.total_allocated ?? 0),
        ts_ms: ts,
      });
    },
  );

  // FeesWithdrawnEvent — admin sweeps accumulated fees from
  // FeeVault<Q>. Emitted by prediction_market::withdraw_fees. The
  // vault_flows table already accepts a `withdraw` kind; the
  // "vault_id" is the FeeVault's id and "actor" is the admin
  // (a different address from the user's deposit/withdraw actor
  // recorded against the regular Vault).
  const feesWithdrawn = await guardedPoll(
    "FeesWithdrawn",
    `${predictPackageId}::prediction_market::FeesWithdrawnEvent`,
    "position_indexer.fees_withdrawn",
    (ev) => {
      const j = ev.parsedJson as {
        admin?: string;
        amount?: string | number;
      };
      if (!j?.admin || j?.amount == null) return;
      const vaultId = process.env.FEE_VAULT_ID ?? "";
      if (!vaultId) return;
      const ts = ev.timestampMs ? Number(ev.timestampMs) : Date.now();
      recordVaultFlow({
        vault_id: vaultId,
        kind: "withdraw",
        actor: j.admin,
        amount: Number(j.amount),
        ts_ms: ts,
      });
    },
  );

  // AgentActionEvent — fired by agent_policy.move's `authorize_spend`
  // and `log_action`. The on-chain stream is the only audit trail of
  // who spent what under which policy, so risk-monitor alerting and
  // future compliance queries need it indexed. The round-17 audit
  // flagged this as a coverage gap (finding #4).
  const agentActions = await guardedPoll(
    "AgentAction",
    `${predictPackageId}::agent_policy::AgentActionEvent`,
    "position_indexer.agent_action",
    (ev) => {
      // No DB write yet — this advances the cursor and prepares the
      // hook for a future risk-monitor log table. The decision log
      // is enough surface for now.
      const j = ev.parsedJson as { agent?: string; action?: string };
      if (!j?.agent) return;
    },
  );

  // PolicyCreated / PolicyRevoked / PolicyPaused — fired by
  // agent_policy.move's `create_policy`, `revoke`, and `pause` /
  // `unpause`. Round-26 audit finding C2: an operator revoking or
  // pausing a policy in an emergency had no off-chain mirror;
  // future /admin or compliance pages would have to scan the RPC
  // for these events. Each event appends a row to the
  // `policy_events` table keyed on (policy_id, tx_digest, event_type)
  // so re-runs are idempotent and the cursor advances even if the
  // insert no-ops.
  const policyLifecycle = [
    {
      name: "PolicyCreated",
      type: "created" as const,
      cursor: "position_indexer.policy_created",
    },
    {
      name: "PolicyRevoked",
      type: "revoked" as const,
      cursor: "position_indexer.policy_revoked",
    },
    {
      name: "PolicyPaused",
      type: "paused" as const,
      cursor: "position_indexer.policy_paused",
    },
  ];
  for (const sub of policyLifecycle) {
    await guardedPoll(
      sub.name,
      `${predictPackageId}::agent_policy::${sub.name}`,
      sub.cursor,
      (ev) => {
        // On-chain payload:
        //   PolicyCreated { policy_id, owner, agent, max_budget, expires_at }
        //   PolicyRevoked { policy_id, owner }
        //   PolicyPaused  { policy_id, paused }    <-- no owner field
        // The actor field is `owner` for created/revoked; for
        // `paused` the same `paused: bool` discriminates pause vs
        // unpause (the same event type is emitted by both), and the
        // Move struct intentionally does not carry the actor — the
        // policy's owner can rotate via a follow-up tx and is not
        // meaningful for an audit row anchored to the event itself.
        // R33 audit fix: previously the indexer read `j.owner` for
        // paused events too, which is always `undefined` and yielded
        // an always-empty `actor` column for every pause/unpause.
        // We now leave actor empty for paused and add a comment
        // noting the on-chain limitation; a future Move change to
        // include the sender on the event would unlock attribution.
        const j = ev.parsedJson as {
          policy_id?: string;
          owner?: string;
          agent?: string;
          paused?: boolean;
        };
        if (!j?.policy_id) return;
        const details: Record<string, unknown> = {};
        if (j.owner) details.owner = j.owner;
        if (j.agent) details.agent = j.agent;
        if (sub.type === "paused") {
          // Distinguish pause from unpause in the audit row.
          details.paused = !!j.paused;
        }
        try {
          logPolicyEvent({
            policyId: j.policy_id,
            eventType: sub.type,
            actor: sub.type === "paused" ? "" : (j.owner ?? ""),
            tsMs: Number(ev.timestampMs ?? Date.now()),
            txDigest: ev.id?.txDigest ?? "",
            details: JSON.stringify(details),
          });
        } catch (e) {
          // Don't let a DB write failure (disk full, schema drift)
          // stop the indexer — the cursor still advances via
          // `guardedPoll`, so a future tick will retry and either
          // succeed (transient) or skip past (permanent). Log
          // loudly so the operator notices.
          console.warn(
            `[position-indexer] policy_events insert failed for ${sub.name} ${j.policy_id}: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      },
    );
  }

  // ReferralSetEvent — fired by prediction_market::setup_referral.
  // The referral-keeper can verify its own writes against this on-chain
  // event (round-17 audit finding #4). The on-chain
  // `ReferralSetEvent.referral_id: ID` is the shared object the
  // keeper reads at sweep time.
  const referralSet = await guardedPoll(
    "ReferralSet",
    `${predictPackageId}::prediction_market::ReferralSetEvent`,
    "position_indexer.referral_set",
    (ev) => {
      const j = ev.parsedJson as {
        market_id?: string;
        referral_id?: string;
      };
      if (!j?.market_id || !j?.referral_id) return;
    },
  );

  // RegistryCreated / MarketRegistered — one-time bootstrap events
  // from registry.move. They fire once at registry init / per market
  // register, so the volume is negligible. Subscribing keeps the
  // indexer cursor consistent across the published event surface and
  // populates the `registries` and `registered_markets` tables that
  // the admin dashboard reads to show registry state and the
  // registered-market index without an on-chain round-trip.
  //
  // The Move structs are:
  //   struct RegistryCreated  { registry_id: ID, admin: address }
  //   struct MarketRegistered { market_id: ID, market_index: u64 }
  // Field names must match these exactly — the old handler read
  // `registry_id` off MarketRegistered (which has no such field) and
  // silently dropped every event; that bug was the H1 audit finding.
  const registryCreated = await guardedPoll(
    "RegistryCreated",
    `${predictPackageId}::registry::RegistryCreated`,
    "position_indexer.registry_created",
    (ev) => {
      const j = ev.parsedJson as { registry_id?: string; admin?: string };
      if (!j?.registry_id || !j?.admin) return;
      recordRegistry({
        id: j.registry_id,
        admin: j.admin,
        ts_ms: ev.timestampMs ? Number(ev.timestampMs) : Date.now(),
      });
    },
  );

  const marketRegistered = await guardedPoll(
    "MarketRegistered",
    `${predictPackageId}::registry::MarketRegistered`,
    "position_indexer.market_registered",
    (ev) => {
      const j = ev.parsedJson as {
        market_id?: string;
        market_index?: string | number;
      };
      if (!j?.market_id || j?.market_index == null) return;
      const idx =
        typeof j.market_index === "string"
          ? parseInt(j.market_index, 10)
          : j.market_index;
      if (!Number.isFinite(idx)) return;
      recordRegisteredMarket({
        market_id: j.market_id,
        market_index: idx,
        ts_ms: ev.timestampMs ? Number(ev.timestampMs) : Date.now(),
      });
    },
  );

  // UserProfile events — fired by `user_profile::create_profile`,
  // `set_country_code`, and `set_forecaster_kind`. The mirror into
  // `user_profiles` powers the national leaderboard (per-country
  // ranking) and the AI/bot forecaster sub-leaderboards. Without
  // these subscriptions the `/leaderboard/country` endpoint would
  // return an empty result set for every country. Idempotent via
  // `upsertUserProfile`'s `ON CONFLICT DO UPDATE` — re-polling the
  // same event after a restart does not duplicate the row.
  //
  // The Move event field types are: `user: address` (string),
  // `country_code: vector<u8>` (base64 in the JSON-RPC payload —
  // Sui's event decoder renders byte vectors as base64 strings by
  // default; the SDK doesn't auto-decode), and `forecaster_kind: u8`
  // (number). We accept the base64 string as-is and lowercase it
  // downstream if needed; the on-chain module already enforces the
  // byte-length cap.
  const profileCreated = await guardedPoll(
    "ProfileCreated",
    `${predictPackageId}::user_profile::ProfileCreated`,
    "position_indexer.profile_created",
    (ev) => {
      const j = ev.parsedJson as {
        user?: string;
        profile_id?: string;
      };
      if (!j?.user) return;
      const ts = ev.timestampMs ? Number(ev.timestampMs) : Date.now();
      // Brand-new profile: country_code and forecaster_kind default
      // to empty / 0 (set later via the dedicated events). The
      // `upsert` preserves the existing row if the events arrive out
      // of order — defensive against a `CountryCodeSet` event that
      // somehow beat the matching `ProfileCreated` (shouldn't
      // happen on chain, but the indexer can't assume it never does).
      upsertUserProfile({
        user: j.user,
        country_code: "",
        forecaster_kind: 0,
        updated_at_ms: ts,
      });
    },
  );

  const countryCodeSet = await guardedPoll(
    "CountryCodeSet",
    `${predictPackageId}::user_profile::CountryCodeSet`,
    "position_indexer.country_code_set",
    (ev) => {
      const j = ev.parsedJson as {
        user?: string;
        country_code?: string;
      };
      if (!j?.user) return;
      const ts = ev.timestampMs ? Number(ev.timestampMs) : Date.now();
      // The on-chain module is byte-typed; the JSON-RPC event
      // payload renders `vector<u8>` as a base64 string. We accept
      // it as-is — the downstream `countryRollup` matcher
      // lowercases its argument before comparing, so the mirror
      // stays consistent with what a user typed in lowercase.
      // An empty value clears the country (per the on-chain
      // contract), so we write it through verbatim.
      upsertUserProfile({
        user: j.user,
        country_code: j.country_code ?? "",
        updated_at_ms: ts,
      });
    },
  );

  const forecasterKindSet = await guardedPoll(
    "ForecasterKindSet",
    `${predictPackageId}::user_profile::ForecasterKindSet`,
    "position_indexer.forecaster_kind_set",
    (ev) => {
      const j = ev.parsedJson as {
        user?: string;
        forecaster_kind?: string | number;
      };
      if (!j?.user) return;
      const ts = ev.timestampMs ? Number(ev.timestampMs) : Date.now();
      upsertUserProfile({
        user: j.user,
        forecaster_kind: Number(j.forecaster_kind ?? 0),
        updated_at_ms: ts,
      });
    },
  );

  // Parlay events — the `parlay` module emits three events that we
  // mirror into the `parlays` table so the web `/parlay` page can
  // show leg progress without a per-user RPC read.
  //
  // The on-chain `parlay` module is generic over the collateral
  // type Q (parameterised as the dUSDC type in production). The
  // event types include the type parameter at the end of the name:
  //   `parlay::ParlayCreated<0x...::dusdc::DUSDC>`
  // Sui's `queryEvents` filter is exact-match, so we have to
  // interpolate the dUSDC type into the subscription string. The
  // on-chain module's `parlay::create_pool` etc. are all generic,
  // so a single subscription covers every collateral variant.
  const DUSDC_TYPE = process.env.DUSDC_TYPE ?? "";
  const parlayType = (eventName: string) =>
    `${predictPackageId}::parlay::${eventName}<${DUSDC_TYPE}>`;

  const parlayCreated = await guardedPoll(
    "ParlayCreated",
    parlayType("ParlayCreated"),
    "position_indexer.parlay_created",
    (ev) => {
      const j = ev.parsedJson as {
        parlay_id?: string;
        pool_id?: string;
        user?: string;
        collateral?: string | number;
        leg_count?: string | number;
        payout_bps?: string | number;
      };
      if (!j?.parlay_id || !j?.user) return;
      const ts = ev.timestampMs ? Number(ev.timestampMs) : Date.now();
      upsertParlayCreated({
        parlay_id: j.parlay_id,
        pool_id: j.pool_id ?? "",
        user: j.user,
        collateral_amount: Number(j.collateral ?? 0),
        leg_count: Number(j.leg_count ?? 0),
        payout_bps: Number(j.payout_bps ?? 0),
        created_at_ms: ts,
      });
    },
  );

  const parlayLegRecorded = await guardedPoll(
    "ParlayLegRecorded",
    parlayType("ParlayLegRecorded"),
    "position_indexer.parlay_leg_recorded",
    (ev) => {
      const j = ev.parsedJson as {
        parlay_id?: string;
        leg_index?: string | number;
        won?: boolean;
      };
      if (!j?.parlay_id) return;
      const ts = ev.timestampMs ? Number(ev.timestampMs) : Date.now();
      recordParlayLeg({
        parlay_id: j.parlay_id,
        leg_index: Number(j.leg_index ?? 0),
        won: j.won === true,
        ts_ms: ts,
      });
    },
  );

  const parlayFinalized = await guardedPoll(
    "ParlayFinalized",
    parlayType("ParlayFinalized"),
    "position_indexer.parlay_finalized",
    (ev) => {
      const j = ev.parsedJson as {
        parlay_id?: string;
        won?: boolean;
        payout?: string | number;
      };
      if (!j?.parlay_id) return;
      const ts = ev.timestampMs ? Number(ev.timestampMs) : Date.now();
      recordParlayFinalized({
        parlay_id: j.parlay_id,
        won: j.won === true,
        payout: Number(j.payout ?? 0),
        ts_ms: ts,
      });
    },
  );

  // BadgeMinted - emitted by badge_nft::mint_badge and
  // mint_badge_to_kiosk. The streak page reads from
  // streak_badges via the agents /streak/badges/:addr endpoint to
  // show which tiers a user owns. Without this subscription a
  // freshly-minted badge would not appear in the UI until the user
  // manually refetched the on-chain object list.
  const badgeMinted = await guardedPoll(
    "BadgeMinted",
    `${predictPackageId}::badge_nft::BadgeMinted`,
    "position_indexer.badge_minted",
    (ev) => {
      const j = ev.parsedJson as {
        user?: string;
        tier?: string | number;
        badge_id?: string;
        longest_streak_at_mint?: string | number;
        minted_at_ms?: string | number;
      };
      if (!j?.user || !j?.badge_id) return;
      recordBadgeMint({
        badge_id: j.badge_id,
        user: j.user,
        tier: Number(j.tier ?? 0),
        longest_streak_at_mint: Number(j.longest_streak_at_mint ?? 0),
        minted_at_ms: Number(j.minted_at_ms ?? Date.now()),
      });
    },
  );

  // PoolFunded - emitted by `parlay::fund_pool`. Anyone can call this
  // to top up the parlay pool (used by the protocol seed at bootstrap
  // and by partner donations). The on-chain event includes the dUSDC
  // type parameter (the parlay module is generic), so the subscription
  // string is the same shape as the other parlay event subscriptions.
  // Currently informational: the poll keeps the cursor advancing and
  // the /parlay page can later surface "Sponsored by <funder>" if a
  // sponsor-feed table ships.
  const parlayPoolFunded = await guardedPoll(
    "PoolFunded",
    parlayType("PoolFunded"),
    "position_indexer.parlay_pool_funded",
    (_ev) => {
      // No-op for now (see prizePoolFunded above).
    },
  );

  // BadgePlacedInKiosk - emitted by `badge_nft::mint_badge_to_kiosk`
  // (the kiosk variant of badge minting). Distinct from BadgeMinted
  // which fires for both the wallet and kiosk paths. We don't have a
  // dedicated kiosk column on `streak_badges` yet, so we just bump
  // the cursor — the badge is already in the user's wallet via
  // transfer::public_transfer and the /streak/badges/:addr endpoint
  // will surface it through the BadgeMinted row. The poll exists so
  // a re-indexer run doesn't re-fetch the entire badge history.
  const badgePlacedInKiosk = await guardedPoll(
    "BadgePlacedInKiosk",
    `${predictPackageId}::badge_nft::BadgePlacedInKiosk`,
    "position_indexer.badge_placed_in_kiosk",
    (_ev) => {
      // No-op — see comment above.
    },
  );

  const summary = `Indexed ${created} created, ${minted} mints, ${redeemed} redeems, ${orders} orders, ${cancellations} cancellations, ${settlements} settlements, ${resolutions} resolutions, ${disputes} disputes, ${undisputed} undisputed, ${prizeClaims} prize claims, ${streakUpdated} streak updates, ${streakBroken} streak breaks, ${milestoneReached} milestones, ${poolSettled} pool settlements, ${prizePoolFunded} pool funds, ${vaultCreated} vault created, ${vaultDeposited} vault deposits, ${vaultWithdrawn} vault withdraws, ${vaultAllocated} vault allocations, ${vaultDeallocated} vault deallocations, ${agentActions} agent actions, ${referralSet} referral sets, ${registryCreated} registry created, ${marketRegistered} market registered, ${profileCreated} profiles created, ${countryCodeSet} country codes set, ${forecasterKindSet} forecaster kinds set, ${parlayCreated} parlays created, ${parlayLegRecorded} parlay legs recorded, ${parlayFinalized} parlays finalized, ${badgeMinted} badges minted, ${parlayPoolFunded} parlay pool funds, ${badgePlacedInKiosk} badges placed in kiosks.`;
  return recordResult("PositionIndexer", {
    action: failures.length > 0 ? "index_partial" : "index",
    reasoning:
      failures.length > 0
        ? `${summary} Skipped: ${failures.join("; ")}`
        : summary,
    confidence: failures.length > 0 ? 70 : 100,
  });
}
