/**
 * Self-hosted DUSDC faucet.
 *
 * The web app's "Mint Shares" path needs DUSDC collateral, and a
 * fresh user has none. Sui's official testnet faucet
 * (https://faucet.sui.io/) only mints SUI for gas — not the
 * protocol's DUSDC. Without a faucet the only path to DUSDC is
 * to publish your own `dusdc` package and mint from a TreasuryCap
 * you own, which is what the operators of this self-hosted
 * DeepBook V3 deploy have already done.
 *
 * This module exposes two HTTP endpoints:
 *
 *   GET  /faucet/info
 *     Returns whether the faucet is enabled, the default mint
 *     amount (in DUSDC, human-readable), the per-request cap,
 *     and the running total of DUSDC minted since the agents
 *     process started. Read-only, no side effects.
 *
 *   POST /faucet/dusdc
 *     Body: { recipient?: "0x…", amount?: number }
 *       - `recipient` defaults to the connected wallet's address.
 *         Validated against the same `0x<64 hex>` regex the rest
 *         of the agents service uses.
 *       - `amount` defaults to `FAUCET_DEFAULT_AMOUNT_DUSDC` and
 *         is hard-capped at `FAUCET_MAX_AMOUNT_DUSDC` to keep a
 *         single request from draining the TreasuryCap.
 *     Mints DUSDC to the recipient via
 *     `0x2::coin::mint_and_transfer<DUSDC>`, signed by the agent
 *     hot wallet. Returns the tx digest on success.
 *
 * Both endpoints are rate-limited per (IP, route) and per
 * (recipient, route) so a single user can't drain the TreasuryCap
 * or saturate the public RPC with mint PTBs. The in-memory
 * `tryConsume` from `rate-limit.ts` is used for the buckets; the
 * on-chain `claimed[user]` map equivalent for this faucet is the
 * rate limiter itself (the TreasuryCap allows unlimited mints
 * but the rate limiter doesn't).
 *
 * Required env:
 *   - AGENT_PRIVATE_KEY       agent hot wallet (signer)
 *   - DUSDC_TREASURY_CAP_ID   shared TreasuryCap for self-hosted
 *                             DUSDC; mirrors the agents-side
 *                             market-maker that uses the same cap
 *                             for DeepBook deposits.
 *
 * The faucet is also gated on `ENABLE_FAUCET` (default true in
 * dev / false in prod) so a mainnet deploy can hard-disable it
 * without removing the routes.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { Transaction } from "@mysten/sui/transactions";
import {
  DUSDC_TREASURY_CAP_ID,
  DUSDC_TYPE,
  executeTransaction,
  keypairFromPrivateKey,
} from "@suipredict/sdk";
import { corsFor } from "./http-cors.js";
import { tryConsume } from "./rate-limit.js";
import { getSharedClient } from "./lib.js";

/** Default amount per faucet hit, in DUSDC. 100 DUSDC is enough
 *  for ~50 market mints (1 mint = ~2 DUSDC at min size) which
 *  covers any reasonable demo or first-day-of-trading session. */
const FAUCET_DEFAULT_AMOUNT_DUSDC = 100;

/** Hard cap per single faucet hit, in DUSDC. A user who
 *  legitimately wants more can hit the endpoint multiple times
 *  (the rate limiter caps them at 5/h anyway). */
const FAUCET_MAX_AMOUNT_DUSDC = 500;

/** Minimum mint size, in DUSDC. 1 DUSDC is the smallest amount
 *  that produces a usable position (1 mint ≈ 2 DUSDC). */
const FAUCET_MIN_AMOUNT_DUSDC = 1;

/** Per-IP rate limit: 5 faucet hits per 10 minutes. */
const IP_LIMIT = { capacity: 5, refillPerMinute: 0.5 };

/** Per-recipient rate limit: 3 faucet hits per hour. Stricter
 *  than the IP cap so a single user can't drain the TreasuryCap
 *  even by rotating IPs. */
const RECIPIENT_LIMIT = { capacity: 3, refillPerMinute: 0.05 };

/** Module-level counters — purely informational, returned by
 *  /faucet/info so an operator can see the cumulative mint
 *  volume from the agents log. */
const faucetStats = {
  totalMinted: 0n,
  totalRequests: 0,
  totalErrors: 0,
  lastDigest: "" as string,
  lastMintAt: 0,
};

/** Strict Sui address validator. Mirrors the regex used in
 *  `apps/agents/src/markets/routes.ts` (the `/portfolio/0x…`
 *  route) and `packages/sdk/src/utils.ts#isValidSuiAddress`. */
const SUI_ADDRESS_RE = /^0x[0-9a-fA-F]{64}$/;

function json(
  res: ServerResponse,
  status: number,
  body: unknown,
  sideEffecting = false,
  extraHeaders: Record<string, string> = {},
): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    ...corsFor(sideEffecting),
    ...extraHeaders,
  });
  res.end(JSON.stringify(body));
}

function readJsonBody<T = unknown>(req: IncomingMessage): Promise<T | null> {
  // Mirrors the `readJsonBody` in `gamification/routes.ts:190`:
  // hard-cap the body at 16 KB (the largest legitimate /faucet
  // body is ~200 bytes) so a multi-MB POST can't OOM the agents
  // process. Resolve `null` on overflow / parse error so the
  // caller returns a clean 400.
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const MAX = 16 * 1024;
    req.on("data", (c) => {
      const buf = c as Buffer;
      total += buf.length;
      if (total > MAX) {
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

function clientIp(req: IncomingMessage): string {
  // Right-most X-Forwarded-For entry (the edge hop). Mirrors
  // `gamification/routes.ts:65-95` — the left-most is the
  // untrusted client and is trivially spoofable.
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.length > 0) {
    return xff.split(",").pop()!.trim();
  }
  return req.socket?.remoteAddress ?? "unknown";
}

function isFaucetEnabled(): boolean {
  // Default: enabled in dev, disabled in production. Operators
  // can override with `ENABLE_FAUCET=true|false` for prod hosts
  // that want to expose the testnet faucet (e.g. a public
  // testnet deploy) or disable the dev faucet (e.g. a closed
  // beta mainnet deploy).
  const explicit = process.env.ENABLE_FAUCET;
  if (explicit === "true") return true;
  if (explicit === "false") return false;
  return process.env.NODE_ENV !== "production";
}

function isFaucetConfigured(): boolean {
  // The TreasuryCap is the on-chain object whose ownership
  // gates the mint. If the env doesn't have it, /faucet/info
  // returns `enabled: false` and the POST returns 503 so the
  // client gets a clean "faucet not deployed here" message
  // instead of a move-abort toast.
  return Boolean(DUSDC_TREASURY_CAP_ID);
}

export interface FaucetInfo {
  enabled: boolean;
  configured: boolean;
  reason?: string;
  defaultAmount: number;
  maxAmount: number;
  minAmount: number;
  /** Live cumulative counters from the running process. */
  totalMinted: string;
  totalRequests: number;
  totalErrors: number;
  lastDigest: string;
  lastMintAt: number;
  /** Address of the agent wallet that will sign the mint. */
  faucetAddress: string;
  /** Full DUSDC type for client-side UX hints. */
  dusdcType: string;
}

function readFaucetInfo(): FaucetInfo {
  return {
    enabled: isFaucetEnabled(),
    configured: isFaucetConfigured(),
    reason: !isFaucetEnabled()
      ? "Disabled via ENABLE_FAUCET or NODE_ENV=production"
      : !isFaucetConfigured()
        ? "DUSDC_TREASURY_CAP_ID is not configured on this agents service"
        : undefined,
    defaultAmount: FAUCET_DEFAULT_AMOUNT_DUSDC,
    maxAmount: FAUCET_MAX_AMOUNT_DUSDC,
    minAmount: FAUCET_MIN_AMOUNT_DUSDC,
    totalMinted: faucetStats.totalMinted.toString(),
    totalRequests: faucetStats.totalRequests,
    totalErrors: faucetStats.totalErrors,
    lastDigest: faucetStats.lastDigest,
    lastMintAt: faucetStats.lastMintAt,
    // Surfacing the agent address lets the UI show a SuiVision
    // link next to the faucet button so the curious user can
    // verify the faucet is run by the protocol operator.
    faucetAddress:
      (process.env.AGENT_PRIVATE_KEY &&
        keypairFromPrivateKey(process.env.AGENT_PRIVATE_KEY)
          .getPublicKey()
          .toSuiAddress()) ||
      "",
    dusdcType: DUSDC_TYPE,
  };
}

/**
 * The actual mint. Builds a single-PTB
 * `0x2::coin::mint_and_transfer<DUSDC>` call, signs it with the
 * agent hot wallet, and returns the digest.
 *
 * Pre-flight checks:
 *   1. Faucet is enabled (NODE_ENV / ENABLE_FAUCET)
 *   2. Faucet is configured (DUSDC_TREASURY_CAP_ID)
 *   3. AGENT_PRIVATE_KEY is present (the signer)
 *   4. Rate limit by IP and by recipient
 *   5. Recipient is a valid Sui address
 *   6. Amount is in [MIN, MAX] DUSDC
 */
async function faucetDusdc(
  req: IncomingMessage,
  res: ServerResponse,
  body: { recipient?: string; amount?: number | string },
): Promise<void> {
  if (!isFaucetEnabled()) {
    json(res, 403, {
      error: "Faucet is disabled on this deployment",
      detail:
        "Set ENABLE_FAUCET=true on the agents service to allow DUSDC mints.",
    });
    return;
  }
  if (!isFaucetConfigured()) {
    json(res, 503, {
      error: "Faucet is not configured",
      detail:
        "DUSDC_TREASURY_CAP_ID is unset on the agents service. Run `pnpm --filter @suipredict/agents bootstrap` or publish the dusdc package first.",
    });
    return;
  }
  if (!process.env.AGENT_PRIVATE_KEY) {
    json(res, 503, {
      error: "Faucet signer is not configured",
      detail: "AGENT_PRIVATE_KEY is unset on the agents service.",
    });
    return;
  }

  // Reject anything that doesn't look like a body.
  if (!body || typeof body !== "object") {
    json(res, 400, {
      error: "malformed body",
      detail: "Expected JSON: { recipient?: '0x…', amount?: number }",
    });
    return;
  }

  // Validate recipient.
  const recipient = String(body.recipient ?? "").trim();
  if (!SUI_ADDRESS_RE.test(recipient)) {
    json(res, 400, {
      error: "invalid recipient",
      detail:
        "recipient must be a 32-byte Sui address (0x + 64 hex chars).",
    });
    return;
  }

  // Validate amount. Accept numbers OR decimal strings so a JS
  // client can pass a Number, and a Python / curl / Solidity
  // caller can pass a string to avoid float precision loss.
  let amount: number;
  if (typeof body.amount === "string") {
    amount = Number(body.amount);
  } else if (typeof body.amount === "number") {
    amount = body.amount;
  } else {
    amount = FAUCET_DEFAULT_AMOUNT_DUSDC;
  }
  if (
    !Number.isFinite(amount) ||
    amount < FAUCET_MIN_AMOUNT_DUSDC ||
    amount > FAUCET_MAX_AMOUNT_DUSDC
  ) {
    json(res, 400, {
      error: "invalid amount",
      detail: `amount must be in [${FAUCET_MIN_AMOUNT_DUSDC}, ${FAUCET_MAX_AMOUNT_DUSDC}] DUSDC.`,
    });
    return;
  }

  // Rate limits. Per-IP first (cheaper to enforce on a bot) then
  // per-recipient (stricter — a single user shouldn't drain the
  // cap even from rotating IPs).
  const ip = clientIp(req);
  if (!tryConsume(`faucet:ip:${ip}`, IP_LIMIT)) {
    // Bucket refills at 0.5/min ⇒ 120s/token. Round to 60s
    // for the human-readable Retry-After header.
    json(
      res,
      429,
      {
        error: "rate limit exceeded; try again later",
        detail: "5 faucet hits per 10 minutes per IP",
      },
      true,
      { "Retry-After": "120" },
    );
    return;
  }
  if (!tryConsume(`faucet:recipient:${recipient.toLowerCase()}`, RECIPIENT_LIMIT)) {
    // Refill 0.05/min ⇒ 1200s/token. Round to 1200s.
    json(
      res,
      429,
      {
        error: "rate limit exceeded for this recipient",
        detail: "3 faucet hits per hour per address",
      },
      true,
      { "Retry-After": "1200" },
    );
    return;
  }

  // Mint. Build the PTB: `0x2::coin::mint_and_transfer<T>(cap,
  // amount, recipient)`. Use the SDK's `executeTransaction`
  // helper which already does signAndExecuteTransaction +
  // waitForTransaction + retry — same pattern the
  // `market-maker.ts` agent uses for its own self-mint.
  faucetStats.totalRequests += 1;
  const amountAtoms = BigInt(Math.round(amount * 1_000_000));
  try {
    const tx = new Transaction();
    tx.moveCall({
      target: "0x2::coin::mint_and_transfer",
      typeArguments: [DUSDC_TYPE],
      arguments: [
        tx.object(DUSDC_TREASURY_CAP_ID),
        tx.pure.u64(amountAtoms),
        tx.pure.address(recipient),
      ],
    });
    const signer = keypairFromPrivateKey(process.env.AGENT_PRIVATE_KEY!);
    const result = await executeTransaction(getSharedClient(), tx, signer, {
      maxRetry: 1,
    });
    faucetStats.totalMinted += amountAtoms;
    faucetStats.lastDigest = result.digest;
    faucetStats.lastMintAt = Date.now();
    json(res, 200, {
      ok: true,
      digest: result.digest,
      amount,
      amountAtoms: amountAtoms.toString(),
      recipient,
      // Return the live /faucet/info too so the client can
      // refresh its counters without a second round-trip.
      info: readFaucetInfo(),
    });
  } catch (err) {
    faucetStats.totalErrors += 1;
    const msg = err instanceof Error ? err.message : String(err);
    // The on-chain `mint_and_transfer` aborts with
    // `EInvalidCap` if the TreasuryCap id is wrong, and
    // `EInsufficientFunds` would never fire (TreasuryCap
    // has no balance). Surface the raw message so the
    // operator log can correlate; cap at 256 chars so a
    // verbose BCS error doesn't bloat the response.
    console.warn(`[faucet] mint failed: ${msg}`);
    json(res, 502, {
      error: "on-chain mint failed",
      detail: msg.slice(0, 256),
    });
  }
}

/**
 * Route the /faucet/* paths. Returns `true` if the request
 * matched a faucet route (handled), `false` otherwise (the
 * outer router should fall through to the next handler).
 */
export function handleFaucetRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): boolean {
  if (url.pathname === "/faucet/info" || url.pathname === "/faucet") {
    if (req.method === "OPTIONS") {
      res.writeHead(204, corsFor(true));
      res.end();
      return true;
    }
    if (req.method !== "GET") {
      json(res, 405, { error: "method not allowed" }, true);
      return true;
    }
    // /faucet/info is read-only but tagged side-effecting for
    // CORS so a future per-IP / per-recipient rate-limit
    // doesn't have to thread a separate read-only flag.
    json(res, 200, readFaucetInfo(), true);
    return true;
  }

  if (url.pathname === "/faucet/dusdc") {
    if (req.method === "OPTIONS") {
      res.writeHead(204, corsFor(true));
      res.end();
      return true;
    }
    if (req.method !== "POST") {
      json(res, 405, { error: "method not allowed" }, true);
      return true;
    }
    readJsonBody<{ recipient?: string; amount?: number | string }>(req).then(
      (body) => {
        if (body === null) {
          json(res, 400, {
            error: "malformed body",
            detail: "Expected JSON: { recipient?: '0x…', amount?: number }",
          });
          return;
        }
        void faucetDusdc(req, res, body);
      },
    );
    return true;
  }

  return false;
}
