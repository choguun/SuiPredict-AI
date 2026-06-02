/**
 * Streak sweeper — 00:02 UTC daily cron.
 *
 * Iterates the (user, day_index) pairs that the on-chain market resolution
 * touched, looks up each user's outcome (AllCorrect / SomeWrong /
 * NotSubmitted), and calls `record_participation` on each of their
 * `UserStreak` objects.
 *
 * For streak owners who did NOT mint that day, the sweep:
 *   - Always records a `NOT_SUBMITTED` row in the off-chain `daily_scores`
 *     table (the leaderboard source of truth).
 *   - Calls `record_participation(NOT_SUBMITTED)` on-chain ONLY when the
 *     gap is exactly 1 day (`day_index == last_participation_day + 1`).
 *     The on-chain contract requires consecutive days, so multi-day gaps
 *     cannot be backfilled without a contract change. Multi-day gaps are
 *     logged and skipped for the on-chain streak; the leaderboard still
 *     shows the correct (broken) streak score.
 *
 * PTBs are batched at 20 users per transaction (Sui limit). On a batch
 * abort (one user's `EAlreadyRecordedToday` / multi-day-gap violation
 * kills the whole 20-user PTB), we fall back to per-user submission
 * so the other 19 still get recorded. Sweep is idempotent: a user's
 * `EAlreadyRecordedToday` abort on retry is treated as success
 * (the on-chain state is already what we want).
 */
import { Transaction } from "@mysten/sui/transactions";
import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";
import { AGENT_POLICY_PACKAGE_ID, CLOCK_OBJECT_ID } from "@suipredict/sdk";
import {
  createClient,
  executeTransaction,
  streakIdForUser,
  type SuiClient,
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

/**
 * `streak_system::EAlreadyRecordedToday` aborts the tx with code 3. The
 * SDK surfaces this as a plain `Error` whose `.message` contains the
 * Sui Move-abort text — e.g. `"MoveAbort(...)` for instruction 0, abort
 * code 3"`. We match on the literal code 3 (the contract constant) so
 * this helper stays correct if the contract renames the constant.
 */
const E_ALREADY_RECORDED_ABORT_CODE = 3;
function isAlreadyRecordedError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /MoveAbort[^)]*\)\s*,\s*3\b/.test(msg);
}

interface ResolvedUser {
  user: string;
  outcome: 0 | 1 | 2; // 0=NotSubmitted, 1=AllCorrect, 2=SomeWrong
  category: 0 | 1 | 2 | 3;
  streakId?: string; // looked up off-chain; undefined = needs lazy create
  /** Gap to backfill (number of consecutive NOT_SUBMITTED days before `dayIndex`). */
  backfillDays?: number;
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
 * Enumerate all addresses that have a `UserStreak` registered.
 *
 * `StreakRegistry.streaks: Table<address, ID>` is a Sui `Table`, whose
 * entries appear as dynamic fields on the registry object. The gRPC
 * client returns each entry as `{ name: { type, bcs: Uint8Array }, ... }`
 * where `bcs` is the BCS-encoded 32-byte address. We decode it back to
 * a `0x`-prefixed hex string. The `value` (the `UserStreak` object id)
 * is fetched separately by `streakIdForUser`.
 */
async function listAllStreakOwners(
  client: SuiClient,
  registryId: string,
): Promise<string[]> {
  if (!registryId) return [];
  const out: string[] = [];
  let cursor: string | null = null;
  let hasNextPage = true;
  while (hasNextPage) {
    const page: { hasNextPage: boolean; cursor: string | null; dynamicFields: { name?: { type?: string; bcs?: Uint8Array } }[] } =
      await client.listDynamicFields({
        parentId: registryId,
        cursor,
        limit: 1000,
      });
    for (const f of page.dynamicFields) {
      const name = f.name;
      if (name?.type === "address" && name.bcs instanceof Uint8Array) {
        out.push("0x" + bytesToHex(name.bcs));
      }
    }
    hasNextPage = page.hasNextPage;
    cursor = page.cursor;
  }
  return out;
}

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) {
    s += b[i]!.toString(16).padStart(2, "0");
  }
  return s;
}

/**
 * Read `last_participation_day` from each `UserStreak` object in one
 * round-trip via `getObjects` (plural). Returns a map `ownerAddress -> day`.
 * Missing/zero days mean the user has never participated.
 */
async function readLastParticipationDays(
  client: SuiClient,
  streakIdsByOwner: Map<string, string>,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const ids = Array.from(streakIdsByOwner.values());
  if (ids.length === 0) return out;
  const ownerById = new Map<string, string>();
  for (const [owner, id] of streakIdsByOwner) ownerById.set(id, owner);

  // gRPC getObjects is bounded by request size; chunk to 50 ids per call
  // (Sui's historical multiGetObjects limit) to stay well under it.
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const { objects } = await client.getObjects({
      objectIds: chunk,
      include: { json: true },
    });
    for (const obj of objects) {
      if (obj instanceof Error) continue;
      const id = obj.objectId;
      if (!id) continue;
      const json = obj.json as { last_participation_day?: string | number } | null;
      const day = Number(json?.last_participation_day ?? 0);
      const owner = ownerById.get(id);
      if (owner) out.set(owner, day);
    }
  }
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
    if (u.outcome === OUTCOME_NOT_SUBMITTED) {
      // The on-chain contract resets `current_streak` to 0 on the first
      // NOT_SUBMITTED, and then every subsequent NOT_SUBMITTED for the
      // same user is a no-op (current_streak is already 0). We therefore
      // only need one NOT_SUBMITTED call per skipped user; the gap's
      // other missed days are unrecoverable from this contract (the
      // assertion `day_index == last + 1` rejects multi-day backfill
      // without a contract change). The leaderboard is fed from
      // off-chain `daily_scores` for the multi-day case.
      tx.moveCall({
        target: `${AGENT_POLICY_PACKAGE_ID}::streak_system::record_participation`,
        arguments: [
          tx.object(adminId),
          tx.object(registryId),
          tx.object(u.streakId),
          tx.pure.u64(dayIndex),
          tx.pure.u8(OUTCOME_NOT_SUBMITTED),
          tx.pure.u8(u.category),
          tx.object(CLOCK_OBJECT_ID),
        ],
      });
    } else {
      // Minted user — record the resolved outcome (ALL_CORRECT or
      // SOME_WRONG) for `dayIndex`.
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

  // ---- NotSubmitted sweep -------------------------------------------------
  // Enumerate every address with an on-chain `UserStreak`. Anyone who
  // didn't mint yesterday's daily markets gets:
  //   - a `NOT_SUBMITTED` row in the off-chain `daily_scores` table, so the
  //     leaderboard shows the broken streak; and
  //   - a `record_participation(NOT_SUBMITTED)` on-chain tx when the gap
  //     is exactly 1 day, so the user's `current_streak` is reset to 0.
  // Multi-day gaps (`dayIndex > last + 1`) are skipped for the on-chain
  // call because the contract requires consecutive days; the leaderboard
  // still records the NOT_SUBMITTED row.
  const mintedSet = new Set(users.map((u) => u.user));
  const allOwners = await listAllStreakOwners(client, STREAK_REGISTRY_ID);

  // Pull each owner's streakId + last_participation_day in one batch.
  const ownerToStreakId = new Map<string, string>();
  for (const owner of allOwners) {
    try {
      const id = await streakIdForUser(client, STREAK_REGISTRY_ID, owner);
      if (id) ownerToStreakId.set(owner, id);
    } catch {
      /* skip — user was removed between list and lookup */
    }
  }
  const lastDays = await readLastParticipationDays(client, ownerToStreakId);

  const notSubmittedUsers: ResolvedUser[] = [];
  const multiDayGaps: string[] = [];
  for (const owner of allOwners) {
    if (mintedSet.has(owner)) continue;
    const last = lastDays.get(owner) ?? 0;
    const expectedLast = dayIndex - 1; // dayIndex = yesterday; last = yesterday
    if (last === expectedLast) {
      // 1-day gap — contract can record NOT_SUBMITTED and reset streak.
      notSubmittedUsers.push({
        user: owner,
        outcome: OUTCOME_NOT_SUBMITTED,
        category: 0,
        streakId: ownerToStreakId.get(owner),
      });
    } else if (last > 0 && last < expectedLast) {
      // Multi-day gap — leaderboard still gets a row, on-chain skipped.
      notSubmittedUsers.push({
        user: owner,
        outcome: OUTCOME_NOT_SUBMITTED,
        category: 0,
        // streakId intentionally omitted: buildSweepTx will skip the
        // on-chain call for users without a streakId, but the
        // off-chain `daily_scores` row is still written below.
      });
      multiDayGaps.push(owner);
    }
    // last == 0 → user has never participated, skip silently.
    // last > expectedLast → clock skew or re-org; skip silently.
  }

  const combined = [...withStreak, ...notSubmittedUsers];
  if (combined.length === 0) {
    return recordResult("StreakSweeper", {
      action: "noop",
      reasoning: `Day ${dayIndex}: ${users.length} minted but no on-chain streaks to update.`,
      confidence: 100,
    });
  }

  let sent = 0;
  let failed = 0;

  for (let i = 0; i < combined.length; i += PTB_BATCH) {
    const batch = combined.slice(i, i + PTB_BATCH);
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
      // PTB is atomic — one user's abort (typically EAlreadyRecordedToday
      // from a prior successful sweep, or a multi-day-gap violation) kills
      // the whole batch. Fall back to per-user submission so the other 19
      // still get recorded. EAlreadyRecordedToday is treated as success
      // (the on-chain state is already what we want); anything else counts
      // as failed.
      console.warn(
        `[streak-sweeper] batch ${i / PTB_BATCH + 1} failed, falling back to per-user:`,
        err instanceof Error ? err.message : err,
      );
      for (const u of batch) {
        const singleTx = buildSweepTx(
          STREAK_REGISTRY_ID,
          STREAK_ADMIN_ID,
          [u],
          BigInt(dayIndex),
        );
        try {
          await executeTransaction(client, singleTx, ctx.signer);
          recordDailyScore({
            user: u.user,
            day_index: dayIndex,
            participated: u.outcome === OUTCOME_NOT_SUBMITTED ? 0 : 1,
            all_correct: u.outcome === OUTCOME_ALL_CORRECT ? 1 : 0,
            streak_after: 0,
            category: u.category,
          });
          sent++;
        } catch (perErr) {
          if (isAlreadyRecordedError(perErr)) {
            // Idempotent: a prior sweep already wrote today's row.
            recordDailyScore({
              user: u.user,
              day_index: dayIndex,
              participated: u.outcome === OUTCOME_NOT_SUBMITTED ? 0 : 1,
              all_correct: u.outcome === OUTCOME_ALL_CORRECT ? 1 : 0,
              streak_after: 0,
              category: u.category,
            });
            sent++;
          } else {
            failed++;
            console.error(
              `[streak-sweeper] per-user ${u.user} failed:`,
              perErr instanceof Error ? perErr.message : perErr,
            );
          }
        }
      }
    }
  }

  if (multiDayGaps.length > 0) {
    console.warn(
      `[streak-sweeper] ${multiDayGaps.length} users had multi-day gaps ` +
        `(NOT_SUBMITTED recorded in daily_scores only; on-chain streak not reset). ` +
        `First few: ${multiDayGaps.slice(0, 3).join(", ")}`,
    );
  }

  return recordResult("StreakSweeper", {
    action: "sweep",
    reasoning:
      `Day ${dayIndex}: ${sent} ok, ${failed} failed ` +
      `(${withStreak.length} minted, ${notSubmittedUsers.length - multiDayGaps.length} not-submitted 1-day gaps, ` +
      `${multiDayGaps.length} multi-day gaps, PTB size ${PTB_BATCH}).`,
    confidence: 100,
  });
}
