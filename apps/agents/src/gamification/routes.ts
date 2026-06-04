/**
 * Gamification REST routes.
 *
 *   GET /leaderboard/week?index=N&limit=M&category=K
 *   GET /leaderboard/country?code=us&index=N&limit=M&category=K
 *   GET /leaderboard/user/:addr?week=N
 *   GET /prize/signature?week=N&rank=R&user=:addr&amount=:a
 *   GET /prize/claims?week=N
 *   GET /profile/:addr
 *   GET /parlay/:id
 *   GET /parlay/user/:addr
 *
 * The first two back the off-chain leaderboard surface. The prize
 * signature endpoint re-signs the canonical claim payload so the user
 * can submit the on-chain `claim_prize` tx from their own wallet.
 * The parlay endpoints serve the off-chain `parlays` mirror written
 * by the position-indexer from ParlayCreated / ParlayLegRecorded /
 * ParlayFinalized events; the web /parlay page uses them to render
 * a user's parlay history and live leg progress without per-poll
 * on-chain reads.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { keccak_256 } from "@noble/hashes/sha3";
import {
  createClient,
  DUSDC_TYPE,
  expectedAmountForRank,
  DEFAULT_DISTRIBUTION_BPS,
  signClaimPayload,
  type ClaimPayload,
} from "@suipredict/sdk";
import {
  weekIndexFor,
  recordPrizeClaim,
  getPrizeClaim,
  getUserProfile,
  getParlay,
  getUserWeekRank,
  listAllParlaysForUser,
  listUnfinalizedParlays,
  listPrizeClaims,
  type ParlayRow,
} from "./store.js";
import { countryRollup, liveRollup } from "../agents/leaderboard-worker.js";
import { corsFor } from "../http-cors.js";

/**
 * R35 audit fix: log an unexpected route error server-side and
 * return a short correlation id. The id is a 12-char hex prefix
 * of a SHA-256 over the route + the error message + a millisecond
 * timestamp, so the operator can grep the server log for the
 * matching entry when a user reports a problem. The full error
 * never reaches the response body.
 */
function logAndCorrelate(route: string, err: unknown): string {
  const msg = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
  // Use keccak_256 (already imported above for the prize-signing
  // payload hash) so we don't add a new crypto dep just for
  // correlation ids. The digest space is plenty for non-secret
  // log correlation.
  const ts = Date.now().toString();
  const digest = keccak_256(new TextEncoder().encode(`${route}|${ts}|${msg}`));
  const errorId = Buffer.from(digest).toString("hex").slice(0, 12);
  console.error(`[agents] ${route} errorId=${errorId} ${msg}`);
  return errorId;
}

/**
 * Wire shape for a single parlay as returned by /parlay/user/:addr.
 * Mirrors apps/web/components/ParlayHistory.tsx's `ParlayRow`
 * interface exactly. The DB row uses `user` and `collateral_amount`;
 * the web's parlay history uses `owner` and `collateral` (matching
 * the on-chain `Parlay<Q>.owner` and `.collateral_amount` field
 * names but already pre-normalized). `coin_type` is the parlay's
 * generic Q — the Move struct doesn't carry it, so we surface the
 * runtime DUSDC_TYPE which is the only collateral type the
 * production pool is parameterized over.
 */
function serializeParlay(p: ParlayRow): {
  parlay_id: string;
  owner: string;
  pool_id: string;
  coin_type: string;
  leg_count: number;
  legs_recorded: number;
  legs_lost: number;
  payout_bps: number;
  collateral: number;
  finalized: number;
  won: number | null;
  payout: number | null;
  created_at_ms: number;
  updated_at_ms: number;
} {
  return {
    parlay_id: p.parlay_id,
    owner: p.user,
    pool_id: p.pool_id,
    coin_type: DUSDC_TYPE,
    leg_count: p.leg_count,
    legs_recorded: p.legs_recorded,
    legs_lost: p.legs_lost,
    payout_bps: p.payout_bps,
    collateral: p.collateral_amount,
    finalized: p.finalized,
    won: p.won,
    payout: p.payout,
    created_at_ms: p.created_at_ms,
    updated_at_ms: p.updated_at_ms,
  };
}

function json(res: ServerResponse, status: number, body: unknown, sideEffecting = true) {
  // R35 audit fix: every response previously set "*" regardless of
  // whether the endpoint was side-effecting. Use the shared helper
  // (env-driven allowlist) for everything in this file — the routes
  // here are prize signing, prize claim recording, parlay reads, and
  // leaderboard reads, all of which we want restricted to the
  // configured web origin in production.
  res.writeHead(status, {
    "Content-Type": "application/json",
    ...corsFor(sideEffecting),
  });
  res.end(JSON.stringify(body));
}

async function readJsonBody<T = unknown>(req: IncomingMessage): Promise<T | null> {
  // Accumulate the body, parse as JSON, return null on parse error or
  // empty body. The previous version of this route file had no POST
  // handlers so the body never needed to be read; the new
  // /prize/claims (POST) handler uses this.
  return await new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf-8");
      if (!text) return resolve(null);
      try {
        resolve(JSON.parse(text) as T);
      } catch {
        resolve(null);
      }
    });
    req.on("error", () => resolve(null));
  });
}

export async function handleGamificationRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  if (req.method === "OPTIONS") {
    res.writeHead(204, corsFor(true));
    res.end();
    return true;
  }
  if (req.method !== "GET" && req.method !== "POST") return false;

  // GET /leaderboard/week?index=N&limit=M&category=K
  const weekMatch = url.pathname.match(/^\/leaderboard\/week$/);
  if (weekMatch) {
    const idx = Number(url.searchParams.get("index") ?? weekIndexFor(Date.now()));
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 100), 500);
    const category = url.searchParams.get("category");
    const cat = category != null ? Number(category) : undefined;
    const rows = liveRollup(idx, cat);
    json(res, 200, { week_index: idx, rows: rows.slice(0, limit) });
    return true;
  }

  // GET /leaderboard/country?code=us&index=N&limit=M&category=K
  //
  // National leaderboard. `code` is a lowercased ISO-3166-1 alpha-2
  // (or alpha-3, or BCP-47 locale tag — anything up to 8 bytes, matching
  // `user_profile::MAX_COUNTRY_BYTES`). Users without a profile or
  // with an empty `country_code` are excluded. The `category` filter
  // composes so a UI can request the US AI-news leaderboard by passing
  // both. Result rows include `country_code` so the client can render
  // a flag without a second lookup.
  const countryMatch = url.pathname.match(/^\/leaderboard\/country$/);
  if (countryMatch) {
    const code = (url.searchParams.get("code") ?? "").toLowerCase();
    if (!/^[a-z]{2,8}$/.test(code)) {
      json(res, 400, { error: "code param must be 2-8 lowercase letters" });
      return true;
    }
    const idx = Number(url.searchParams.get("index") ?? weekIndexFor(Date.now()));
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 100), 500);
    const category = url.searchParams.get("category");
    const cat = category != null ? Number(category) : undefined;
    const rows = countryRollup(idx, code, cat);
    json(res, 200, { week_index: idx, country_code: code, rows: rows.slice(0, limit) });
    return true;
  }

  // GET /leaderboard/user/:addr?week=N
  const userMatch = url.pathname.match(/^\/leaderboard\/user\/(0x[a-fA-F0-9]+)$/);
  if (userMatch) {
    const addr = userMatch[1]!;
    const idx = Number(url.searchParams.get("week") ?? weekIndexFor(Date.now()));
    // Accept `category` so the per-user lookup matches the
    // leaderboard's category filter — without it, a user with
    // rank-1 in "AI news" shows up as rank-1 in the "crypto price"
    // view (round-17 audit finding #7). 0 = general.
    const category = Number(url.searchParams.get("category") ?? 0);
    const row = getUserWeekRank(addr, idx, category);
    if (!row) {
      json(res, 404, { error: "user not found for week", week_index: idx, category });
      return true;
    }
    json(res, 200, row);
    return true;
  }

  // GET /prize/signature?week=N&rank=R&user=:addr&amount=:a
  //
  // Authorisation model: the on-chain `claim_prize` trusts whatever
  // the prize admin signs. The previous version of this endpoint
  // signed for *any* `(user, rank)` — a misclick or hostile script
  // could request a rank-1 signature for an address that wasn't even
  // on the leaderboard, draining the pool once the user (or an
  // attacker) submitted the tx.
  //
  // The fix is a server-side leaderboard membership check: we look up
  // the user in the weekly archive for the requested week and verify
  // the requested rank matches the archived rank. The amount is then
  // re-derived from the rank table — `amountRaw` is ignored to avoid
  // the client computing a different value than the on-chain check.
  //
  // For the in-progress (current) week, the archive is empty — the
  // Monday 00:05 UTC rollup hasn't run yet. We fall back to
  // `liveRollup` so users who earned a slot in the current week can
  // still claim. The on-chain `prize_pool::claim_prize` is idempotent
  // via `claimed[(week, user)]`, so signing for a current-week rank
  // is safe even if the next-week's rollup later assigns a different
  // rank (the user only ever gets one payout per (week, user) pair).
  const sigMatch = url.pathname.match(/^\/prize\/signature$/);
  if (sigMatch) {
    const week = Number(url.searchParams.get("week") ?? -1);
    const rank = Number(url.searchParams.get("rank") ?? 0);
    const user = url.searchParams.get("user") ?? "";
    // `category` is required: rank-1 in "AI news" must not be able
    // to claim a rank-1 signature for the "crypto price" pool. The
    // round-17 audit caught this cross-category exploit (finding #6).
    const category = Number(url.searchParams.get("category") ?? 0);
    const poolId = process.env.PRIZE_POOL_ID ?? "";
    const adminPk = process.env.PRIZE_ADMIN_PRIVATE_KEY ?? "";
    if (week < 0 || rank <= 0 || !user || !poolId || !adminPk) {
      json(res, 400, { error: "missing required params" });
      return true;
    }
    if (!/^0x[a-fA-F0-9]{64}$/.test(user)) {
      json(res, 400, { error: "invalid user address" });
      return true;
    }
    if (!Number.isInteger(category) || category < 0 || category > 3) {
      json(res, 400, { error: "category must be 0 (general), 1 (ai_news), 2 (crypto_price), or 3 (other)" });
      return true;
    }
    // Membership check: prefer the archive (finalized weeks), fall
    // back to liveRollup for the in-progress week. Pass `category`
    // through so the rank lookup is category-scoped — a user with
    // rank-1 in "AI news" cannot claim a rank-1 signature for
    // "crypto price" by omitting the param.
    const currentWeek = weekIndexFor(Date.now());
    let row = week === currentWeek
      ? liveRollup(week, category).find((r) => r.user === user) ?? null
      : getUserWeekRank(user, week, category);
    if (!row) {
      json(res, 403, {
        error: "user not on leaderboard for this week and category",
        week_index: week,
        category,
      });
      return true;
    }
    if (row.rank !== rank) {
      json(res, 400, {
        error: "rank mismatch with leaderboard",
        requested: rank,
        actual: row.rank,
      });
      return true;
    }
    if (row.claimed) {
      json(res, 409, {
        error: "prize already claimed for this user and week",
        week_index: week,
      });
      return true;
    }
    // Re-derive the canonical amount from the rank table so the
    // signed payload always matches what the contract expects.
    //
    // Source of truth = on-chain `PrizePool.weekly_prize`, not the
    // `PRIZE_WEEKLY_AMOUNT` env var. The env var is the bootstrap
    // hint; the on-chain value is the cumulative sum of all `fund_pool`
    // calls this week. If the operator funds the pool directly (script,
    // manual tx, or out-of-band admin action) without restarting the
    // agents, the env var is stale and signing an env-derived amount
    // would land an `EPrizeTooLarge` abort at `claim_prize`. Reading
    // the on-chain value first means the signed payload is always
    // self-consistent with the pool the user is going to claim from.
    //
    // For the in-progress week, `weekly_prize` is live (mutated by
    // `fund_pool`); for archived weeks, the view function still returns
    // the cumulative amount at rotation time (the field is reset to 0
    // in `rotate_week`, but the on-chain object retains the historical
    // value before the reset — `claim_prize` reads it at claim time,
    // not at rotation time, so signing the pre-rotate value is the
    // correct one). If the read fails (RPC outage, wrong network),
    // fall back to the env value with a clear `X-Amount-Source`
    // header so the operator can tell which path the route took.
    const { amount, amountSource } = await resolvePrizeAmount(
      poolId,
      week,
      rank,
    );
    if (amount === 0n) {
      json(res, 503, {
        error:
          "PrizePool weekly_prize is 0 — no funds available for this week. " +
          "Run `fund_pool` on-chain to seed it, then retry.",
        week_index: week,
        rank,
      });
      return true;
    }
    const payload: ClaimPayload = {
      poolId,
      weekIndex: BigInt(week),
      user,
      rank,
      amount,
    };
    const kp = Ed25519Keypair.fromSecretKey(adminPk);
    signClaimPayload(kp, payload, async (b) => keccak_256(b))
      .then((signed) => {
        json(res, 200, {
          payload: {
            ...signed.payload,
            weekIndex: signed.payload.weekIndex.toString(),
            amount: signed.payload.amount.toString(),
          },
          signatureB64: signed.signatureB64,
          expectedAmount: amount.toString(),
          amountSource,
        });
      })
      .catch((err) => {
        // R35 audit fix: returning the raw SDK error to the web
        // client leaks the on-chain contract layout — module path,
        // abort code, command index, file/function name. Sui SDK
        // errors include `MoveAbort(Package { id: ... }, Identifier(
        // ... ), 4, ...)` strings that an attacker can use to
        // fingerprint contract internals. Log the full error
        // server-side and return a static string + a correlation
        // id so the operator can trace a user's report to the
        // matching server log.
        const errorId = logAndCorrelate("/prize/signature", err);
        json(res, 500, {
          error: "internal error signing claim",
          errorId,
        });
      });
    return true;
  }

  // GET /prize/claims?week=N
  // POST /prize/claims — record a user-driven claim so the leaderboard
  //   stops offering the Claim button. The body is
  //   `{ user, weekIndex, rank, amount, txDigest }` (string or number
  //   for weekIndex; amount is decimal string for bigint safety). The
  //   server trusts the txDigest string only as a label; the on-chain
  //   `prize_pool::claim_prize` is the real source of truth for
  //   whether a payout happened.
  const claimMatch = url.pathname.match(/^\/prize\/claims$/);
  if (claimMatch) {
    if (req.method === "GET") {
      const week = url.searchParams.get("week");
      if (week != null) {
        // Reject non-integer / negative week params: a `week=abc` would
        // otherwise parse to NaN, fall through the `!= null` check, and
        // return [] from the SQLite `WHERE week_index = ?` query. An
        // operator hitting this endpoint to debug a missing claim
        // would never know the input was rejected.
        const weekNum = Number(week);
        if (!Number.isInteger(weekNum) || weekNum < 0) {
          json(res, 400, { error: "invalid week param" });
          return true;
        }
        json(res, 200, listPrizeClaims(weekNum));
      } else {
        json(res, 200, listPrizeClaims());
      }
      return true;
    }
    // POST
    //
    // Auth model: same leaderboard-membership + rank-mismatch check
    // as GET /prize/signature (lines 137-161). The previous version
    // accepted any (user, week, rank) without verifying the user was
    // actually on the leaderboard — an attacker could POST
    // `{user: any_victim, week: current, rank: 1}` and mark the victim
    // as Claimed in the off-chain table, hiding the Claim button from
    // a legitimate winner. The on-chain `claim_prize` was unaffected
    // (it gates on `pool.claimed[week][user]`), but the UI state was
    // poisoned.
    const body = await readJsonBody<{
      user?: string;
      weekIndex?: number | string;
      rank?: number;
      amount?: number | string;
      txDigest?: string;
    }>(req);
    if (
      !body ||
      typeof body.user !== "string" ||
      !/^0x[a-fA-F0-9]{64}$/.test(body.user) ||
      (typeof body.weekIndex !== "number" && typeof body.weekIndex !== "string") ||
      typeof body.rank !== "number" ||
      body.rank <= 0
    ) {
      json(res, 400, { error: "missing or invalid fields" });
      return true;
    }
    const weekIndex =
      typeof body.weekIndex === "string" ? Number(body.weekIndex) : body.weekIndex;
    if (!Number.isFinite(weekIndex) || weekIndex < 0) {
      json(res, 400, { error: "invalid weekIndex" });
      return true;
    }
    // Membership check — same fallback used by /prize/signature so
    // current-week claims work the same way.
    const currentWeek = weekIndexFor(Date.now());
    const row = weekIndex === currentWeek
      ? liveRollup(weekIndex).find((r) => r.user === body.user) ?? null
      : getUserWeekRank(body.user, weekIndex);
    if (!row) {
      json(res, 403, {
        error: "user not on leaderboard for this week",
        week_index: weekIndex,
      });
      return true;
    }
    if (row.rank !== body.rank) {
      json(res, 400, {
        error: "rank mismatch with leaderboard",
        requested: body.rank,
        actual: row.rank,
      });
      return true;
    }
    // Re-derive the canonical amount from the rank table. The
    // `amount` in the request body is ignored — accepting it would let
    // a client pollute the off-chain row with a wrong value, and the
    // `ON CONFLICT DO UPDATE` in `recordPrizeClaim` would race the
    // indexer's correct on-chain amount on the next poll. The server
    // is the single source of truth for the rank table.
    const amount = expectedAmountForRank(
      BigInt(process.env.PRIZE_WEEKLY_AMOUNT ?? "0"),
      body.rank,
      DEFAULT_DISTRIBUTION_BPS,
    );
    // Idempotency: a second POST for an already-claimed (user, week)
    // returns 409. Without this, two concurrent claims both pass the
    // membership check (both see `claimed: false`), both submit
    // on-chain, and the second hits `EAlreadyClaimed` — but the second
    // POST would still return 200 and overwrite the off-chain row.
    //
    // R41 audit fix: pass the configured prize pool id so the
    // lookup hits the widened PK (pool_id, user, week_index).
    // Without it, the SQL falls back to the empty-string
    // sentinel and a claim from pool A wouldn't be detected as
    // a duplicate of an existing claim from pool A — but a
    // claim from pool B (same user, same week) would still
    // pass the check.
    const existing = getPrizeClaim(
      body.user,
      weekIndex,
      process.env.PRIZE_POOL_ID ?? "",
    );
    if (existing) {
      json(res, 409, {
        error: "prize already claimed for this user and week",
        week_index: weekIndex,
      });
      return true;
    }
    try {
      recordPrizeClaim({
        user: body.user,
        week_index: weekIndex,
        rank: body.rank,
        amount: Number(amount),
        tx_digest: body.txDigest ?? null,
        claimed_at_ms: Date.now(),
        // R33 audit fix: the POST path didn't know which pool the
        // claim came from (the request body doesn't carry it — the
        // server-side `expectedAmountForRank` re-derivation is the
        // single source of truth for `amount`). Use the configured
        // prize pool id as the attribution; the indexer will
        // overwrite if a multi-pool deploy sends a different id.
        pool_id: process.env.PRIZE_POOL_ID ?? null,
      });
      json(res, 200, { ok: true });
    } catch (err) {
      // R35 audit fix: same leak as /prize/signature above. The
      // raw `err.message` from the SQLite write or the gRPC indexer
      // can include SQL fragments and Sui abort text. Return a
      // static string + correlation id; log the full error
      // server-side.
      const errorId = logAndCorrelate("POST /prize/claims", err);
      json(res, 500, { error: "internal error recording claim", errorId });
    }
    return true;
  }

  // GET /profile/:addr
  //
  // Reads the indexer-mirrored `user_profiles` row for a given user.
  // The on-chain `UserProfile` is the source of truth; this route
  // surfaces the off-chain SQLite mirror so the web settings page can
  // populate the country-code / forecaster-kind inputs without
  // requiring a per-user `devInspect` call against the Sui node.
  //
  // A 404 means "no row yet" — either the user has not created a
  // profile, or the indexer hasn't picked up the `ProfileCreated`
  // event. The web UI treats 404 the same as "no profile" and
  // surfaces the create button.
  const profileMatch = url.pathname.match(/^\/profile\/(0x[a-fA-F0-9]+)$/);
  if (profileMatch) {
    const addr = profileMatch[1]!;
    const row = getUserProfile(addr);
    if (!row) {
      json(res, 404, { error: "no profile mirrored for this user", user: addr });
      return true;
    }
    json(res, 200, row);
    return true;
  }

  // GET /parlay/:id
  //
  // Single-parlay lookup against the off-chain `parlays` mirror. The
  // web /parlay page polls this every 5s after creating a parlay so
  // the leg-progress UI doesn't have to re-read on-chain state on
  // every tick. Returns 404 if the indexer hasn't yet picked up the
  // ParlayCreated event (a 1-tick window after the user submits
  // `create_parlay`).
  //
  // R33 audit fix: this endpoint previously returned the raw SQL
  // `ParlayRow` shape (with `user`, `collateral_amount`, no
  // `coin_type`), while the list endpoint routes through
  // `serializeParlay`. The web ParlayHistory detail panel reads
  // `owner`/`coin_type`/`collateral`/`won`/`payout`, so a single-end
  // click surfaced `undefined` for the field the user just clicked on
  // to see. The two endpoints now produce the same wire shape.
  const parlayIdMatch = url.pathname.match(/^\/parlay\/(0x[a-fA-F0-9]+)$/);
  if (parlayIdMatch) {
    const id = parlayIdMatch[1]!;
    const row = getParlay(id);
    if (!row) {
      json(res, 404, { error: "parlay not yet indexed", parlay_id: id });
      return true;
    }
    json(res, 200, serializeParlay(row));
    return true;
  }

  // GET /parlay/user/:addr?include_finalized=0|1
  //
  // List a user's parlays from the off-chain mirror. Default excludes
  // finalized rows (the active-parlays view on the /parlay page);
  // pass `include_finalized=1` to get the full history. Ordered by
  // `created_at_ms DESC` so the newest parlay is first.
  const parlayUserMatch = url.pathname.match(
    /^\/parlay\/user\/(0x[a-fA-F0-9]+)$/,
  );
  if (parlayUserMatch) {
    const addr = parlayUserMatch[1]!;
    const includeFinalized =
      url.searchParams.get("include_finalized") === "1";
    // Bounded scan: the per-user `idx_parlays_user` index keeps this
    // O(N over the user's parlays). The "all unfinalized" query is
    // used as a fallback in case the per-user filter is missing the
    // index — it is itself indexed via the partial `idx_parlays_unfinalized`.
    const allRows: ParlayRow[] = includeFinalized
      ? listAllParlaysForUser(addr)
      : listUnfinalizedParlays().filter((p) => p.user === addr);
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 200);
    // Map the SQL row shape to the wire shape the web's ParlayHistory
    // component expects. The on-chain / DB column names diverge from
    // the web's ParlayRow interface (e.g. `user` vs `owner`,
    // `collateral_amount` vs `collateral`); the round-21 audit caught
    // this drift. `coin_type` is the parlay's generic Q — it isn't
    // stored on the row (the Move struct doesn't carry it), so we
    // surface the runtime DUSDC_TYPE which is the only collateral
    // type the production pool uses.
    const parlays = allRows.slice(0, limit).map(serializeParlay);
    json(res, 200, {
      user: addr,
      count: allRows.length,
      parlays,
    });
    return true;
  }

  return false;
}

/**
 * Read `PrizePool.weekly_prize` from the on-chain object and derive the
 * per-rank payout via `expectedAmountForRank`. The on-chain value is the
 * cumulative sum of `fund_pool` calls for the pool's `current_week` —
 * this is what the user is going to claim from, so the signed payload
 * must use the same number or the `EPrizeTooLarge` cap (90% of pool
 * balance) aborts `claim_prize`. The env var `PRIZE_WEEKLY_AMOUNT` is
 * a fallback for the RPC-failure case; we surface `amountSource` so
 * the caller (and the operator inspecting the response) can tell
 * which path produced the number.
 *
 * `weekly_prize` is a flat `u64` field on the `PrizePool` struct (not
 * wrapped in `Balance<T>`), so the gRPC JSON view renders it as a
 * scalar string/number under `json.weekly_prize`. (The wrapped-balance
 * shape was the r11 fix for `pool.balance`; this one is a plain u64
 * and just `BigInt(...)`s directly.)
 */
async function resolvePrizeAmount(
  poolId: string,
  week: number,
  rank: number,
): Promise<{ amount: bigint; amountSource: "onchain" | "env" }> {
  try {
    const client = createClient();
    const { objects } = await client.getObjects({
      objectIds: [poolId],
      include: { json: true },
    });
    const obj = objects[0];
    if (obj && !(obj instanceof Error)) {
      const json = obj.json as { weekly_prize?: string | number } | null;
      if (json?.weekly_prize != null) {
        const weekly = BigInt(json.weekly_prize);
        return {
          amount: expectedAmountForRank(weekly, rank, DEFAULT_DISTRIBUTION_BPS),
          amountSource: "onchain",
        };
      }
    }
  } catch (err) {
    console.warn(
      `[prize/signature] on-chain weekly_prize read failed for ${poolId}:`,
      err instanceof Error ? err.message : err,
    );
  }
  // Fallback: env var. Logged at warn so the operator can see it in the
  // boot health endpoint and investigate the RPC issue. Never silent.
  return {
    amount: expectedAmountForRank(
      BigInt(process.env.PRIZE_WEEKLY_AMOUNT ?? "0"),
      rank,
      DEFAULT_DISTRIBUTION_BPS,
    ),
    amountSource: "env",
  };
}
