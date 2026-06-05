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
  executeTransaction,
  isMoveAbortCode,
  isMoveAbortSymbol,
  streakIdForUser,
  type SuiClient,
} from "@suipredict/sdk";
import type { AgentContext, AgentResult } from "../lib.js";
import { getSharedClient, recordResult } from "../lib.js";
import {
  acquireSweepLock,
  dayIndexFor,
  getSweepRun,
  recordDailyScore,
  recordDailyScoreIfAbsent,
  releaseSweepLock,
} from "../gamification/store.js";
import { getPosition } from "../markets/store.js";
import { readCursor, runPositionIndexer, writeCursor } from "./position-indexer.js";

const PTB_BATCH = 20;

// Per-user retry cap for transient errors. Anything that isn't an
// on-chain Move abort (e.g. RPC timeouts, 429, network blips) is
// retried at most this many times before we count the user as
// failed. Permanent errors (Move aborts, EStreakBroken, etc.) skip
// the retry and count as failed on the first attempt.
const PER_USER_MAX_RETRY = 2;

// Max time the per-user fallback can run before the sweep gives up.
// At ~10s per attempt and 20 users per batch, a normal fallback
// finishes in seconds; a stuck RPC would loop forever otherwise.
// When this fires, we release the lock and let the next cron tick
// (or the next-day sweep) retry.
const PER_USER_BATCH_TIMEOUT_MS = 10 * 60 * 1000;

// Abort the entire sweep if this many consecutive per-user attempts
// fail with similar errors — almost always a global RPC outage,
// not a per-user issue. Saves gas on doomed txs and frees the
// sweep lock so the next-day sweep can take over.
const MAX_CONSECUTIVE_FAILURES = 5;

// R49 audit fix: R48 claimed to move module-level env reads
// inside `runStreakSweeper` (and the other workers) but the
// streak sweeper's `STREAK_REGISTRY_ID`, `STREAK_ADMIN_ID`, and
// `SUI_NETWORK` were still captured once at module load. The
// workers are imported well before `bootstrapEnv()` patches
// `process.env`, so a redeploy that swaps the env values in
// place (e.g. testnet → mainnet, or rotating to a new prize
// pool) silently operates against the old IDs. Move all three
// into the function bodies that actually consume them.

const OUTCOME_NOT_SUBMITTED = 0;
const OUTCOME_ALL_CORRECT = 1;
const OUTCOME_SOME_WRONG = 2;
const DAY_MS = 86_400_000;

/**
 * `streak_system::EAlreadyRecordedToday` aborts the tx with code 3.
 * The SDK surfaces this as a plain `Error` whose `.message` contains
 * the Sui Move-abort text. We resolve the code via the shared helper
 * so the agent doesn't maintain its own regex.
 */
function isAlreadyRecordedError(err: unknown): boolean {
  return isMoveAbortCode(err, "streak_system", 3);
}

/**
 * Classify an error as transient (retryable) or permanent. Transient
 * errors are network/RPC issues that may succeed on a retry; permanent
 * errors are on-chain aborts or invalid transactions that will always
 * fail the same way.
 */
function isTransientError(err: unknown): boolean {
  // R43 audit fix: replace the substring match on
  // `EWrongStreakOwner|ENotAdmin|EInvalidOutcome|EStreakBroken`
  // with the structured `isMoveAbortSymbol` helper. The
  // previous regex matched the literal substring anywhere
  // in the error message — a custom Move abort with a name
  // like `EWrongStreakOwnerForAdmin` would have been
  // classified as permanent, and a non-abort error that
  // happened to contain the string "WrongStreakOwner" in
  // its message would have been treated as an on-chain
  // abort. The `isMoveAbortSymbol` helper parses the
  // structured `MoveLocation` field Sui embeds in SDK
  // errors and matches the exact symbol name.
  if (isMoveAbortSymbol(err, "EWrongStreakOwner")) return false;
  if (isMoveAbortSymbol(err, "ENotAdmin")) return false;
  if (isMoveAbortSymbol(err, "EInvalidOutcome")) return false;
  if (isMoveAbortSymbol(err, "EStreakBroken")) return false;
  // Catch-all: any other Move abort is also permanent.
  if (err instanceof Error && /MoveAbort/.test(err.message)) return false;
  // RPC / network signatures worth retrying.
  // R46 audit fix: extend the regex to cover 408 (Request
  // Timeout) and 502 (Bad Gateway). 408 is the HTTP code
  // gRPC sends when the upstream is slow to respond
  // (the SDK's fetch wrapper stringifies the status code
  // into the error message as "408"); 502 is what Cloudflare
  // and the Sui gRPC LB return when the upstream backend is
  // in the middle of a rolling restart. Both are
  // retryable but the previous regex missed them, so a
  // single transient blip would have marked the leg
  // permanently failed and the streak-sweeper would have
  // skipped it for the rest of the day.
  const msg = err instanceof Error ? err.message : String(err);
  return /(fetch failed|ETIMEDOUT|ECONNRESET|ECONNREFUSED|socket hang up|408|429|502|503|504|TooManyRequests|Service Unavailable|Bad Gateway|Gateway Timeout|Request timeout)/i.test(msg);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Pick the category for a user's daily-score row from the set of
 * daily markets they participated in. See the r14 note in
 * `resolveDayOutcomes` — the per-day market set is expected to share
 * a single category, so first-seen-wins is representative. If a
 * day mixes categories, the leaderboard worker will need a redesign
 * (out of scope for r14).
 */
function pickUserCategory(
  markets: Set<string>,
  marketCategory: Map<string, 0 | 1 | 2 | 3>,
): 0 | 1 | 2 | 3 {
  for (const m of markets) {
    const code = marketCategory.get(m);
    if (code !== undefined) return code;
  }
  return 0;
}

/**
 * Re-read `UserStreak.current_streak` for the given list of users
 * and return a `{user → current_streak}` map. Used to populate
 * `daily_scores.streak_after` immediately after a successful
 * `record_participation` tx — the on-chain state is authoritative,
 * the off-chain row was previously 0 until a separate poll caught
 * up, which left leaderboard scores lagging reality by a full tick.
 *
 * The gRPC JSON view renders the `current_streak: u64` field as a
 * decimal string. Defensive: any failure (object deleted, RPC
 * outage, malformed JSON) returns an empty map; the caller then
 * writes `streak_after: 0` which is no worse than the prior
 * behavior. We deliberately don't fail the whole sweep on a single
 * bad read.
 */
async function readCurrentStreaks(
  client: SuiClient,
  streakIds: (string | undefined)[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const ids = streakIds.filter((x): x is string => !!x);
  if (ids.length === 0) return out;
  try {
    const { objects } = await client.getObjects({
      objectIds: ids,
      include: { json: true },
    });
    for (const obj of objects) {
      if (!obj || obj instanceof Error) continue;
      const json = obj.json as { current_streak?: string | number; id?: string } | null;
      const raw = json?.current_streak;
      if (raw == null) continue;
      const n = typeof raw === "string" ? Number(raw) : raw;
      if (typeof n === "number" && Number.isFinite(n) && obj.objectId) {
        out.set(obj.objectId, n);
      }
    }
  } catch (e) {
    console.warn(
      "[streak-sweeper] readCurrentStreaks failed; writing streak_after=0:",
      e instanceof Error ? e.message : e,
    );
  }
  return out;
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
  stateKey: string,
): Promise<unknown[]> {
  const out: unknown[] = [];
  // R51 audit fix: use the (network, package_id)-
  // tagged cursor from `indexer_state` instead of
  // re-pulling the full event history. The
  // streak-sweeper's three `queryAllEvents` calls
  // (MarketCreatedEvent, DailyResolvedEvent,
  // BadgeMintedEvent) walked the entire history on
  // every cron tick. A 6-month-old mainnet deploy
  // with 100k+ events would burn 100MB of JSON-RPC
  // response bandwidth per tick and OOM the Node
  // process. `readCursor` is now network+package
  // tagged (R50) so a hot-patch resets cleanly; the
  // `readCursor`/`writeCursor` helpers live in
  // `markets/store.ts`.
  let cursor: EventPageCursor = readCursor(stateKey);
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
  // Persist the final cursor so the next tick starts
  // here. `writeCursor` is a no-op when `cursor` is
  // null (a one-shot history pull from the genesis
  // cursor left the state in a "no resumable
  // position" state, which is the same behavior as
  // the pre-R51 sweep).
  writeCursor(stateKey, cursor);
  return out;
}

/**
 * Enumerate all (owner, streakId) pairs in the `StreakRegistry`.
 *
 * `StreakRegistry.streaks: Table<address, ID>` is a Sui `Table`, whose
 * entries appear as dynamic fields on the registry object. The gRPC
 * client returns each entry as `{ name: { type, bcs }, value, ... }`
 * where:
 *   - `name.bcs` is the BCS-encoded 32-byte address of the owner
 *   - `value` is the `UserStreak` object id (decoded by the SDK to a
 *     hex string or `{ id: "0x..." }` object)
 *
 * We extract both in one pass to avoid the O(n) `streakIdForUser`
 * round-trips that the previous impl made per owner — at ~5k users
 * that was 5k sequential gRPC calls, which exceeded the cron window
 * and the indexer died silently partway through.
 *
 * Falls back to per-owner `streakIdForUser` for any entry whose value
 * is missing or malformed (e.g. older SDK versions that strip `value`
 * from `listDynamicFields` responses). The fallback path is rare and
 * self-corrects on the next sweep.
 */
async function listAllStreakOwners(
  client: SuiClient,
  registryId: string,
): Promise<Map<string, string>> {
  if (!registryId) return new Map();
  const out = new Map<string, string>();
  const missingValue: string[] = [];
  let cursor: string | null = null;
  let hasNextPage = true;
  while (hasNextPage) {
    const page: {
      hasNextPage: boolean;
      cursor: string | null;
      dynamicFields: {
        name?: { type?: string; bcs?: Uint8Array };
        value?: unknown;
      }[];
    } = await client.listDynamicFields({
      parentId: registryId,
      cursor,
      limit: 1000,
    });
    for (const f of page.dynamicFields) {
      const name = f.name;
      if (name?.type !== "address" || !(name.bcs instanceof Uint8Array)) {
        continue;
      }
      const owner = "0x" + bytesToHex(name.bcs);
      const streakId = decodeStreakIdValue(f.value);
      if (streakId) {
        out.set(owner, streakId);
      } else {
        missingValue.push(owner);
      }
    }
    hasNextPage = page.hasNextPage;
    cursor = page.cursor;
  }
  // Backfill any owners whose `value` was stripped from the listing
  // response. Bounded by 5k in practice; the per-call latency is
  // ~10ms so the total stays under 60s for the worst case.
  for (const owner of missingValue) {
    try {
      const id = await streakIdForUser(client, registryId, owner);
      if (id) out.set(owner, id);
    } catch {
      /* user removed between list and lookup */
    }
  }
  return out;
}

function decodeStreakIdValue(value: unknown): string | null {
  if (typeof value === "string" && value.startsWith("0x")) return value;
  if (typeof value === "object" && value !== null && "id" in value) {
    const id = (value as { id: unknown }).id;
    if (typeof id === "string" && id.startsWith("0x")) return id;
  }
  return null;
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
  // R49 audit fix: read the network inside the function body so a
  // hot-patch to `process.env.SUI_NETWORK` takes effect on the
  // next sweep. `bootstrapEnv()` in `index.ts` mutates the env
  // after import, so the previous module-level capture often
  // resolved to the empty default at boot.
  const SUI_NETWORK = (process.env.SUI_NETWORK ?? "testnet") as
    | "testnet"
    | "mainnet"
    | "devnet"
    | "localnet";
  const client = new SuiJsonRpcClient({
    url: getJsonRpcFullnodeUrl(SUI_NETWORK),
    network: SUI_NETWORK,
  });
  const dayStartMs = dayIndex * DAY_MS;
  const dayEndMs = dayStartMs + DAY_MS;
  // Daily markets may expire anywhere in the day window or shortly after
  // (the market-creator's `expiry_days` is rounded to the second, and
  // a 1-day market created at 00:00:01 UTC has expiry at 00:00:01 the
  // NEXT day — 1ms past `dayEndMs`). The previous strict window
  // `[dayStartMs, dayEndMs)` missed those markets, so the sweep
  // silently recorded `noop` for the day and the user kept a phantom
  // streak. The 1-hour grace catches boundary cases while still
  // rejecting markets that belong to a different day window.
  const EXPIRY_GRACE_MS = 60 * 60 * 1000;

  // 1. Daily markets
  const createdRaw = await queryAllEvents(client, {
    MoveEventType: `${AGENT_POLICY_PACKAGE_ID}::prediction_market::MarketCreatedEvent`,
  }, "streak-sweeper:MarketCreatedEvent");
  const dailyMarketIds = new Set<string>();
  // `category` is read off the same `MarketCreatedEvent` stream and
  // forwarded to the per-user `ResolvedUser` so the off-chain
  // `daily_scores` row carries the topic. Pre-r14 events won't have
  // it (deployed before the field was added) — those fall through to
  // 0 ("none") which the leaderboard treats as "no topic filter".
  // First-seen-wins for the user's category: daily markets of a
  // single day should all share the same category, so the first
  // match is representative. If a future deploy mixes categories in
  // one day, the leaderboard worker would have to be reworked to
  // emit one row per (user, market) pair — out of scope for r14.
  const dailyMarketCategory = new Map<string, 0 | 1 | 2 | 3>();
  for (const e of createdRaw) {
    const ev = e as {
      parsedJson: {
        market_id?: string;
        expiry_ms?: string | number;
        category?: string | number;
      };
    };
    // R45 audit fix: route the u64 `expiry_ms` through BigInt
    // first to avoid Number() truncation above 2^53-1. R37 did
    // this for `parlay.collateral` and R36 for several vault /
    // order u64s; the on-chain `MarketCreatedEvent.expiry_ms`
    // was the survivor. A market created with a far-future
    // expiry (or a deploy with a non-standard clock base) would
    // otherwise have a corrupted expiry in the mirror and never
    // appear in the daily-market window the streak-sweeper uses.
    const expiry = Number(BigInt(ev.parsedJson.expiry_ms ?? 0));
    const id = ev.parsedJson.market_id;
    if (
      id &&
      expiry >= dayStartMs &&
      expiry < dayEndMs + EXPIRY_GRACE_MS
    ) {
      dailyMarketIds.add(id);
      const raw = Number(ev.parsedJson.category ?? 0);
      const code = (raw === 1 || raw === 2 || raw === 3) ? (raw as 1 | 2 | 3) : 0;
      if (!dailyMarketCategory.has(id)) dailyMarketCategory.set(id, code);
    }
  }
  if (dailyMarketIds.size === 0) return [];

  // 2. Resolutions for daily markets
  const resolvedRaw = await queryAllEvents(client, {
    MoveEventType: `${AGENT_POLICY_PACKAGE_ID}::prediction_market::MarketResolvedEvent`,
  }, "streak-sweeper:MarketResolvedEvent");
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
  }, "streak-sweeper:MintedEvent");
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
      // First daily market the user touched — see the comment on
      // `dailyMarketCategory` above for the first-seen-wins rationale.
      category: pickUserCategory(markets, dailyMarketCategory),
    });
  }
  return out;
}

/**
 * Append a single `record_participation` call to a multi-call PTB.
 *
 * R29: extracted from the inline `tx.moveCall` blocks in
 * `buildSweepTx` — the SDK's `buildRecordParticipationTx` builds a
 * fresh `Transaction` for a single call, but the sweeper needs to
 * batch N calls (one per user) into one transaction to keep gas
 * low. This helper takes an existing `tx` and appends one call,
 * keeping the target string / arg encoding in lock-step with the
 * SDK builder (mirror the arg order in
 * `packages/sdk/src/streak-client.ts::buildRecordParticipationTx`).
 */
function appendRecordParticipation(
  tx: Transaction,
  args: {
    adminId: string;
    registryId: string;
    streakId: string;
    dayIndex: bigint;
    outcome: number;
    category: number;
  },
): void {
  tx.moveCall({
    target: `${AGENT_POLICY_PACKAGE_ID}::streak_system::record_participation`,
    arguments: [
      tx.object(args.adminId),
      tx.object(args.registryId),
      tx.object(args.streakId),
      tx.pure.u64(args.dayIndex),
      tx.pure.u8(args.outcome),
      tx.pure.u8(args.category),
      tx.object(CLOCK_OBJECT_ID),
    ],
  });
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
    // The on-chain contract resets `current_streak` to 0 on the first
    // NOT_SUBMITTED, and then every subsequent NOT_SUBMITTED for the
    // same user is a no-op (current_streak is already 0). We therefore
    // only need one NOT_SUBMITTED call per skipped user; the gap's
    // other missed days are unrecoverable from this contract (the
    // assertion `day_index == last + 1` rejects multi-day backfill
    // without a contract change). The leaderboard is fed from
    // off-chain `daily_scores` for the multi-day case.
    // Minted users (ALL_CORRECT / SOME_WRONG) take the same path; the
    // helper differs only in the outcome byte.
    appendRecordParticipation(tx, {
      adminId,
      registryId,
      streakId: u.streakId,
      dayIndex,
      outcome: u.outcome,
      category: u.category,
    });
  }
  return tx;
}

export async function runStreakSweeper(
  ctx: AgentContext,
): Promise<AgentResult> {
  // R49 audit fix: read env inside the function body so a
  // hot-patch of `process.env` (e.g. via a redeploy that doesn't
  // restart the worker) takes effect on the next tick.
  const STREAK_REGISTRY_ID = process.env.STREAK_REGISTRY_ID ?? "";
  const STREAK_ADMIN_ID = process.env.STREAK_ADMIN_ID ?? "";
  if (!STREAK_REGISTRY_ID || !STREAK_ADMIN_ID) {
    return recordResult("StreakSweeper", {
      action: "skip",
      reasoning:
        "STREAK_REGISTRY_ID / STREAK_ADMIN_ID not configured — sweeper inert.",
    });
  }

  const dayIndex = dayIndexFor(Date.now() - DAY_MS); // sweep yesterday

  // Per-day sweep lock. If a prior sweep for the same day is still
  // running (e.g. a slow per-user fallback), bail out so we don't
  // race the next day's sweep with the previous day's leftovers.
  // A 24h-stale lock is recovered to the new caller in case the
  // previous process died mid-sweep.
  if (!acquireSweepLock(dayIndex)) {
    const existing = getSweepRun(dayIndex);
    return recordResult("StreakSweeper", {
      action: "skip",
      reasoning:
        `Sweep for day ${dayIndex} already running ` +
        `(started ${existing?.started_at_ms ?? "?"}); the in-flight ` +
        `per-user fallback will finish it.`,
    });
  }
  // The lock is released in `finally` no matter how the body exits
  // (early `noop` returns, thrown RPC error, normal completion). This
  // keeps the next-day sweep from seeing a stale `running` row and
  // skipping a fresh run.
  try {
  // Catch up the position indexer before we read `positions` below.
  // The AllCorrect proxy (step 4 of `resolveDayOutcomes`) checks
  // `getPosition(m, user).yes/no` to verify the user still holds the
  // winning side at sweep time. If a user redeemed at 23:59 UTC and
  // the position indexer hasn't polled the RedeemedEvent by 00:02 UTC
  // (e.g. it was lagging, or just ran at 00:00 UTC), the `positions`
  // table would still show the pre-redeem balance — a user who sold
  // everything would get `AllCorrect` instead of `SomeWrong`. Forcing
  // an indexer pass here brings `positions` in line with the chain
  // before the proxy reads it. Worst case it adds one round of gRPC
  // polling (~1s) to the sweep.
  try {
    await runPositionIndexer(ctx);
  } catch (err) {
    // Indexer failure shouldn't kill the sweep — log and proceed
    // with whatever positions the table already has. The result
    // will be conservative (more `SomeWrong`) rather than wrong.
    console.warn(
      "[streak-sweeper] pre-poll position indexer failed, continuing with possibly-stale positions:",
      err instanceof Error ? err.message : err,
    );
  }
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
  const client = getSharedClient();
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
  // listAllStreakOwners already returns the owner→streakId map, so
  // we skip the per-owner `streakIdForUser` round-trip that would
  // otherwise dominate the cron window at scale (5k users → 5k gRPC
  // calls). The fallback path inside listAllStreakOwners backfills
  // any rows whose `value` was missing from the listing response.
  const ownerToStreakId = await listAllStreakOwners(client, STREAK_REGISTRY_ID);
  const lastDays = await readLastParticipationDays(client, ownerToStreakId);

  const notSubmittedUsers: ResolvedUser[] = [];
  const multiDayGaps: string[] = [];
  for (const [owner, streakId] of ownerToStreakId) {
    if (mintedSet.has(owner)) continue;
    const last = lastDays.get(owner) ?? 0;
    const expectedLast = dayIndex - 1; // dayIndex = yesterday; last = yesterday
    if (last === expectedLast) {
      // 1-day gap — contract can record NOT_SUBMITTED and reset streak.
      notSubmittedUsers.push({
        user: owner,
        outcome: OUTCOME_NOT_SUBMITTED,
        category: 0,
        streakId,
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
  let consecutiveFailures = 0;
  let lastFailureMsg = "";
  let aborted = false;
  const sweepStartMs = Date.now();

  for (let i = 0; i < combined.length && !aborted; i += PTB_BATCH) {
    const batch = combined.slice(i, i + PTB_BATCH);
    const tx = buildSweepTx(
      STREAK_REGISTRY_ID,
      STREAK_ADMIN_ID,
      batch,
      BigInt(dayIndex),
    );
    try {
      const res = await executeTransaction(client, tx, ctx.signer);
      // Re-read `current_streak` for every user in the batch so the
      // off-chain `daily_scores.streak_after` reflects the on-chain
      // state immediately rather than waiting for the next indexer
      // poll. The read is one batched gRPC call, not N.
      const streaks = await readCurrentStreaks(
        client,
        batch.map((u) => u.streakId),
      );
      for (const u of batch) {
        recordDailyScore({
          user: u.user,
          day_index: dayIndex,
          participated: u.outcome === OUTCOME_NOT_SUBMITTED ? 0 : 1,
          all_correct: u.outcome === OUTCOME_ALL_CORRECT ? 1 : 0,
          streak_after: u.streakId ? (streaks.get(u.streakId) ?? 0) : 0,
          category: u.category,
        });
        sent++;
      }
      consecutiveFailures = 0;
      console.log(
        `[streak-sweeper] batch ${i / PTB_BATCH + 1} → ${res.digest}`,
      );
    } catch (err) {
      // PTB is atomic — one user's abort (typically EAlreadyRecordedToday
      // from a prior successful sweep, or a multi-day-gap violation) kills
      // the whole batch. Fall back to per-user submission so the other 19
      // still get recorded. EAlreadyRecordedToday is treated as success
      // (the on-chain state is already what we want); transient errors
      // are retried up to PER_USER_MAX_RETRY times; anything else counts
      // as failed.
      console.warn(
        `[streak-sweeper] batch ${i / PTB_BATCH + 1} failed, falling back to per-user:`,
        err instanceof Error ? err.message : err,
      );
      for (const u of batch) {
        if (aborted) break;
        // Total-budget guard: if the per-user fallback has run for
        // too long, abort the entire sweep. The next cron tick (or
        // the next-day sweep) will retry. Without this, a stuck RPC
        // could keep the per-user loop alive past the daily window
        // and race the next-day sweep.
        if (Date.now() - sweepStartMs > PER_USER_BATCH_TIMEOUT_MS) {
          console.warn(
            `[streak-sweeper] per-user fallback exceeded ${PER_USER_BATCH_TIMEOUT_MS}ms; aborting sweep.`,
          );
          aborted = true;
          break;
        }
        const singleTx = buildSweepTx(
          STREAK_REGISTRY_ID,
          STREAK_ADMIN_ID,
          [u],
          BigInt(dayIndex),
        );
        type Outcome =
          | { kind: "ok" }
          | { kind: "already_recorded" }
          | { kind: "failed"; err: unknown };
        let outcome: Outcome = { kind: "failed", err: null };
        for (let attempt = 0; attempt <= PER_USER_MAX_RETRY; attempt++) {
          try {
            await executeTransaction(client, singleTx, ctx.signer);
            outcome = { kind: "ok" };
            break;
          } catch (e) {
            if (isAlreadyRecordedError(e)) {
              // Idempotent: the on-chain state was already written by a
              // prior sweep (with whatever outcome the indexer had at
              // that time). The on-chain state is the source of truth;
              // we use `IfAbsent` so a fresh-but-different locally
              // computed outcome doesn't clobber the leaderboard row
              // that the prior sweep wrote. The leaderboard reflects
              // the on-chain state, not the latest local view.
              outcome = { kind: "already_recorded" };
              break;
            }
            if (!isTransientError(e) || attempt === PER_USER_MAX_RETRY) {
              // Permanent error, or we've exhausted retries on a
              // transient one. Either way, give up on this user.
              outcome = { kind: "failed", err: e };
              break;
            }
            // Backoff before retry: 1s, 2s, 4s …
            await sleep(1_000 * 2 ** attempt);
          }
        }
        if (outcome.kind === "ok") {
          // On a per-user success, re-read the user's current_streak
          // so the off-chain `daily_scores.streak_after` reflects the
          // post-sweep on-chain state. One extra gRPC call per user
          // is acceptable on the fallback path; the happy batch path
          // (above) does one batched read.
          const streaks = await readCurrentStreaks(
            client,
            [u.streakId],
          );
          recordDailyScore({
            user: u.user,
            day_index: dayIndex,
            participated: u.outcome === OUTCOME_NOT_SUBMITTED ? 0 : 1,
            all_correct: u.outcome === OUTCOME_ALL_CORRECT ? 1 : 0,
            streak_after: u.streakId ? (streaks.get(u.streakId) ?? 0) : 0,
            category: u.category,
          });
          sent++;
          consecutiveFailures = 0;
        } else if (outcome.kind === "already_recorded") {
          // A prior sweep already wrote the on-chain state. Re-read
          // it for the same reason as the `ok` branch: we want the
          // off-chain `daily_scores` row to reflect the on-chain
          // value, not the local view (which may differ if the
          // user's market participation changed between sweeps).
          const streaks = await readCurrentStreaks(
            client,
            [u.streakId],
          );
          recordDailyScoreIfAbsent({
            user: u.user,
            day_index: dayIndex,
            participated: u.outcome === OUTCOME_NOT_SUBMITTED ? 0 : 1,
            all_correct: u.outcome === OUTCOME_ALL_CORRECT ? 1 : 0,
            streak_after: u.streakId ? (streaks.get(u.streakId) ?? 0) : 0,
            category: u.category,
          });
          sent++;
          consecutiveFailures = 0;
        } else {
          const msg =
            outcome.err instanceof Error
              ? outcome.err.message
              : String(outcome.err);
          failed++;
          console.error(`[streak-sweeper] per-user ${u.user} failed:`, msg);
          // R40 audit fix: the on-chain call aborted (typically
          // EStreakBroken on a multi-day gap, or an
          // EInvalidOutcome if the resolver disagreed with the
          // off-chain state). The leaderboard is fed by the
          // off-chain `daily_scores` table — without a row the
          // user is silently absent for the day, which
          // artificially boosts every other user's rank. Write
          // a best-effort row (participated=0, all_correct=0,
          // streak_after=0) so the leaderboard reflects the
          // (broken) state. The on-chain streak id is required
          // to read the post-call streak, but we don't have a
          // post-call read here — `streak_after=0` is
          // conservative (the streak is at least 0 post-break,
          // the next indexer poll will overwrite with the
          // on-chain value).
          recordDailyScoreIfAbsent({
            user: u.user,
            day_index: dayIndex,
            participated: 0,
            all_correct: 0,
            streak_after: 0,
            category: u.category,
          });
          // If the same error keeps repeating, the RPC is almost
          // certainly broken — stop wasting gas on doomed txs and
          // let the next-day sweep retry from a fresh state.
          if (msg === lastFailureMsg) {
            consecutiveFailures++;
          } else {
            lastFailureMsg = msg;
            consecutiveFailures = 1;
          }
          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            console.error(
              `[streak-sweeper] ${consecutiveFailures} consecutive identical failures — aborting sweep. ` +
                `Last error: ${msg}`,
            );
            aborted = true;
            break;
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
  } finally {
    releaseSweepLock(dayIndex);
  }
}
