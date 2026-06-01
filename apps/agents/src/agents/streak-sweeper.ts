/**
 * Streak sweeper — 00:02 UTC daily cron.
 *
 * Iterates the (user, day_index) pairs that the on-chain market resolution
 * touched, looks up each user's outcome (AllCorrect / SomeWrong /
 * NotSubmitted), and either:
 *   - Lazy-creates their `UserStreak` and calls `record_participation` in
 *     a single PTB (first-time users), or
 *   - Calls `record_participation` only.
 *
 * PTBs are batched at 20 users per transaction (Sui limit). Sweep is
 * idempotent: the on-chain `EAlreadyRecordedToday` abort simply skips
 * that user on retry.
 */
import { Transaction } from "@mysten/sui/transactions";
import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";
import { AGENT_POLICY_PACKAGE_ID, CLOCK_OBJECT_ID } from "@suipredict/sdk";
import {
  createClient,
  executeTransaction,
  streakIdForUser,
} from "@suipredict/sdk";
import type { AgentContext, AgentResult } from "../lib.js";
import { recordResult } from "../lib.js";
import { recordDailyScore, dayIndexFor } from "../gamification/store.js";
import { getPosition } from "../markets/store.js";

const PTB_BATCH = 20;

const STREAK_REGISTRY_ID = process.env.STREAK_REGISTRY_ID ?? "";
const STREAK_ADMIN_ID = process.env.STREAK_ADMIN_ID ?? "";
const SUI_NETWORK = (process.env.SUI_NETWORK ?? "testnet") as
  | "testnet"
  | "mainnet"
  | "devnet"
  | "localnet";

const OUTCOME_NOT_SUBMITTED = 0;
const OUTCOME_ALL_CORRECT = 1;
const OUTCOME_SOME_WRONG = 2;
const DAY_MS = 86_400_000;

interface ResolvedUser {
  user: string;
  outcome: 0 | 1 | 2; // 0=NotSubmitted, 1=AllCorrect, 2=SomeWrong
  category: 0 | 1 | 2 | 3;
  streakId?: string; // looked up off-chain; undefined = needs lazy create
}

interface EventQuery {
  MoveEventType: string;
}

type EventPageCursor = Parameters<SuiJsonRpcClient["queryEvents"]>[0]["cursor"];

async function queryAllEvents(
  client: SuiJsonRpcClient,
  query: EventQuery,
): Promise<unknown[]> {
  const out: unknown[] = [];
  let cursor: EventPageCursor = null;
  do {
    const page = await client.queryEvents({
      query,
      cursor,
      limit: 1000,
      order: "ascending",
    });
    out.push(...page.data);
    cursor = page.nextCursor ?? null;
  } while (cursor);
  return out;
}

/**
 * Compute the resolved outcomes for `dayIndex`.
 *
 * Strategy (off-chain indexer, JSON-RPC):
 *   1. Pull all `MarketCreatedEvent`s; the daily markets for `dayIndex`
 *      are those whose `expiry_ms` falls in [day_start, day_end).
 *   2. Pull all `MarketResolvedEvent`s and build a map of resolved
 *      outcomes for the daily markets.
 *   3. Pull all `MintedEvent`s for the daily markets whose timestamp
 *      falls in the day window, and group by user.
 *   4. For each user, the outcome is:
 *        - AllCorrect   — minted on every daily market AND every market
 *                         is resolved (MVP proxy; direction-aware check
 *                         requires reading the user's YES/NO balance
 *                         which is left as a TODO for v2)
 *        - SomeWrong    — minted on at least one daily market, but not
 *                         all of them are resolved
 *
 * Note: this impl currently emits only users who minted that day. A
 * full implementation would also walk the `StreakRegistry` and emit
 * `NotSubmitted` for users who had a streak but didn't mint. That's
 * left as a TODO below; the off-chain `daily_scores` table is the
 * source of truth for the leaderboard, so the missing NotSubmitted
 * cases only affect the on-chain streak number, not the score.
 */
export async function resolveDayOutcomes(
  dayIndex: number,
): Promise<ResolvedUser[]> {
  if (!AGENT_POLICY_PACKAGE_ID) return [];
  const client = new SuiJsonRpcClient({
    url: getJsonRpcFullnodeUrl(SUI_NETWORK),
    network: SUI_NETWORK,
  });
  const dayStartMs = dayIndex * DAY_MS;
  const dayEndMs = dayStartMs + DAY_MS;

  // 1. Daily markets
  const createdRaw = await queryAllEvents(client, {
    MoveEventType: `${AGENT_POLICY_PACKAGE_ID}::prediction_market::MarketCreatedEvent`,
  });
  const dailyMarketIds = new Set<string>();
  for (const e of createdRaw) {
    const ev = e as { parsedJson: { market_id?: string; expiry_ms?: string | number } };
    const expiry = Number(ev.parsedJson.expiry_ms ?? 0);
    const id = ev.parsedJson.market_id;
    if (id && expiry >= dayStartMs && expiry < dayEndMs) {
      dailyMarketIds.add(id);
    }
  }
  if (dailyMarketIds.size === 0) return [];

  // 2. Resolutions for daily markets
  const resolvedRaw = await queryAllEvents(client, {
    MoveEventType: `${AGENT_POLICY_PACKAGE_ID}::prediction_market::MarketResolvedEvent`,
  });
  const resolvedMap = new Map<string, 1 | 2>();
  for (const e of resolvedRaw) {
    const ev = e as { parsedJson: { market_id?: string; outcome?: number } };
    const id = ev.parsedJson.market_id;
    const outcome = ev.parsedJson.outcome;
    if (id && outcome && dailyMarketIds.has(id)) {
      resolvedMap.set(id, outcome as 1 | 2);
    }
  }

  // 3. Mints on daily markets within the day window
  const mintedRaw = await queryAllEvents(client, {
    MoveEventType: `${AGENT_POLICY_PACKAGE_ID}::prediction_market::MintedEvent`,
  });
  const userMarkets = new Map<string, Set<string>>();
  for (const e of mintedRaw) {
    const ev = e as {
      timestampMs?: string | null;
      parsedJson: {
        market_id?: string;
        user?: string;
        yes_minted?: string | number;
        no_minted?: string | number;
      };
    };
    const id = ev.parsedJson.market_id;
    const user = ev.parsedJson.user;
    if (!id || !user || !dailyMarketIds.has(id)) continue;
    const ts = Number(ev.timestampMs ?? 0);
    if (ts < dayStartMs || ts >= dayEndMs) continue;
    const yes = Number(ev.parsedJson.yes_minted ?? 0);
    const no = Number(ev.parsedJson.no_minted ?? 0);
    if (yes + no === 0) continue; // no actual mint
    const set = userMarkets.get(user) ?? new Set();
    set.add(id);
    userMarkets.set(user, set);
  }

  // 4. Compute per-user outcome
  //
  // AllCorrect requires:
  //   (a) the user minted on every daily market, AND
  //   (b) every daily market is resolved, AND
  //   (c) for each daily market, the user still holds shares on the
  //       winning side at sweep time.
  //
  // (c) is what prevents a user from minting on every market, selling
  // the winning side via DeepBook, and still getting AllCorrect. Held
  // amount comes from the off-chain `positions` table that the position
  // indexer maintains from MintedEvent/RedeemedEvent.
  const out: ResolvedUser[] = [];
  for (const [user, markets] of userMarkets) {
    const mintedAll = markets.size === dailyMarketIds.size;
    const allResolved =
      mintedAll && [...markets].every((m) => resolvedMap.has(m));
    let holdsWinning = allResolved;
    if (allResolved) {
      for (const m of markets) {
        const winning = resolvedMap.get(m); // 1=YES, 2=NO
        if (!winning) {
          holdsWinning = false;
          break;
        }
        const pos = getPosition(m, user);
        const heldOnWinningSide =
          winning === 1 ? (pos?.yes ?? 0) : (pos?.no ?? 0);
        if (heldOnWinningSide <= 0) {
          holdsWinning = false;
          break;
        }
      }
    }
    out.push({
      user,
      outcome: holdsWinning ? OUTCOME_ALL_CORRECT : OUTCOME_SOME_WRONG,
      category: 0, // TODO: derive from `MarketCreatedEvent::category` once added
    });
  }
  return out;
}

function buildSweepTx(
  registryId: string,
  adminId: string,
  users: ResolvedUser[],
  dayIndex: bigint,
): Transaction {
  const tx = new Transaction();
  for (const u of users) {
    if (!u.streakId) {
      // User has no streak yet — record_participation requires an
      // existing UserStreak, and lazy-creating here would mis-attribute
      // ownership to the backend signer. The StreakWelcomeBanner in
      // apps/web prompts the user to call create_streak from their own
      // wallet; once they do, the next sweep picks them up.
      continue;
    }
    tx.moveCall({
      target: `${AGENT_POLICY_PACKAGE_ID}::streak_system::record_participation`,
      arguments: [
        tx.object(adminId),
        tx.object(registryId),
        tx.object(u.streakId),
        tx.pure.u64(dayIndex),
        tx.pure.u8(u.outcome),
        tx.pure.u8(u.category),
        tx.object(CLOCK_OBJECT_ID),
      ],
    });
  }
  return tx;
}

export async function runStreakSweeper(
  ctx: AgentContext,
): Promise<AgentResult> {
  if (!STREAK_REGISTRY_ID || !STREAK_ADMIN_ID) {
    return recordResult("StreakSweeper", {
      action: "skip",
      reasoning:
        "STREAK_REGISTRY_ID / STREAK_ADMIN_ID not configured — sweeper inert.",
    });
  }

  const dayIndex = dayIndexFor(Date.now() - DAY_MS); // sweep yesterday
  const users = await resolveDayOutcomes(dayIndex);
  if (users.length === 0) {
    return recordResult("StreakSweeper", {
      action: "noop",
      reasoning: `No resolved users for day ${dayIndex}.`,
      confidence: 100,
    });
  }

  // Look up each user's streakId. Users without a streak are skipped
  // (they need to call create_streak from the frontend first).
  const client = createClient();
  const withStreak: ResolvedUser[] = [];
  for (const u of users) {
    try {
      u.streakId = (await streakIdForUser(client, STREAK_REGISTRY_ID, u.user)) ?? undefined;
    } catch {
      // streakIdForUser swallows its own errors; any other failure is non-fatal
      u.streakId = undefined;
    }
    if (u.streakId) withStreak.push(u);
  }

  if (withStreak.length === 0) {
    return recordResult("StreakSweeper", {
      action: "noop",
      reasoning: `Day ${dayIndex}: ${users.length} minted but none have an on-chain streak yet.`,
      confidence: 100,
    });
  }

  let sent = 0;
  let failed = 0;

  for (let i = 0; i < withStreak.length; i += PTB_BATCH) {
    const batch = withStreak.slice(i, i + PTB_BATCH);
    const tx = buildSweepTx(
      STREAK_REGISTRY_ID,
      STREAK_ADMIN_ID,
      batch,
      BigInt(dayIndex),
    );
    try {
      const res = await executeTransaction(client, tx, ctx.signer);
      for (const u of batch) {
        recordDailyScore({
          user: u.user,
          day_index: dayIndex,
          participated: u.outcome === OUTCOME_NOT_SUBMITTED ? 0 : 1,
          all_correct: u.outcome === OUTCOME_ALL_CORRECT ? 1 : 0,
          streak_after: 0, // populated when the off-chain indexer re-reads
          category: u.category,
        });
        sent++;
      }
      console.log(
        `[streak-sweeper] batch ${i / PTB_BATCH + 1} → ${res.digest}`,
      );
    } catch (err) {
      failed += batch.length;
      console.error(
        `[streak-sweeper] batch ${i / PTB_BATCH + 1} failed:`,
        err,
      );
    }
  }

  return recordResult("StreakSweeper", {
    action: "sweep",
    reasoning: `Day ${dayIndex}: ${sent} ok, ${failed} failed (PTB size ${PTB_BATCH}; ${users.length - withStreak.length} users had no on-chain streak).`,
    confidence: 100,
  });
}
