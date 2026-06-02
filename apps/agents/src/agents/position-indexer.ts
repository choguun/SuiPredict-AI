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
  recordSettlement,
  recordVaultFlow,
  upsertMarket,
  upsertPosition,
} from "../markets/store.js";
import {
  recordPrizeClaim,
  recordStreakEvent,
  markPoolWeekSettled,
} from "../gamification/store.js";

const SUI_NETWORK = (process.env.SUI_NETWORK ?? "testnet") as
  | "testnet"
  | "mainnet"
  | "devnet"
  | "localnet";
// Read PREDICT_PACKAGE_ID at call time, not at module load. The
// `bootstrapEnv()` function in index.ts syncs this from
// AGENT_POLICY_PACKAGE_ID *after* the module graph has already been
// evaluated, so a top-level `const` here captures the empty string
// even when AGENT_POLICY_PACKAGE_ID is set. Pulling it inside the
// exported function lets bootstrapEnv's write to process.env take
// effect on the first tick.
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
  const predictPackageId = process.env.PREDICT_PACKAGE_ID ?? "";
  if (!predictPackageId) {
    return recordResult("PositionIndexer", {
      action: "skip",
      reasoning: "PREDICT_PACKAGE_ID not set — indexer inert.",
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
        client_order_id: Number(j.client_order_id ?? 0),
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
      // (which also knows the deepbook pool/referral IDs). Only fill
      // in fields the indexer can see in the event — the on-chain
      // MarketCreatedEvent struct (prediction_market.move:171-178)
      // only carries {market_id, pool_id, balance_manager_id, title,
      // expiry_ms, creator}. The description / category /
      // resolution_source come from the local MarketCreator row, so
      // we deliberately fall through to `existing` for those.
      const existing = getMarket(j.market_id);
      upsertMarket({
        id: j.market_id,
        title: existing?.title ?? j.title ?? "",
        description: existing?.description ?? "",
        category: existing?.category ?? "general",
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
        created_at_ms: existing?.created_at_ms ?? Date.now(),
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
        actor: j.admin ?? null,
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
        actor: j.user ?? null,
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
        actor: j.user ?? null,
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

  const summary = `Indexed ${created} created, ${minted} mints, ${redeemed} redeems, ${orders} orders, ${cancellations} cancellations, ${settlements} settlements, ${resolutions} resolutions, ${disputes} disputes, ${undisputed} undisputed, ${prizeClaims} prize claims, ${streakUpdated} streak updates, ${streakBroken} streak breaks, ${milestoneReached} milestones, ${poolSettled} pool settlements, ${prizePoolFunded} pool funds, ${vaultCreated} vault created, ${vaultDeposited} vault deposits, ${vaultWithdrawn} vault withdraws, ${vaultAllocated} vault allocations, ${vaultDeallocated} vault deallocations.`;
  return recordResult("PositionIndexer", {
    action: failures.length > 0 ? "index_partial" : "index",
    reasoning:
      failures.length > 0
        ? `${summary} Skipped: ${failures.join("; ")}`
        : summary,
    confidence: failures.length > 0 ? 70 : 100,
  });
}
