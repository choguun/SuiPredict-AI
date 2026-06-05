import {
  createClient,
  findNearestActiveOracle,
  getOracleState,
  getSpotPrice,
  getVaultSummary,
  pickAtmStrike,
} from "@suipredict/sdk";
import type { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { logDecision } from "./store.js";

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
    if (!res.ok) return null;
    const data = (await res.json()) as {
      choices: { message: { content: string } }[];
    };
    return data.choices[0]?.message.content ?? null;
  } catch {
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

// R50 audit fix: lazy singleton gRPC client. The
// previous pattern called `createClient()` on every
// request (gamification routes, worker ticks,
// prize-admin), each of which instantiated a new
// `SuiGrpcClient` and opened a fresh HTTP/2
// connection. Under a small burst the connection
// pool churned the Sui gRPC server (and triggered
// the SDK's own rate limiter). One connection per
// process; lazy-initialized on first use so unit
// tests can still mock `createClient` via the
// barrel re-export. The `SuiClient` type lives in
// the SDK barrel.
//
// R52 audit fix: expose `closeSharedClient()`
// so the SIGTERM handler in `index.ts` can
// drain the gRPC channel before the process
// exits. Without it, every Railway redeploy
// (and every `kill -TERM`) leaks one
// HTTP/2 connection: the gRPC server sees a
// RST_STREAM and logs an error, the kernel
// eventually reaps the socket after a
// keepalive timeout, and the Sui public node
// rate-limits the leaked pings. The
// `SuiGrpcClient` exposes a `close()` method
// that flushes pending unary calls and aborts
// the stream.
import type { SuiClient } from "@suipredict/sdk";
let cachedClient: SuiClient | null = null;
export function getSharedClient(): SuiClient {
  if (!cachedClient) cachedClient = createClient();
  return cachedClient;
}
export async function closeSharedClient(): Promise<void> {
  if (!cachedClient) return;
  const client = cachedClient;
  cachedClient = null;
  // The SuiGrpcClient's `close()` returns
  // once the HTTP/2 session is fully torn
  // down. It's safe to call on a fresh
  // client too (it just resolves).
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (client as any).close?.();
  } catch {
    /* shutdown best-effort */
  }
}
