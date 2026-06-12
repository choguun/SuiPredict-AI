import {
  createClient,
  getSharedClient as sdkGetSharedClient,
  closeClient,
  resetSharedClient,
  pickAtmStrike,
  type SuiClient,
} from "@suipredict/sdk";
import type { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";
import { logDecision } from "./store.js";

// R55 audit fix: lazy singleton for the JSON-RPC
// `SuiJsonRpcClient`. The gRPC `getSharedClient()` was
// already a singleton (R51) but the JSON-RPC client
// used for `queryEvents` / `listDynamicFields` was
// rebuilt per tick in `position-indexer` and
// `streak-sweeper`. `position-indexer` runs at 1min
// cadence, so the connection churn was 1440/day per
// process. Mirror the gRPC pattern; the helper
// resolves the URL at call time so a `bootstrap-env.ts`
// hot-patch of `SUI_NETWORK` is honored (the cached
// `SUI_NETWORK` is also re-read on every call).
let _cachedJsonRpcClient: SuiJsonRpcClient | null = null;
let _cachedJsonRpcNetwork: string | null = null;
export function getSharedJsonRpcClient(): SuiJsonRpcClient {
  const network = process.env.SUI_NETWORK ?? "testnet";
  // Re-build the client if the network hot-patched.
  // The old client is GC'd; the underlying HTTP
  // keepalive connection is dropped after the next
  // request by Node's default `node-fetch` agent.
  if (!_cachedJsonRpcClient || _cachedJsonRpcNetwork !== network) {
    _cachedJsonRpcClient = new SuiJsonRpcClient({
      url: getJsonRpcFullnodeUrl(network as "testnet" | "mainnet" | "devnet"),
      network: network as "testnet" | "mainnet" | "devnet" | "localnet",
    });
    _cachedJsonRpcNetwork = network;
  }
  return _cachedJsonRpcClient;
}

// R58.M2 audit fix: drop the cached JSON-RPC client
// during SIGTERM. The agents' SIGTERM handler in
// `index.ts` calls `closeSharedClient()` to release
// the gRPC channel + reset the SDK's `_sharedClient`
// cache, but the local `_cachedJsonRpcClient` was
// never nulled — a subsequent reconnect (e.g. a
// SIGTERM-then-immediate-restart under Railway's
// healthcheck window) returned the stale client
// whose `fetch` was already torn down. The fix is a
// symmetric "drop cache" entry point.
export function resetSharedJsonRpcClient(): void {
  _cachedJsonRpcClient = null;
  _cachedJsonRpcNetwork = null;
}

// R55 audit fix: `safeInt` / `safeFloat` / `safeBigInt`
// helpers for hot-patchable env reads. A `.env` typo
// (e.g. `MAX_PARLAYS_PER_TICK=NaN` from `Number("abc")`,
// or `PRIZE_WEEKLY_AMOUNT=10_USDC` from a unit-suffix
// paste) used to silently break the worker — a
// `slice(0, NaN) = []` parked the parlay-worker, and
// `BigInt("10_USDC")` threw a `SyntaxError` that the
// surrounding `try/catch` didn't catch. Centralize the
// validation so a future env addition gets it for free.
export function safeInt(
  v: string | undefined,
  fallback: number,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (v === undefined || v === null) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) {
    console.warn(
      `[lib.safeInt] env value "${v}" is not a finite number; using fallback ${fallback}.`,
    );
    return fallback;
  }
  const truncated = Math.trunc(n);
  const clamped = Math.max(min, Math.min(max, truncated));
  if (clamped !== n) {
    console.warn(
      `[lib.safeInt] env value "${v}" (${n}) clamped to [${min}, ${max}] -> ${clamped}.`,
    );
  }
  return clamped;
}

export function safeFloat(
  v: string | undefined,
  fallback: number,
  min = 0,
  max = Number.MAX_VALUE,
): number {
  if (v === undefined || v === null) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) {
    console.warn(
      `[lib.safeFloat] env value "${v}" is not a finite number; using fallback ${fallback}.`,
    );
    return fallback;
  }
  // R58.L2 audit fix: log a warning when the env
  // value is silently clamped. A deployer's
  // `MAX_PARLAY_PAYOUT_BPS=20000` (intended 2x
  // cap, mistakenly typed as 2.0x) used to clamp
  // to 1.0 with no log; the next deploy of
  // `.env.production` brought the bug back. The
  // R55 helper already logged the non-finite
  // branch; this adds the clamp branch. The
  // helper is private — the warn is for the
  // operator, not the caller.
  const clamped = Math.max(min, Math.min(max, n));
  if (clamped !== n) {
    console.warn(
      `[lib.safeFloat] env value "${v}" (${n}) clamped to [${min}, ${max}] -> ${clamped}.`,
    );
  }
  return clamped;
}

export function safeBigInt(
  v: string | undefined,
  fallback: bigint,
): bigint {
  if (v === undefined || v === null || v === "") return fallback;
  try {
    return BigInt(v);
  } catch (err) {
    console.warn(
      `[lib.safeBigInt] env value "${v}" is not a valid bigint (${err instanceof Error ? err.message : String(err)}); using fallback ${fallback}.`,
    );
    return fallback;
  }
}

export interface AgentContext {
  signer: Ed25519Keypair;
  managerId: string;
  policyId?: string;
  maxBudgetUsdc: number;
}

export interface AgentResult {
  action: string;
  reasoning: string;
  confidence?: number;
  txDigest?: string;
}

export async function callLlm(prompt: string): Promise<string | null> {
  const apiKey = process.env.MINIMAX_API_KEY;
  if (!apiKey) return null;

  const baseUrl =
    process.env.MINIMAX_BASE_URL ?? "https://api.minimax.io/anthropic";
  const model = process.env.MINIMAX_MODEL ?? "MiniMax-M3";

  try {
    // R58.H1 audit fix: bound the fetch with a
    // 30s timeout. The previous `await fetch(...)` had
    // no `signal`; a hung LLM connection (TLS
    // handshake stalls, dead proxy) would hang the
    // worker tick indefinitely, blocking the next
    // `await callLlm(prompt)` call on the same event
    // loop and silently backing up the cron. 30s is
    // above p99 for MiniMax-M3 (typically < 8s) but
    // well below the cron loop period (~60s).
    //
    // MiniMax M3 is Anthropic-compatible: it uses the
    // Messages API shape (`/v1/messages`, `system` as a
    // separate field, `content` as a list of typed
    // blocks). The auth header is `x-api-key`, not
    // `Authorization: Bearer`. See the reference
    // `llm-provider-minimax.ts` for the upstream
    // helper.
    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        messages: [{ role: "user", content: prompt }],
        system:
          "You are an autonomous trading agent on DeepBook Predict. Respond ONLY with valid JSON. No prose, no markdown fences.",
        temperature: 0.2,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      // R56 audit fix: log the HTTP status (without the key, body,
      // or URL) so the operator can distinguish a 401 (revoked
      // key — one-time fix) from a 429 (rate limit — wait for
      // cooldown) from a 5xx (MiniMax outage — no action).
      console.warn(
        `[lib.callLlm] MiniMax returned HTTP ${res.status} ${res.statusText}`,
      );
      return null;
    }
    const data = (await res.json()) as {
      content?: Array<{ type: string; text?: string }>;
    };
    // MiniMax M3 returns Anthropic Messages shape:
    //   { content: [{ type: "text", text: "..." }, { type: "thinking", ... }] }
    // Concatenate all text blocks (skipping thinking).
    const text = (data.content ?? [])
      .filter((c) => c.type === "text" && typeof c.text === "string")
      .map((c) => c.text!)
      .join("");
    return text || null;
  } catch (err) {
    // R56 audit fix: log the underlying error class (TypeError
    // from `fetch` failing on a DNS/network error, SyntaxError
    // from malformed JSON, etc.) so the operator can tell
    // "MiniMax is down" from "the model returned garbage" from
    // "the network is partitioned". The key is never included
    // in the log (the catch only sees the throw, which doesn't
    // include the request body).
    console.warn(
      `[lib.callLlm] call threw ${err instanceof Error ? err.name : typeof err}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}

export function recordResult(
  agent: string,
  result: AgentResult,
): AgentResult {
  logDecision({
    agent,
    action: result.action,
    reasoning: result.reasoning,
    confidence: result.confidence,
    txDigest: result.txDigest,
    timestamp: Date.now(),
  });
  return result;
}

export { createClient, pickAtmStrike };

// R55 audit fix: shrink the local getSharedClient /
// closeSharedClient into thin wrappers around the SDK's
// `getSharedClient` and `closeClient` (R54 added both
// to the SDK). The previous local `closeSharedClient`
// did `(client as any).close?.()` — the exact `as any`
// cast R54 was trying to fix in the SDK. The SDK's
// `closeClient` is therefore a dead export. With this
// migration the typed escape hatch lives in one place
// (the SDK) and the agents' SIGTERM handler in
// `index.ts` reuses the same helper.
//
// Backward compat: `getSharedClient` and
// `closeSharedClient` keep their local names so the
// rest of the agents package (every worker that
// imports `getSharedClient` from `./lib.js`) doesn't
// need to change. Both are thin wrappers around the
// SDK's helpers.
export function getSharedClient(): SuiClient {
  return sdkGetSharedClient();
}
export async function closeSharedClient(): Promise<void> {
  await closeClient(sdkGetSharedClient());
  resetSharedClient();
}

// Rate-limit retry wrapper for JSON RPC queries. Exponential backoff
// on HTTP 429 / 502 / 503 / 504 / network errors. Up to 3 retries
// (1s, 2s, 4s). Returns the result or throws on permanent errors.
export async function retryQuery<T>(
  tag: string,
  fn: () => Promise<T>,
  maxRetry = 3,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetry; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      const isTransient = /(429|TooManyRequests|408|502|503|504|fetch failed|ETIMEDOUT|ECONNRESET|ECONNREFUSED|socket hang up|Service Unavailable|Bad Gateway|Gateway Timeout|Request timeout|Too Many Requests)/i.test(msg);
      if (isTransient && attempt < maxRetry) {
        const delay = 1000 * 2 ** attempt;
        console.warn(`[retryQuery:${tag}] transient error (attempt ${attempt + 1}/${maxRetry + 1}), retrying in ${delay}ms: ${msg.slice(0, 100)}`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}
