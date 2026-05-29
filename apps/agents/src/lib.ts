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
