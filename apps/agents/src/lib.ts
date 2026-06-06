import {
  createClient,
  findNearestActiveOracle,
  getOracleState,
  getSpotPrice,
  getVaultSummary,
  getSharedClient as sdkGetSharedClient,
  closeClient,
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
  return Math.max(min, Math.min(max, n));
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
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              "You are an autonomous trading agent on DeepBook Predict. Respond ONLY with valid JSON.",
          },
          { role: "user", content: prompt },
        ],
        temperature: 0.2,
      }),
    });
    if (!res.ok) {
      // R56 audit fix: log the HTTP status (without the key, body,
      // or URL) so the operator can distinguish a 401 (revoked
      // key — one-time fix) from a 429 (rate limit — wait for
      // cooldown) from a 5xx (OpenAI outage — no action). The
      // previous bare `return null` hid every failure mode behind
      // the same decision-log reason (`LLM call returned null`).
      console.warn(
        `[lib.callLlm] OpenAI returned HTTP ${res.status} ${res.statusText}`,
      );
      return null;
    }
    const data = (await res.json()) as {
      choices: { message: { content: string } }[];
    };
    return data.choices[0]?.message.content ?? null;
  } catch (err) {
    // R56 audit fix: log the underlying error class (TypeError
    // from `fetch` failing on a DNS/network error, SyntaxError
    // from malformed JSON, etc.) so the operator can tell
    // "OPENAI is down" from "the model returned garbage" from
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

export async function getMarketContext() {
  const oracle = await findNearestActiveOracle();
  if (!oracle) return null;
  const [stateRaw, vault] = await Promise.all([
    getOracleState(oracle.oracle_id),
    getVaultSummary(),
  ]);
  const spot = await getSpotPrice(oracle.oracle_id);
  const state = { ...stateRaw, spot };
  return { oracle, state, vault };
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
//
// The dead helpers the R55 audit also flagged
// (`getMarketContext` plus the four SDK imports it
// pulled in) are kept for now — `getMarketContext` is
// not invoked by the agents package, but it is in the
// public surface; deleting it would be a breaking
// change. Future rounds can decide.
export function getSharedClient(): SuiClient {
  return sdkGetSharedClient();
}
export async function closeSharedClient(): Promise<void> {
  return closeClient(sdkGetSharedClient());
}
