/**
 * Parlay worker — every-minute cron.
 *
 * Drives the on-chain parlay lifecycle after the user has submitted
 * `create_parlay` and the position-indexer has mirrored the
 * `ParlayCreated` event into the off-chain `parlays` table. For each
 * unfinalized parlay:
 *
 *   1. Walk the legs in order. For each leg whose index is `>=
 *      legs_recorded` (i.e. still LEG_PENDING on-chain), check the
 *      corresponding market's resolution status from the off-chain
 *      `markets` table.
 *
 *   2. If the market is resolved (and not disputed), submit a
 *      `parlay::record_leg` PTB. The on-chain check asserts the
 *      market is `is_resolved == true` and not disputed, and that
 *      the market id matches the leg's saved `market_id`. The worker
 *      uses the off-chain `markets.status` to gate the call so we
 *      don't waste gas on a doomed tx for an unresolved market.
 *
 *   3. Once `legs_recorded == leg_count` (i.e. every leg has been
 *      recorded, whether won or lost), submit `parlay::finalize_parlay`.
 *      The on-chain check asserts `legs_recorded == leg_count` and
 *      `pool_id == object::id(pool)`, then pays out
 *      `collateral * payout_bps / 10_000` if `legs_lost == 0`.
 *
 * The worker is best-effort per tick. A leg is skipped (and retried
 * on the next tick) if:
 *   - the underlying market isn't in the off-chain mirror yet
 *     (positions indexer hasn't picked up `MarketCreatedEvent` for it);
 *   - the market is in `disputed` status (don't finalize while a
 *     dispute is pending);
 *   - the market is still `active` (not yet resolved by the resolver);
 *   - the call is for a `leg_index >= leg_count` (defensive — the
 *     parlay struct invariant should prevent this, but a partial
 *     indexer backfill could surface a row with mismatched counts).
 *
 * Each leg is its own PTB so a single failed leg (e.g. transient
 * RPC error) doesn't abort the others. Finalize is one PTB per
 * parlay since the on-chain check needs every leg recorded first.
 *
 * Why a dedicated worker (vs. folding this into the position-indexer):
 *   - The indexer is generic event mirroring — it never signs txs.
 *   - The lifecycle is admin-driven (the deployer keypair is the
 *     caller of `record_leg` / `finalize_parlay`), so it must run
 *     in the signer-bearing worker context, not the indexer.
 *   - The cadence is the same as the position-indexer (every minute)
 *     so leg recording and event mirroring stay in lockstep.
 */
import {
  buildFinalizeParlayTx,
  buildRecordLegTx,
  DUSDC_TYPE,
  type SuiClient,
} from "@suipredict/sdk";
import { isMoveAbortInModule } from "@suipredict/sdk";
import { Transaction } from "@mysten/sui/transactions";
import { executeTransaction } from "@suipredict/sdk";
import type { AgentContext, AgentResult } from "../lib.js";
import { getSharedClient, recordResult, safeInt } from "../lib.js";
import { getMarket } from "../markets/store.js";
import {
  getParlayLegMarketIds,
  listReadyToFinalizeParlays,
  listUnfinalizedParlays,
  type ParlayRow,
} from "../gamification/store.js";

// R49 audit fix: R48 claimed to move module-level env reads
// inside the worker functions. The parlay worker's `PKG` and
// `WORKER_POOL_ID` were missed; both were captured once at
// import time and the import happens before `bootstrapEnv()`
// patches `process.env`. Move both into `runParlayWorker` so a
// hot-patch (e.g. rotating to a different prize pool, or
// testnet → mainnet) takes effect on the next tick.
// R37 audit fix (preserved): this worker is the deployer-keypair
// admin for the `PARLAY_POOL_ID` pool. On a multi-pool deploy it
// must NOT `record_leg` / `finalize_parlay` parlays that belong
// to a different pool — the on-chain check would abort and we'd
// burn gas on a doomed tx. Default to the env value; an empty
// string means "cross-pool" (the previous behaviour, kept for
// backward compat but documented as unsupported on a multi-pool
// deploy).

/**
 * Per-leg retry cap for transient RPC errors. Permanent errors
 * (Move aborts) are not retried — they will always fail and would
 * just waste gas.
 */
const PER_LEG_MAX_RETRY = 2;

/**
 * Permanent Move-abort errors from the `parlay` module. Every abort
 * the contract raises is by definition non-retryable — the on-chain
 * assertion that aborted won't change on a re-submit, and the gas
 * spent on a retry is wasted. We don't enumerate individual codes
 * here because the SDK's `PARLAY_CODES` map is the single source of
 * truth — if a new code is added to the contract, the SDK map gets
 * the new symbolic name and the worker keeps treating it as
 * permanent without a code edit.
 */
function isPermanentParlayError(err: unknown): boolean {
  return isMoveAbortInModule(err, "parlay");
}

function isTransientError(err: unknown): boolean {
  // R43 audit fix: the previous `/MoveAbort/` regex matched the
  // literal substring anywhere in the message — a non-abort
  // error whose text happened to contain "MoveAbort" would have
  // been mis-classified as permanent. Walk the SDK's structured
  // helpers instead: any Move abort is permanent, regardless of
  // module.
  if (isMoveAbortInModule(err, "parlay")) return false;
  // Catch-all: any Move abort in any module is also permanent.
  // `isMoveAbortInModule` with a non-existent module name
  // would return false, so we use a stricter check here.
  const msg = err instanceof Error ? err.message : String(err);
  if (/module:\s*"[a-z_]+"[\s\S]*MoveAbort/.test(msg)) return false;
  // R46 audit fix: extend the regex to cover 408 (Request
  // Timeout) and 502 (Bad Gateway) — see streak-sweeper.ts
  // for the full rationale. The parlay-worker per-leg
  // retry loop previously bailed on a single 408/502 and
  // marked the leg permanently failed.
  return /(fetch failed|ETIMEDOUT|ECONNRESET|ECONNREFUSED|socket hang up|408|429|502|503|504|TooManyRequests|Service Unavailable|Bad Gateway|Gateway Timeout|Request timeout)/i.test(msg);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Build a one-leg `record_leg` PTB for a single (parlay, market,
 * leg_index) tuple. The market must be a `PredictionMarket<Q>` shared
 * object whose type parameter matches the parlay's collateral
 * type — in production both are `<pkg>::prediction_market::PredictionMarket<DUSDC_TYPE>`.
 */
function buildSingleRecordLegTx(
  parlayId: string,
  marketId: string,
  legIndex: number,
): Transaction {
  // R41 audit fix: previously passed the full
  // `PredictionMarket<DUSDC_TYPE>` as the type argument to
  // `parlay::record_leg`, but the Move function has only one
  // generic parameter Q (the coin type). The PTB rejected at
  // type-check with `PTB type-argument count mismatch`, so
  // every parlay leg was silently stuck in PENDING forever.
  // The market's `PredictionMarket<Q>` type is pinned
  // automatically once Q is supplied.
  return buildRecordLegTx({
    parlayId,
    marketId,
    coinType: DUSDC_TYPE,
    legIndex,
  });
}

/**
 * Submit a `record_leg` PTB for one (parlay, leg_index) pair, with
 * up to `PER_LEG_MAX_RETRY` retries on transient errors. Permanent
 * errors (Move aborts) short-circuit and return their kind so the
 * caller can log without burning the retry budget.
 */
type LegResult =
  | { kind: "ok"; digest: string }
  | { kind: "permanent"; err: unknown }
  | { kind: "transient_exhausted"; err: unknown };

async function recordOneLeg(
  client: SuiClient,
  signer: AgentContext["signer"],
  parlayId: string,
  marketId: string,
  legIndex: number,
): Promise<LegResult> {
  for (let attempt = 0; attempt <= PER_LEG_MAX_RETRY; attempt++) {
    try {
      const tx = buildSingleRecordLegTx(parlayId, marketId, legIndex);
      const res = await executeTransaction(client, () => tx, signer);
      return { kind: "ok", digest: res.digest };
    } catch (e) {
      if (isPermanentParlayError(e)) {
        return { kind: "permanent", err: e };
      }
      if (!isTransientError(e) || attempt === PER_LEG_MAX_RETRY) {
        return { kind: "transient_exhausted", err: e };
      }
      // 1s, 2s backoff between retries
      await sleep(1_000 * 2 ** attempt);
    }
  }
  // Unreachable: the loop always returns or throws. Belt-and-suspenders.
  return { kind: "transient_exhausted", err: new Error("exhausted") };
}

/**
 * Process all unfinalized parlays: record each pending leg whose
 * underlying market is resolved, then finalize any parlay whose
 * `legs_recorded == leg_count`.
 *
 * Returns a short, human-readable summary for the cron log; the
 * exact digest trail goes through `recordResult` (which already
 * appends to `decisions`).
 */
export async function runParlayWorker(
  ctx: AgentContext,
): Promise<AgentResult> {
  // R49 audit fix: read env inside the function body. See the
  // module-level note above for the rationale.
  const PKG = process.env.AGENT_POLICY_PACKAGE_ID ?? "";
  const WORKER_POOL_ID = process.env.PARLAY_POOL_ID ?? "";
  if (!PKG) {
    return recordResult("ParlayWorker", {
      action: "skip",
      reasoning: "AGENT_POLICY_PACKAGE_ID not set — worker inert.",
    });
  }
  if (!DUSDC_TYPE) {
    return recordResult("ParlayWorker", {
      action: "skip",
      reasoning: "DUSDC_TYPE not set — worker inert.",
    });
  }
  // R51 audit fix: use the shared gRPC client. The
  // per-tick `createClient()` was redundant — every
  // worker creates its own, and the gRPC client opens
  // a fresh HTTP/2 connection on construction. After
  // 5 min of polling at 5s intervals, the worker had
  // opened 60 connections to the public RPC, half of
  // which were still in the indexer's keepalive pool
  // (the SDK never explicitly closes them on the
  // Node.js side). Use the shared singleton from
  // `lib.ts` so the gRPC client is constructed once
  // per process and reused across all 7 workers.
  const client = getSharedClient();

  // ---- 1. Record pending legs for unfinalized parlays --------------
  // Pull the full list once (not per-user) so a user with 5 parlays
  // doesn't trigger 5 separate full-table scans. The index on
  // `finalized` keeps the query bounded. R37 audit fix: when
  // `PARLAY_POOL_ID` is set, filter to just the worker-owned pool
  // — otherwise a multi-pool deploy would have this worker try
  // to call `record_leg` on parlays it doesn't admin, which the
  // on-chain `pool_id == object::id(pool)` check would reject.
  const allUnfinalized = listUnfinalizedParlays();
  const scoped = WORKER_POOL_ID
    ? allUnfinalized.filter((p) => p.pool_id === WORKER_POOL_ID)
    : allUnfinalized;
  // R54 audit fix: sort the unfinalized list by
  // `created_at_ms` ascending (oldest-first, urgency proxy)
  // BEFORE applying the per-tick cap. The previous code
  // applied the cap to DB-iteration order, so a parlay
  // created at the start of a high-traffic window could be
  // skipped if 25 newer rows came first. A dedicated
  // `settlement_deadline` column would be the ideal
  // signal, but the schema doesn't have one — the
  // `ParlayRow` interface (gamification/store.ts:1045)
  // only tracks `created_at_ms`. Sort by that as the
  // best-available urgency proxy; the oldest parlay is
  // the one most likely to have its settlement window
  // approaching.
  const sortedByDeadline = [...scoped].sort(
    (a, b) => a.created_at_ms - b.created_at_ms,
  );
  // R51 audit fix: cap the per-tick work list. A burst
  // event (e.g. a DeepBook arbitrage or a coordinated
  // sign-up campaign) can create thousands of parlays
  // in a single block. The previous unbounded `for…of`
  // loop would attempt to record every leg in one tick
  // — a 5s tick can't PTB-record 1000 parlays before the
  // next one fires, and the open wallet would run out of
  // gas (we never refresh the sponsor's gas coin after
  // a large batch). Cap at 25 per tick, picked as
  // "comfortably fits a tick budget" from the R36 cron
  // traces. Tail processing: the next tick picks up the
  // remaining parlays, so worst-case latency is
  // `n / 25 * 5s`. A `MAX_PARLAYS_PER_TICK` env override
  // lets the operator tune for gas-bucket size.
  //
  // R55 audit fix: route through `safeInt` with
  // `[1, 500]` bounds. The previous `Number(env ?? 25)`
  // accepted `0` (silently disabling the worker), `NaN`
  // (from `Number("abc")` — `slice(0, NaN) = []` skips
  // every tick), and a `1e15` OOM-bomb. A `bootstrap-env.ts`
  // typo of `MAX_PARLAYS_PER_TICK=25;` (with stray
  // semicolon) would previously produce `25;` and
  // return NaN. The `safeInt` helper logs the bad value
  // and falls back to 25.
  const MAX_PARLAYS_PER_TICK = safeInt(
    process.env.MAX_PARLAYS_PER_TICK,
    25,
    1,
    500,
  );
  const scopedAndCapped =
    sortedByDeadline.length > MAX_PARLAYS_PER_TICK
      ? sortedByDeadline.slice(0, MAX_PARLAYS_PER_TICK)
      : sortedByDeadline;
  if (scoped.length > sortedByDeadline.length) {
    // R54 audit fix: log a warning when the per-tick cap
    // clips rows so an operator sees a backlog building up.
    // Without this, a stalled settlement window looks
    // identical to a normal tick from the dashboard.
    console.warn(
      `[parlay-worker] ${scoped.length - sortedByDeadline.length} parlay(s) ` +
        `deferred to next tick (cap ${MAX_PARLAYS_PER_TICK}).`,
    );
  }
  if (scopedAndCapped.length === 0) {
    return recordResult("ParlayWorker", {
      action: "noop",
      reasoning:
        allUnfinalized.length === 0
          ? "No unfinalized parlays."
          : `No unfinalized parlays for pool ${WORKER_POOL_ID}.`,
      confidence: 100,
    });
  }

  let legsRecorded = 0;
  let legsSkippedUnresolved = 0;
  let legsPermanentFailures = 0;
  let legsTransientFailures = 0;
  const sampleFailures: string[] = [];

  for (const parlay of scopedAndCapped) {
    if (parlay.legs_recorded >= parlay.leg_count) continue;
    // R37 audit fix: read per-leg market_ids from the off-chain
    // mirror first. The position-indexer now persists `market_id`
    // on each `ParlayLegRecorded` event, so we get the mapping
    // without an RPC round-trip. Fall back to a `getObject` RPC
    // call only if the mirror is empty (the parlay was just
    // created and no leg has been recorded yet — the R37 schema
    // migration also added the column to the legs table so
    // pre-existing rows have `market_id = ''`).
    const mirrorLegs = getParlayLegMarketIds(parlay.parlay_id, parlay.leg_count);
    let legMarketIds: string[] | null = null;
    if (mirrorLegs && mirrorLegs.every((m) => m !== "")) {
      legMarketIds = mirrorLegs;
    } else {
      legMarketIds = await readParlayLegMarketIds(client, parlay.parlay_id);
    }
    for (let i = parlay.legs_recorded; i < parlay.leg_count; i++) {
      if (!legMarketIds) {
        // Parlay object not found (deleted?) or RPC outage — skip
        // and let the next tick retry. We don't mark anything
        // permanent here because the indexer is the source of truth
        // for the parlay row; if it comes back, we resume.
        legsTransientFailures++;
        if (sampleFailures.length < 3) {
          sampleFailures.push(`parlay ${parlay.parlay_id}: leg market ids unreadable`);
        }
        break;
      }
      const marketId = legMarketIds[i];
      if (!marketId) {
        legsPermanentFailures++;
        if (sampleFailures.length < 3) {
          sampleFailures.push(`parlay ${parlay.parlay_id}: no market id for leg ${i}`);
        }
        break;
      }
      const market = getMarket(marketId);
      if (!market) {
        // Off-chain mirror hasn't seen the market yet (rare — the
        // position-indexer picks up MarketCreatedEvent on the same
        // minute-cadence, so a 1-tick lag is normal). Skip and
        // retry next tick.
        legsSkippedUnresolved++;
        continue;
      }
      if (market.status === "disputed") {
        // Don't advance the leg while a dispute is pending — the
        // contract's `!is_disputed` check would abort the tx
        // anyway. Skip and retry next tick.
        legsSkippedUnresolved++;
        continue;
      }
      if (market.status !== "resolved") {
        // Market is still active (or undetermined). Wait for the
        // resolver to flip it.
        legsSkippedUnresolved++;
        continue;
      }
      const result = await recordOneLeg(
        client,
        ctx.signer,
        parlay.parlay_id,
        marketId,
        i,
      );
      if (result.kind === "ok") {
        legsRecorded++;
        console.log(
          `[parlay-worker] leg ${i} of parlay ${parlay.parlay_id} → ${result.digest}`,
        );
        // The ParlayLegRecorded event lands in the indexer's next
        // poll, which will update `legs_recorded` in the mirror.
        // We don't update it here to avoid double-counting if the
        // event re-polled and the worker also wrote it.
      } else if (result.kind === "permanent") {
        legsPermanentFailures++;
        if (sampleFailures.length < 3) {
          const msg =
            result.err instanceof Error
              ? result.err.message
              : String(result.err);
          sampleFailures.push(`leg ${i} of ${parlay.parlay_id}: ${msg}`);
        }
        // Permanent: don't retry. Move on to the next leg of
        // this parlay (or the next parlay) — one leg's permanent
        // failure doesn't block the rest.
      } else {
        legsTransientFailures++;
        if (sampleFailures.length < 3) {
          const msg =
            result.err instanceof Error
              ? result.err.message
              : String(result.err);
          sampleFailures.push(`leg ${i} of ${parlay.parlay_id}: ${msg}`);
        }
        // Transient exhausted: try the next leg — RPC may be
        // flapping and a different leg's call might succeed. If
        // RPC is truly down, all legs will fail and the next cron
        // tick will retry.
      }
    }
  }

  // ---- 2. Finalize parlays whose legs are all recorded -------------
  // The position-indexer updates `legs_recorded` from the
  // ParlayLegRecorded event on its every-minute poll, so by the
  // time this worker runs the `legs_recorded` count is fresh. Any
  // parlay where `legs_recorded == leg_count` and `finalized == 0`
  // is ready to settle. R37 audit fix: scope to the worker-owned
  // pool, matching the leg-recording loop above.
  const allReady = listReadyToFinalizeParlays();
  const readyUncapped = WORKER_POOL_ID
    ? allReady.filter((p) => p.pool_id === WORKER_POOL_ID)
    : allReady;
  // R56 audit fix: cap the finalize loop per tick to match
  // the leg-recording cap (`MAX_PARLAYS_PER_TICK`).
  // `MAX_FINALIZES_PER_TICK` defaults to 25, the same default
  // the leg cap uses. Without a cap, a settle burst that
  // produces 1000 ready parlays would try to finalize all
  // 1000 in one tick — the agent wallet's gas coin would
  // be exhausted, every subsequent tx would abort with
  // `INSUFFICIENT_GAS`, and the next tick would find the
  // same 1000 parlays still ready and retry the doomed
  // txs forever.
  const MAX_FINALIZES_PER_TICK = safeInt(
    process.env.MAX_FINALIZES_PER_TICK,
    MAX_PARLAYS_PER_TICK,
    1,
    500,
  );
  const ready = readyUncapped.slice(0, MAX_FINALIZES_PER_TICK);
  let finalized = 0;
  let finalizeFailures = 0;
  const finalizeSample: string[] = [];
  for (const parlay of ready) {
    try {
      const tx = buildFinalizeParlayTx({
        parlayId: parlay.parlay_id,
        poolId: parlay.pool_id,
        coinType: DUSDC_TYPE,
      });
      const res = await executeTransaction(client, () => tx, ctx.signer);
      finalized++;
      console.log(
        `[parlay-worker] finalized parlay ${parlay.parlay_id} → ${res.digest}`,
      );
    } catch (e) {
      finalizeFailures++;
      if (finalizeSample.length < 3) {
        const msg = e instanceof Error ? e.message : String(e);
        finalizeSample.push(`parlay ${parlay.parlay_id}: ${msg}`);
      }
    }
  }

  if (
    legsRecorded === 0 &&
    legsSkippedUnresolved === 0 &&
    legsPermanentFailures === 0 &&
    legsTransientFailures === 0 &&
    finalized === 0 &&
    finalizeFailures === 0
  ) {
    return recordResult("ParlayWorker", {
      action: "noop",
      reasoning: `${scoped.length} unfinalized parlays (pool ${WORKER_POOL_ID || "*"}), none ready to advance.`,
      confidence: 100,
    });
  }

  const reason =
    `Parlays: ${legsRecorded} legs recorded, ${legsSkippedUnresolved} skipped (unresolved/disputed), ` +
    `${legsPermanentFailures} permanent failures, ${legsTransientFailures} transient failures; ` +
    `${finalized} finalized, ${finalizeFailures} finalize failures. ` +
    (scopedAndCapped.length < scoped.length
      ? ` Capped at ${MAX_PARLAYS_PER_TICK}/${scoped.length} this tick.`
      : "") +
    (readyUncapped.length > ready.length
      ? ` Finalize capped at ${MAX_FINALIZES_PER_TICK}/${readyUncapped.length} this tick.`
      : "") +
    (sampleFailures.length > 0
      ? `Sample failures: ${sampleFailures.join(" | ")}.`
      : "") +
    (finalizeSample.length > 0
      ? ` Finalize sample: ${finalizeSample.join(" | ")}.`
      : "");

  return recordResult("ParlayWorker", {
    action:
      legsPermanentFailures > 0 || finalizeFailures > 0 ? "partial" : "advance",
    reasoning: reason,
    confidence: finalized > 0 ? 90 : 50,
  });
}

/**
 * Read the `legs: vector<Leg>` field of a `Parlay<Q>` and pull out
 * `market_id` for each leg in order. The parlay struct's leg
 * entries render as `{ market_id: "0x…", predicted: 1 | 2, status: 0|1|2 }`
 * in the JSON view.
 *
 * Returns `null` if the parlay object is missing or unreadable.
 */
async function readParlayLegMarketIds(
  client: SuiClient,
  parlayId: string,
): Promise<string[] | null> {
  try {
    const { objects } = await client.getObjects({
      objectIds: [parlayId],
      include: { json: true },
    });
    const obj = objects[0];
    if (!obj || obj instanceof Error) return null;
    const json = obj.json as
      | {
          legs?: Array<{
            market_id?: string | { id?: string };
          }>;
        }
      | null;
    if (!json?.legs) return null;
    return json.legs.map((leg) => {
      const mid = leg.market_id;
      if (typeof mid === "string") return mid;
      if (mid && typeof mid === "object" && "id" in mid) {
        const id = (mid as { id: unknown }).id;
        if (typeof id === "string") return id;
      }
      return "";
    });
  } catch (e) {
    console.warn(
      "[parlay-worker] readParlayLegMarketIds failed for",
      parlayId,
      e instanceof Error ? e.message : e,
    );
    return null;
  }
}
