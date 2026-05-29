import "dotenv/config";
import { createServer } from "node:http";
import { keypairFromPrivateKey } from "@suipredict/sdk";
import { runMarketStrategist } from "./agents/market-strategist.js";
import { runPLPManager } from "./agents/plp-manager.js";
import { runRedeemKeeper } from "./agents/redeem-keeper.js";
import { runRiskMonitor } from "./agents/risk-monitor.js";
import type { AgentContext } from "./lib.js";
import { getAgentStats, getRecentDecisions } from "./store.js";

const POLL_MS = Number(process.env.AGENT_POLL_INTERVAL_MS ?? 15_000);
const MAX_BUDGET = Number(process.env.AGENT_MAX_BUDGET_USDC ?? 500);

function loadContext(): AgentContext | null {
  const pk = process.env.AGENT_PRIVATE_KEY;
  const managerId = process.env.AGENT_MANAGER_ID;
  if (!pk || !managerId) {
    console.warn("[agents] AGENT_PRIVATE_KEY and AGENT_MANAGER_ID required");
    return null;
  }
  return {
    signer: keypairFromPrivateKey(pk),
    managerId,
    policyId: process.env.AGENT_POLICY_ID,
    maxBudgetUsdc: MAX_BUDGET,
  };
}

async function runCycle(ctx: AgentContext) {
  console.log(`[agents] cycle @ ${new Date().toISOString()}`);
  const agents = [
    runRiskMonitor,
    runRedeemKeeper,
    runPLPManager,
    runMarketStrategist,
  ] as const;

  for (const agent of agents) {
    try {
      const result = await agent(ctx);
      console.log(`  ✓ ${result.action}: ${result.reasoning.slice(0, 80)}`);
    } catch (err) {
      console.error(`  ✗ agent error:`, err);
    }
  }
}

function startHealthServer() {
  const port = Number(process.env.PORT ?? 3001);
  createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }
    if (req.url === "/decisions") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(getRecentDecisions(100)));
      return;
    }
    if (req.url === "/stats") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(getAgentStats()));
      return;
    }
    res.writeHead(404);
    res.end();
  }).listen(port, () => console.log(`[agents] API on :${port}`));
}

async function main() {
  startHealthServer();
  const ctx = loadContext();
  if (!ctx) {
    console.log("[agents] Running in API-only mode (no wallet configured)");
    return;
  }

  console.log(`[agents] Manager: ${ctx.managerId}`);
  console.log(`[agents] Agent address: ${ctx.signer.getPublicKey().toSuiAddress()}`);

  await runCycle(ctx);
  setInterval(() => runCycle(ctx), POLL_MS);
}

main().catch(console.error);
