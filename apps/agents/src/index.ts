import "dotenv/config";
import { createServer } from "node:http";
import { keypairFromPrivateKey } from "@suipredict/sdk";
import { runMarketCreator } from "./agents/market-creator.js";
import { runMarketMaker } from "./agents/market-maker.js";
import { runMarketResolver } from "./agents/market-resolver.js";
import { runRiskMonitor } from "./agents/risk-monitor.js";
import { runStreakSweeper } from "./agents/streak-sweeper.js";
import { runLeaderboardWorker } from "./agents/leaderboard-worker.js";
import { runPrizeDistributor } from "./agents/prize-distributor.js";
import type { AgentContext } from "./lib.js";
import { getAgentStats, getRecentDecisions } from "./store.js";
import { handleMarketsRoute } from "./markets/routes.js";
import { handleGamificationRoute } from "./gamification/routes.js";

const POLL_MS = Number(process.env.AGENT_POLL_INTERVAL_MS ?? 15_000);
const MAX_BUDGET = Number(process.env.AGENT_MAX_BUDGET_USDC ?? 500);
const LEGACY_PREDICT = process.env.ENABLE_LEGACY_PREDICT_AGENTS === "true";

function loadContext(): AgentContext | null {
  const pk = process.env.AGENT_PRIVATE_KEY;
  if (!pk) {
    console.warn("[agents] AGENT_PRIVATE_KEY required for on-chain agents");
    return null;
  }
  return {
    signer: keypairFromPrivateKey(pk),
    managerId: process.env.AGENT_MANAGER_ID ?? "",
    policyId: process.env.AGENT_POLICY_ID,
    maxBudgetUsdc: MAX_BUDGET,
  };
}

async function runCycle(ctx: AgentContext) {
  console.log(`[agents] cycle @ ${new Date().toISOString()}`);
  const agents = [
    runMarketResolver,
    runMarketCreator,
    runMarketMaker,
    runRiskMonitor,
    runStreakSweeper,
    runLeaderboardWorker,
    runPrizeDistributor,
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
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    if (handleMarketsRoute(req, res, url)) return;
    if (handleGamificationRoute(req, res, url)) return;
    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }
    if (url.pathname === "/decisions") {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(JSON.stringify(getRecentDecisions(100)));
      return;
    }
    if (url.pathname === "/stats") {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      });
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

  console.log(`[agents] Agent address: ${ctx.signer.getPublicKey().toSuiAddress()}`);
  if (LEGACY_PREDICT) console.log(`[agents] Legacy Predict agents enabled`);

  await runCycle(ctx);
  setInterval(() => runCycle(ctx), POLL_MS);
}

main().catch(console.error);
