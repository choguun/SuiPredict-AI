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
import { runPrizeAdmin } from "./agents/prize-admin.js";
import { runReferralKeeper } from "./agents/referral-keeper.js";
import { runPositionIndexer } from "./agents/position-indexer.js";
import type { AgentContext } from "./lib.js";
import { getAgentStats, getRecentDecisions } from "./store.js";
import { handleMarketsRoute } from "./markets/routes.js";
import { handleGamificationRoute } from "./gamification/routes.js";
import { startScheduler } from "./scheduler.js";

const POLL_MS = Number(process.env.AGENT_POLL_INTERVAL_MS ?? 15_000);
const MAX_BUDGET = Number(process.env.AGENT_MAX_BUDGET_USDC ?? 500);
const LEGACY_PREDICT = process.env.ENABLE_LEGACY_PREDICT_AGENTS === "true";

/**
 * Per-agent cron schedule (UTC). Replaces the prior "run all every 15s"
 * loop with a self-rescheduling setTimeout per agent.
 *
 * Override any entry via env (e.g. AGENT_CRON_MARKET_MAKER with the
 * value 'star-slash-2 ...' to double the maker's cadence during a test
 * run). The leading '/' in the example is escaped so the JSDoc parser
 * does not treat it as the end of this comment.
 */
function buildSchedule() {
  const env = (key: string, fallback: string) =>
    process.env[key] ?? fallback;
  return [
    { name: "MarketCreator",     cron: env("AGENT_CRON_MARKET_CREATOR",     "0 0 * * *"),  fn: runMarketCreator },
    { name: "MarketResolver",    cron: env("AGENT_CRON_MARKET_RESOLVER",    "58 23 * * *"), fn: runMarketResolver },
    { name: "StreakSweeper",     cron: env("AGENT_CRON_STREAK_SWEEPER",     "2 0 * * *"),   fn: runStreakSweeper },
    { name: "LeaderboardWorker", cron: env("AGENT_CRON_LEADERBOARD",        "5 0 * * 1"),   fn: runLeaderboardWorker },
    { name: "PrizeAdmin",        cron: env("AGENT_CRON_PRIZE_ADMIN",        "10 0 * * 1"),  fn: runPrizeAdmin },
    { name: "PrizeDistributor",  cron: env("AGENT_CRON_PRIZE_DISTRIBUTOR",  "15 0 * * 1"),  fn: runPrizeDistributor },
    { name: "ReferralKeeper",    cron: env("AGENT_CRON_REFERRAL_KEEPER",    "*/15 * * * *"),fn: runReferralKeeper },
    { name: "PositionIndexer",   cron: env("AGENT_CRON_POSITION_INDEXER",   "*/1 * * * *"), fn: runPositionIndexer },
    { name: "RiskMonitor",       cron: env("AGENT_CRON_RISK_MONITOR",       "*/5 * * * *"), fn: runRiskMonitor },
    { name: "MarketMaker",       cron: env("AGENT_CRON_MARKET_MAKER",       "*/1 * * * *"), fn: runMarketMaker },
  ];
}

/**
 * Normalize env aliases. The deployed package is referenced under
 * several names in the .env — pin the canonical one and surface
 * fallbacks for less-common vars.
 */
function bootstrapEnv() {
  // Sanity check: the prediction_market and streak_system/prize_pool
  // modules all live in ONE published package (just with different
  // source-namespace prefixes: `suipredict::` vs
  // `suipredict_agent_policy::`). If two env vars point at different
  // packages, agents that query on-chain events with one package id
  // and submit PTBs targeting the other will silently find zero
  // results. Warn loudly so the misconfiguration is visible at boot.
  const pkgA = process.env.AGENT_POLICY_PACKAGE_ID;
  const pkgB = process.env.PREDICT_PACKAGE_ID ?? process.env.MARKET_PACKAGE_ID;
  if (pkgA && pkgB && pkgA !== pkgB) {
    console.warn(
      `[agents] AGENT_POLICY_PACKAGE_ID (${pkgA}) differs from PREDICT_PACKAGE_ID/MARKET_PACKAGE_ID (${pkgB}). ` +
        `Re-run bootstrap to align them, or the streak sweeper will miss events.`,
    );
  }
  const pkg =
    process.env.PREDICT_PACKAGE_ID ??
    process.env.MARKET_PACKAGE_ID ??
    process.env.AGENT_POLICY_PACKAGE_ID ??
    "";
  if (pkg) {
    process.env.PREDICT_PACKAGE_ID = pkg;
    process.env.MARKET_PACKAGE_ID = pkg;
    process.env.AGENT_POLICY_PACKAGE_ID = pkg;
  }
  const deepRegistry =
    process.env.DEEPBOOK_REGISTRY_ID ?? "0x7c256edbda983a2cd6f946655f4bf3f00a41043993781f8674a7046e8c0e11d1";
  process.env.DEEPBOOK_REGISTRY_ID = deepRegistry;
}
bootstrapEnv();

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
  // One-shot helper for /run and CLI smoke tests — runs every agent
  // once with a short-circuit on noop. The production cron loop is
  // `startScheduler()` in main(), which fires each agent on its own
  // UTC boundary.
  const schedule = buildSchedule();
  for (const entry of schedule) {
    try {
      const result = await entry.fn(ctx);
      console.log(
        `  ${entry.name}: ${result.action}: ${result.reasoning.slice(0, 80)}`,
      );
    } catch (err) {
      console.error(`  ${entry.name} error:`, err);
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

  // Per-agent UTC scheduling — see scheduler.ts and buildSchedule() above.
  // Override any entry with AGENT_CRON_<NAME>=<expr> for tests.
  startScheduler(ctx, buildSchedule());
  console.log(`[agents] Scheduler online (POLL_MS=${POLL_MS})`);
}

main().catch(console.error);
