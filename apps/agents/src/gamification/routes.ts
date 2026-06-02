/**
 * Gamification REST routes.
 *
 *   GET /leaderboard/week?index=N&limit=M&category=K
 *   GET /leaderboard/user/:addr?week=N
 *   GET /prize/signature?week=N&rank=R&user=:addr&amount=:a
 *   GET /prize/claims?week=N
 *
 * The first two back the off-chain leaderboard surface. The prize
 * signature endpoint re-signs the canonical claim payload so the user
 * can submit the on-chain `claim_prize` tx from their own wallet.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { keccak_256 } from "@noble/hashes/sha3";
import {
  expectedAmountForRank,
  DEFAULT_DISTRIBUTION_BPS,
  signClaimPayload,
  type ClaimPayload,
} from "@suipredict/sdk";
import { weekIndexFor } from "./store.js";
import { liveRollup } from "../agents/leaderboard-worker.js";
import { getUserWeekRank, listPrizeClaims } from "./store.js";

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(body));
}

export function handleGamificationRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): boolean {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return true;
  }
  if (req.method !== "GET") return false;

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

  // GET /leaderboard/user/:addr?week=N
  const userMatch = url.pathname.match(/^\/leaderboard\/user\/(0x[a-fA-F0-9]+)$/);
  if (userMatch) {
    const addr = userMatch[1]!;
    const idx = Number(url.searchParams.get("week") ?? weekIndexFor(Date.now()));
    const row = getUserWeekRank(addr, idx);
    if (!row) {
      json(res, 404, { error: "user not found for week", week_index: idx });
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
  const sigMatch = url.pathname.match(/^\/prize\/signature$/);
  if (sigMatch) {
    const week = Number(url.searchParams.get("week") ?? -1);
    const rank = Number(url.searchParams.get("rank") ?? 0);
    const user = url.searchParams.get("user") ?? "";
    const poolId = process.env.PRIZE_POOL_ID ?? "";
    const adminPk = process.env.PRIZE_ADMIN_PRIVATE_KEY ?? "";
    if (week < 0 || rank <= 0 || !user || !poolId || !adminPk) {
      json(res, 400, { error: "missing required params" });
      return true;
    }
    if (!/^0x[a-fA-F0-9]{1,64}$/.test(user)) {
      json(res, 400, { error: "invalid user address" });
      return true;
    }
    // Membership check: is the user on the leaderboard for this week,
    // and is the requested rank consistent with the archive?
    const row = getUserWeekRank(user, week);
    if (!row) {
      json(res, 403, {
        error: "user not on leaderboard for this week",
        week_index: week,
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
    const amount = expectedAmountForRank(
      BigInt(process.env.PRIZE_WEEKLY_AMOUNT ?? "0"),
      rank,
      DEFAULT_DISTRIBUTION_BPS,
    );
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
        });
      })
      .catch((err) =>
        json(res, 500, { error: err instanceof Error ? err.message : String(err) }),
      );
    return true;
  }

  // GET /prize/claims?week=N
  const claimMatch = url.pathname.match(/^\/prize\/claims$/);
  if (claimMatch) {
    const week = url.searchParams.get("week");
    const weekNum = week != null ? Number(week) : undefined;
    json(res, 200, listPrizeClaims(weekNum));
    return true;
  }

  return false;
}
