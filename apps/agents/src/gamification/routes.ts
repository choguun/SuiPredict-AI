/**
 * Gamification REST routes.
 *
 *   GET /leaderboard/week?index=N&limit=M&category=K
 *   GET /leaderboard/country?code=us&index=N&limit=M&category=K
 *   GET /leaderboard/user/:addr?week=N
 *   GET /prize/signature/challenge?user=:addr
 *   GET /prize/signature?week=N&rank=R&user=:addr&amount=:a&nonce=…&signature=…&publicKey=…
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
import { verifyPersonalMessageSignature } from "@mysten/sui/verify";
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
  listUnfinalizedParlaysForUser,
  listPrizeClaims,
  type ParlayRow,
} from "./store.js";
import { countryRollup, liveRollup } from "../agents/leaderboard-worker.js";
import { corsFor } from "../http-cors.js";
import { getSharedClient } from "../lib.js";
import { tryConsume as tryRateLimit } from "../rate-limit.js";
import { consumeNonce, issueNonce } from "./nonce-store.js";

/**
 * Best-effort client-IP extraction. The agents
 * service is fronted by Railway's edge which
 * sets `X-Forwarded-For`; fall back to the
 * raw socket address. Returns `"unknown"` if
 * neither is present (a misconfigured deploy)
 * — the rate limiter still works because all
 * "unknown" callers share a single bucket.
 */
function clientIp(req: IncomingMessage): string {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.length > 0) {
    // R52 audit fix: take the
    // *right-most* untrusted
    // entry from
    // `X-Forwarded-For`. The
    // previous left-most
    // behavior used the
    // client's claimed
    // address, which is
    // trivially spoofable —
    // a script setting
    // `X-Forwarded-For:
    // 1.2.3.4` in every
    // request would have
    // every request land
    // in a fresh bucket
    // and bypass the rate
    // limiter entirely.
    // The right-most entry
    // is the closest to
    // the application
    // (the last proxy
    // hop), which is
    // what Railway's edge
    // sets. Trust only
    // the last comma-
    // separated value.
    return xff.split(",").pop()!.trim();
  }
  return req.socket?.remoteAddress ?? "unknown";
}

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

function json(res: ServerResponse, status: number, body: unknown, sideEffecting = true, extraHeaders?: Record<string, string>) {
  // R35 audit fix: every response previously set "*" regardless of
  // whether the endpoint was side-effecting. Use the shared helper
  // (env-driven allowlist) for everything in this file — the routes
  // here are prize signing, prize claim recording, parlay reads, and
  // leaderboard reads, all of which we want restricted to the
  // configured web origin in production.
  //
  // R51 audit fix: accept an `extraHeaders` bag for
  // 429 `Retry-After` and any future per-route
  // metadata. A 429 without a `Retry-After` header
  // forces the client to retry with a hard-coded
  // backoff (or worse, an exponential one without a
  // cap), amplifying the original rate-limit
  // pressure. RFC 6585 §4 specifies `Retry-After`
  // for 429; the value is a delta-seconds integer
  // derived from the bucket's refill rate.
  res.writeHead(status, {
    "Content-Type": "application/json",
    ...corsFor(sideEffecting),
    ...(extraHeaders ?? {}),
  });
  res.end(JSON.stringify(body));
}

async function readJsonBody<T = unknown>(req: IncomingMessage): Promise<T | null> {
  // Accumulate the body, parse as JSON, return null on parse error or
  // empty body. The previous version of this route file had no POST
  // handlers so the body never needed to be read; the new
  // /prize/claims (POST) handler uses this.
  //
  // R47 audit fix: cap the body size at 64KB. The previous
  // implementation accumulated chunks into a `Buffer[]` with
  // no upper bound — a client POSTing a multi-MB JSON
  // (or a `text/plain` body masquerading as JSON) would
  // exhaust the agents process memory before the
  // `JSON.parse` ever rejected it. 64KB is well above
  // the largest legitimate payload (a /prize/claims body
  // with `txDigest` and a 64-hex user address is <1KB)
  // and well below the V8 default heap of ~1.5GB even
  // at 10K concurrent requests. Return null on overflow
  // so the caller treats it as a malformed body and
  // responds 400 with the standard `error` shape.
  return await new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const MAX = 64 * 1024;
    req.on("data", (c) => {
      const buf = c as Buffer;
      total += buf.length;
      if (total > MAX) {
        // R47 audit fix: drain so the request
        // socket doesn't hang on the next keepalive.
        req.resume();
        return resolve(null);
      }
      chunks.push(buf);
    });
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
    // R49 audit fix: require an integer week index and a
    // finite, positive limit. The previous code accepted `NaN`
    // (falsy `??` fallback when the param was an unparseable
    // string), which silently returned an empty `rows` array —
    // a UI consumer would render an empty leaderboard with no
    // signal that the input was malformed.
    const idx = Number(url.searchParams.get("index") ?? weekIndexFor(Date.now()));
    if (!Number.isInteger(idx) || idx < 0) {
      json(res, 400, { error: "index must be a non-negative integer" });
      return true;
    }
    const rawLimit = Number(url.searchParams.get("limit") ?? 100);
    const limit =
      Number.isFinite(rawLimit) && rawLimit > 0
        ? Math.min(rawLimit, 500)
        : 100;
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
    // R49 audit fix: same NaN/integer validation as the
    // /leaderboard/week route above.
    const idx = Number(url.searchParams.get("index") ?? weekIndexFor(Date.now()));
    if (!Number.isInteger(idx) || idx < 0) {
      json(res, 400, { error: "index must be a non-negative integer" });
      return true;
    }
    const rawLimit = Number(url.searchParams.get("limit") ?? 100);
    const limit =
      Number.isFinite(rawLimit) && rawLimit > 0
        ? Math.min(rawLimit, 500)
        : 100;
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
    // R49 audit fix: require a non-negative integer week index.
    // The previous code accepted `NaN` (the `??` fallback fires
    // when the param is missing, not when it's a non-numeric
    // string — `Number("abc")` is `NaN`) and the SQL `WHERE
    // week_index = ?` quietly returned no rows. The user
    // looked up a malformed week and got a 404 with no
    // actionable signal.
    if (!Number.isInteger(idx) || idx < 0) {
      json(res, 400, { error: "week must be a non-negative integer" });
      return true;
    }
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

  // GET /prize/signature/challenge?user=:addr
  //
  // R51 audit fix: the wallet-challenge nonce flow. The
  // previous `/prize/signature` accepted any `(user, rank)`,
  // re-derived the leaderboard membership server-side, and
  // signed for whoever showed up at rank-1. The remaining
  // gap: a script that watched the leaderboard and knew a
  // rank-1 address could request a signature for *that*
  // user. If the user later signed whatever tx the server
  // produced, the script controlled which tx the wallet
  // signed (via a phishing page that pointed to the script's
  // server), draining the pool.
  //
  // The fix is a 2-call challenge/response: this endpoint
  // issues a 32-byte nonce bound to `user` (60s TTL,
  // single-use, in-memory map); the client signs the
  // canonical message with their wallet, then passes the
  // signature back to `/prize/signature`. The signature
  // proves the client holds the private key for `user`,
  // closing the script-driven drain.
  const challengeMatch = url.pathname.match(/^\/prize\/signature\/challenge$/);
  if (challengeMatch) {
    const user = url.searchParams.get("user") ?? "";
    if (!/^0x[a-fA-F0-9]{64}$/.test(user)) {
      json(res, 400, { error: "invalid user address" });
      return true;
    }
    // Rate-limit per (ip) and per (user) on challenge
    // issuance. A bot that hammers this endpoint to
    // evict other users' unconsumed nonces (the
    // issueNonce path evicts the prior nonce for the
    // same user) should be capped.
    if (
      !tryRateLimit(`prize-chal:ip:${clientIp(req)}`, {
        capacity: 20,
        refillPerMinute: 20,
      }) ||
      !tryRateLimit(`prize-chal:user:${user}`, {
        capacity: 5,
        refillPerMinute: 5,
      })
    ) {
      // R51 audit fix: emit `Retry-After` so the
      // client can back off cleanly. The bucket
      // refills at 5/min, so the next available
      // slot is in `60s / 5 = 12s` minimum. Use
      // 12s as the per-route constant.
      json(
        res,
        429,
        { error: "rate limit exceeded; try again later" },
        true,
        { "Retry-After": "12" },
      );
      return true;
    }
    const { nonce, message, expiresAtMs } = issueNonce(user);
    json(res, 200, { nonce, message, expiresAtMs });
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
    // R50 audit fix: rate-limit per (ip) and per (user).
    // The user bucket is the stricter of the two
    // (a single user shouldn't be able to mint
    // 1000 sigs/min even from different IPs).
    // In-memory only — see `rate-limit.ts` for the
    // cross-replica caveat. 5 sigs/min, burst 5.
    if (
      !tryRateLimit(`prize-sig:ip:${clientIp(req)}`, {
        capacity: 10,
        refillPerMinute: 10,
      }) ||
      !tryRateLimit(`prize-sig:user:${user}`, {
        capacity: 5,
        refillPerMinute: 5,
      })
    ) {
      // R51 audit fix: emit `Retry-After`. The user
      // bucket refills at 5/min (12s per token).
      json(
        res,
        429,
        { error: "rate limit exceeded; try again later" },
        true,
        { "Retry-After": "12" },
      );
      return true;
    }
    // R49 audit fix: require integer week/rank. `NaN < 0` and
    // `NaN <= 0` are both false, so a fuzzing client could pass
    // `?week=abc&rank=xyz` and reach the SDK's `pure.u64(NaN)`,
    // which fails at sign time with a confusing wallet error.
    // The `category` guard below already uses `Number.isInteger`;
    // apply the same to week and rank. Also enforce rank ≤ 100 to
    // match on-chain `MAX_RANK` and the existing /prize/claims cap.
    if (
      !Number.isInteger(week) || week < 0 ||
      !Number.isInteger(rank) || rank <= 0 || rank > 100 ||
      !user || !poolId || !adminPk
    ) {
      json(res, 400, { error: "missing or invalid params (week/rank must be integers, rank ≤ 100)" });
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
    // R51 audit fix: wallet-challenge nonce flow. The client
    // must first call `/prize/signature/challenge?user=:addr`
    // to obtain a 32-byte nonce bound to `user`, sign the
    // canonical message with their wallet, and pass the
    // resulting Sui-formatted signature here. The signature
    // proves the caller holds the private key for `user`;
    // without it, any caller who knew the user's address
    // could request a rank-1 signature and hand the user a
    // phishing tx to sign (closing the script-driven drain
    // finding from R51).
    const nonce = url.searchParams.get("nonce") ?? "";
    const signatureB64 = url.searchParams.get("signature") ?? "";
    if (!nonce || !signatureB64) {
      json(res, 400, {
        error: "wallet challenge required: call /prize/signature/challenge first, sign the returned message, then resubmit with nonce+signature",
      });
      return true;
    }
    // The signature is the Sui base64-encoded
    // `flag || sig || pubkey` triple. The signature
    // scheme for an ed25519 wallet is fixed (flag = 0x00),
    // so the size is exactly 1 + 64 + 32 = 97 bytes
    // before base64 encoding. Validate the length up
    // front to fail fast on garbage input.
    if (signatureB64.length !== 132) {
      json(res, 400, { error: "signature has invalid length; expected 132 base64 chars" });
      return true;
    }
    // The nonce is hex (32 bytes = 64 hex chars). Validate
    // the format and look it up in the issued-nonce map.
    // The map enforces the (nonce, user) binding, the
    // single-use invariant, and the 60s TTL.
    const nonceResult = consumeNonce(nonce, user);
    if (!nonceResult.ok) {
      json(res, 401, {
        error: `wallet challenge failed: ${nonceResult.reason}`,
        reason: nonceResult.reason,
      });
      return true;
    }
    // Build the canonical message the client signed
    // (must match the format in `nonce-store.ts` exactly).
    const message = `SuiPredict Prize Claim\nnonce: ${nonce}\nuser: ${user}`;
    // Verify the signature over `message` recovers to
    // `user`. `verifyPersonalMessageSignature` is the
    // Sui SDK's wrapper for the ed25519 verifier with
    // the PersonalMessage intent prefix; it throws on
    // a bad signature or a pubkey that doesn't match
    // the bound address.
    try {
      await verifyPersonalMessageSignature(
        new TextEncoder().encode(message),
        signatureB64,
        { address: user },
      );
    } catch (err) {
      const errorId = logAndCorrelate("/prize/signature", err);
      json(res, 401, {
        error: "wallet signature does not verify against user address",
        errorId,
      });
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
    // R42 audit fix: `Ed25519Keypair.fromSecretKey` throws
    // synchronously for malformed `adminPk` (bad base64, wrong
    // length, not 32 bytes after decoding). The previous code
    // called it inline and a bad env value (typo in
    // `PRIZE_ADMIN_PRIVATE_KEY`, leading/trailing whitespace, an
    // accidental `0x` prefix) would propagate the throw out of
    // the request handler — turning the route into a 500 with a
    // raw Sui SDK error message, not the JSON error envelope
    // the rest of the route returns. Catch the sync throw here
    // and convert it into the same `errorId`-correlated 500 the
    // async sign path already returns.
    let kp: Ed25519Keypair;
    try {
      kp = Ed25519Keypair.fromSecretKey(adminPk);
    } catch (err) {
      const errorId = logAndCorrelate("/prize/signature", err);
      json(res, 500, {
        error: "internal error: server-side admin keypair is misconfigured",
        errorId,
      });
      return true;
    }
    // R47 audit fix: the previous `signClaimPayload(...).then(...).catch(...)`
    // pattern returned `true` immediately, before the
    // promise resolved. The `.catch` only handled
    // async rejections; a synchronous throw inside
    // `signClaimPayload` (e.g. a future SDK change
    // that validates inputs eagerly) would escape
    // both the `.then` and the `.catch`, leaving
    // the response uncompleted (the Node http
    // server eventually times out the socket with
    // a 502 / connection-reset that the web
    // renders as a confusing parse error).
    // Convert to `await` inside the handler so a
    // sync throw is caught by the surrounding
    // try/catch and a clean 500 is sent.
    try {
      const signed = await signClaimPayload(
        kp,
        payload,
        async (b) => keccak_256(b),
      );
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
    } catch (err) {
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
    }
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
    // R50 audit fix: rate-limit per (ip) before doing
    // any work. The on-chain `claimed[user]` map
    // prevents double-payout but each request still
    // hits the leaderboard archive + writes to
    // SQLite. 10 POSTs/min/IP, burst 10.
    if (
      !tryRateLimit(`prize-claim:ip:${clientIp(req)}`, {
        capacity: 10,
        refillPerMinute: 10,
      })
    ) {
      // R51 audit fix: emit `Retry-After`. The
      // bucket refills at 10/min (6s per token).
      json(
        res,
        429,
        { error: "rate limit exceeded; try again later" },
        true,
        { "Retry-After": "6" },
      );
      return true;
    }
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
      // R50 audit fix: `category` is now required so the
      // membership check at line 598 is category-scoped.
      // The previous handler passed no category to either
      // `liveRollup(weekIndex)` or `getUserWeekRank(...)`,
      // both of which default to category=0. A user who
      // was rank-1 in category 1 (AI news) could POST
      // `{user: me, week: 1, rank: 1}` to this endpoint
      // — the membership check would find them on the
      // global (category=0) leaderboard, the rank check
      // would pass, and the off-chain `prize_claims` row
      // would be written, marking their AI-news claim as
      // done. When the AI-news pool's admin signed the
      // legit on-chain tx, the off-chain mirror would
      // already say "claimed" — and worse, the off-chain
      // row would carry no category, so an operator
      // dashboard audit would lose the category
      // attribution. Same hardening /prize/signature
      // got in round-17.
      category?: number;
      // R46 audit fix: accept an optional `poolId` so a
      // multi-pool deploy (one prize pool per market
      // category, say) can attribute the claim to the
      // correct pool without the server having to
      // hardcode `process.env.PRIZE_POOL_ID`. The web
      // currently doesn't send this — it's an
      // additive, opt-in field — but the operator-
      // dashboard view of prize claims should not be
      // silently corrupting the (pool_id, user, week)
      // PK by attributing every claim to whichever
      // pool the server happened to boot with.
      poolId?: string;
    }>(req);
    if (
      !body ||
      typeof body.user !== "string" ||
      !/^0x[a-fA-F0-9]{64}$/.test(body.user) ||
      (typeof body.weekIndex !== "number" && typeof body.weekIndex !== "string") ||
      typeof body.rank !== "number" ||
      body.rank <= 0 ||
      // R48 audit fix: cap `rank` at 100. The on-chain
      // `prize_pool::claim_prize` aborts on `rank > 100`, but the
      // off-chain `prize_claims` row is written *before* the user
      // submits the on-chain tx. A `rank=999999` request would
      // either store `expectedAmountForRank` returning 0 (so the
      // row lands with a nonsense rank) or — if the user forges
      // the on-chain tx — succeed at the mirror layer and burn
      // gas at the chain layer. The leaderboard's max rank is 100.
      body.rank > 100
    ) {
      json(res, 400, { error: "missing or invalid fields" });
      return true;
    }
    // R50 audit fix: validate `category` is an integer in
    // [0, 3]. Same range /prize/signature enforces. We
    // intentionally reject NaN / negative / >3 so a
    // fuzzing client can't smuggle a category-100 row into
    // the leaderboard archive by relying on the
    // getUserWeekRank default. Strict membership is the
    // safer choice: the web only ever sends 0..3.
    if (
      typeof body.category !== "number" ||
      !Number.isInteger(body.category) ||
      body.category < 0 ||
      body.category > 3
    ) {
      json(res, 400, {
        error: "category must be an integer in [0, 3] (0=general, 1=ai_news, 2=crypto_price, 3=other)",
      });
      return true;
    }
    // R47 audit fix: validate `txDigest` if present.
    // The previous handler accepted any string and
    // persisted it verbatim. A 10KB txDigest would
    // be stored in the row and the Sui digest
    // format is `0x` + 64 hex chars. Reject anything
    // that doesn't match the strict format so the
    // off-chain `txDigest` column can be trusted by
    // the operator-dashboard view.
    if (
      body.txDigest != null &&
      (typeof body.txDigest !== "string" ||
        !/^0x[a-fA-F0-9]{64}$/.test(body.txDigest))
    ) {
      json(res, 400, { error: "txDigest must be a 0x + 64 hex string" });
      return true;
    }
    // R46 audit fix: validate the client-supplied poolId
    // (if any) against the same strict object-id regex
    // we apply to `user`. An unvalidated poolId would
    // have written arbitrary text into the `prize_claims`
    // row and corrupted the (pool_id, user, week_index)
    // PK lookups the indexer runs on the next poll.
    // Fall back to `process.env.PRIZE_POOL_ID` when the
    // client omits the field (the current single-pool
    // case).
    const clientPoolId = typeof body.poolId === "string"
      && /^0x[a-fA-F0-9]{64}$/.test(body.poolId)
      ? body.poolId
      : null;
    const weekIndex =
      typeof body.weekIndex === "string" ? Number(body.weekIndex) : body.weekIndex;
    if (!Number.isFinite(weekIndex) || weekIndex < 0) {
      json(res, 400, { error: "invalid weekIndex" });
      return true;
    }
    // Membership check — same fallback used by /prize/signature so
    // current-week claims work the same way. R50 audit fix: pass
    // the validated `category` through to both branches so the
    // membership check is category-scoped (a rank-1 in
    // "AI news" cannot claim a rank-1 row from the "crypto
    // price" leaderboard by omitting the param).
    const currentWeek = weekIndexFor(Date.now());
    const row = weekIndex === currentWeek
      ? liveRollup(weekIndex, body.category).find((r) => r.user === body.user) ?? null
      : getUserWeekRank(body.user, weekIndex, body.category);
    if (!row) {
      json(res, 403, {
        error: "user not on leaderboard for this week and category",
        week_index: weekIndex,
        // R50 audit fix: include the category in the
        // 403 body so a misrouted client (the user's
        // request is for category 1 but the user is
        // only on category 2's leaderboard) can self-
        // diagnose without re-fetching the
        // /leaderboard/user/:addr endpoint to figure
        // out which category they qualify for.
        category: body.category,
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
    //
    // R46 audit fix: prefer a client-supplied `poolId` (if
    // any) over the server-side env var. The client wins
    // because the on-chain tx the user just signed was
    // already attributed to a specific pool object, and the
    // server should not be silently re-routing the off-chain
    // mirror to a different pool. Fall back to the env var
    // when the client omits the field.
    //
    // R47 audit fix: refuse the request when both the
    // client and the env are empty. The previous
    // `clientPoolId ?? process.env.PRIZE_POOL_ID ?? ""`
    // would silently attribute the claim to the
    // empty-string sentinel — a future operator who
    // set `PRIZE_POOL_ID` would write to a *new*
    // `(empty → real)` row instead of the
    // `(real → real)` row the indexer would have
    // looked at, silently losing the off-chain
    // mirror. Reject with 400 and a readable message
    // so the operator has to be explicit about the
    // pool attribution.
    const claimPoolId = clientPoolId ?? process.env.PRIZE_POOL_ID ?? "";
    if (!claimPoolId) {
      json(res, 400, {
        error:
          "poolId is required: send a valid poolId in the body or " +
          "configure PRIZE_POOL_ID on the agents service.",
      });
      return true;
    }
    const existing = getPrizeClaim(
      body.user,
      weekIndex,
      claimPoolId,
    );
    if (existing) {
      json(res, 409, {
        error: "prize already claimed for this user and week",
        week_index: weekIndex,
      });
      return true;
    }
    try {
      // R42 audit fix: `amount` is a `bigint` from
      // `expectedAmountForRank`, which multiplies the on-chain
      // weekly_prize by bps/10_000. For a max-size pool (the
      // cumulative weekly_prize on mainnet is `u64`) the rank-1
      // share can easily exceed `Number.MAX_SAFE_INTEGER` (≈9e15
      // atoms = 9e9 dUSDC). The previous `Number(amount)` would
      // silently truncate, so the off-chain mirror would disagree
      // with the on-chain payout the user actually received — and
      // the dispute would be unresolvable because the off-chain
      // row is the audit trail. Use the same `u64ToSafeNumber`
      // guard the position-indexer (R41) uses, with a route-
      // specific warning that names the prize context. Bumping
      // the SQLite column to TEXT would be the long-term fix;
      // for R42 we keep the column type and warn on overflow.
      const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
      if (amount > MAX_SAFE) {
        console.warn(
          `[routes] /prize/claims amount for user=${body.user} ` +
            `week=${weekIndex} rank=${body.rank} (${amount}) ` +
            "exceeds Number.MAX_SAFE_INTEGER; truncating. Bump the " +
            "prize_claims.amount column to TEXT to preserve precision.",
        );
      }
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
        //
        // R46 audit fix: prefer the client-supplied `poolId`
        // (when present and well-formed) so the off-chain mirror
        // row carries the same pool id the on-chain tx targeted.
        // Fall back to the env var for clients that haven't been
        // updated to send `poolId`.
        pool_id: claimPoolId || null,
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
    // O(N over the user's parlays).
    //
    // R46 audit fix: the previous "unfinalized" branch called the
    // global `listUnfinalizedParlays()` and then `.filter((p) =>
    // p.user === addr)` in JS, which is O(N over all unfinalized
    // parlays in the system) on every poll. At a busy settle
    // window the /parlay page (which polls every 5s) was
    // effectively N×M per request. Push the user filter into
    // SQL so the indexer path stays O(N over the user's
    // parlays).
    const allRows: ParlayRow[] = includeFinalized
      ? listAllParlaysForUser(addr)
      : listUnfinalizedParlaysForUser(addr);
    // R49 audit fix: NaN-safe limit. Same pattern as
    // /leaderboard/week above.
    const rawLimit = Number(url.searchParams.get("limit") ?? 50);
    const limit =
      Number.isFinite(rawLimit) && rawLimit > 0
        ? Math.min(rawLimit, 200)
        : 50;
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
    // R50 audit fix: route through the
    // process-wide gRPC singleton (lazy-initialized
    // in `lib.ts`) instead of `createClient()`,
    // which would have opened a fresh HTTP/2
    // connection on every prize-signature request.
    const client = getSharedClient();
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
