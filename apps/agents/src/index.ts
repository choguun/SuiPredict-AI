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
import { runParlayWorker } from "./agents/parlay-worker.js";
import type { AgentContext } from "./lib.js";
import { getAgentStats, getRecentDecisions } from "./store.js";
import { handleMarketsRoute } from "./markets/routes.js";
import { handleGamificationRoute } from "./gamification/routes.js";
import { startScheduler } from "./scheduler.js";

const POLL_MS = Number(process.env.AGENT_POLL_INTERVAL_MS ?? 15_000);
const MAX_BUDGET = Number(process.env.AGENT_MAX_BUDGET_USDC ?? 500);
const LEGACY_PREDICT = process.env.ENABLE_LEGACY_PREDICT_AGENTS === "true";

/**
 * Boot-time config validator.
 *
 * Lists the env vars each agent needs in order to do real work, and
 * prints a clear pass/fail table. The previous behavior was to boot
 * the scheduler with whatever the .env had, and have every misconfig'd
 * agent return a silent `action: "skip"` on its first tick — which
 * made misconfig invisible at deploy time. The validator fails loud
 * (non-zero exit) if any required var is empty, so a fresh deploy on
 * a misconfigured host crashes here instead of running 10 inert agents.
 *
 * Optional vars (e.g. `PRIZE_WEEKLY_AMOUNT` = 0 disables the prize
 * distributor on purpose) are reported as warnings, not failures.
 */
function validateBootConfig(): void {
  type VarCheck = {
    name: string;
    envVar: string;
    agent: string;
    required: boolean;
  };
  const checks: VarCheck[] = [
    { name: "Package",            envVar: "AGENT_POLICY_PACKAGE_ID",       agent: "all",            required: true },
    { name: "MarketRegistry",     envVar: "MARKET_REGISTRY_ID",            agent: "MarketCreator",  required: true },
    { name: "FeeVault",           envVar: "FEE_VAULT_ID",                  agent: "MarketCreator",  required: true },
    { name: "AgentPolicy",        envVar: "AGENT_POLICY_ID",               agent: "RiskMonitor",    required: true },
    { name: "AgentManager",       envVar: "AGENT_MANAGER_ID",              agent: "RiskMonitor",    required: false },
    { name: "Vault",              envVar: "VAULT_OBJECT_ID",               agent: "RiskMonitor",    required: false },
    { name: "StreakRegistry",     envVar: "STREAK_REGISTRY_ID",            agent: "StreakSweeper",  required: false },
    { name: "StreakAdmin",        envVar: "STREAK_ADMIN_ID",               agent: "StreakSweeper",  required: false },
    { name: "PrizePool",          envVar: "PRIZE_POOL_ID",                 agent: "PrizeDistributor", required: false },
    { name: "PrizeAdmin",         envVar: "PRIZE_ADMIN_ID",                agent: "PrizeDistributor", required: false },
    { name: "PrizeAdmin Key",     envVar: "PRIZE_ADMIN_PRIVATE_KEY",       agent: "PrizeDistributor", required: false },
    { name: "Prize Weekly Amt",   envVar: "PRIZE_WEEKLY_AMOUNT",           agent: "PrizeDistributor", required: false },
  ];

  const missing: VarCheck[] = [];
  const present: VarCheck[] = [];
  for (const c of checks) {
    const v = process.env[c.envVar] ?? "";
    if (v) present.push(c);
    else missing.push(c);
  }

  console.log(`[agents] Boot config: ${present.length} present, ${missing.length} missing`);
  if (present.length > 0) {
    for (const c of present) {
      const v = process.env[c.envVar] ?? "";
      const short = v.length > 18 ? v.slice(0, 16) + "…" : v;
      console.log(`  [ok    ] ${c.envVar.padEnd(28)} (${c.agent})  = ${short}`);
    }
  }
  if (missing.length > 0) {
    for (const c of missing) {
      const level = c.required ? "FAIL  " : "warn  ";
      console.log(`  [${level}] ${c.envVar.padEnd(28)} (${c.agent})  = <unset>`);
    }
  }

  const hardFails = missing.filter((c) => c.required);
  if (hardFails.length > 0) {
    console.error(
      `[agents] Refusing to boot: ${hardFails.length} required env var(s) missing. ` +
        "Run `pnpm --filter @suipredict/agents tsx scripts/bootstrap-gamification.ts` " +
        "to populate them, or set them in your .env.",
    );
    process.exit(1);
  }
  if (missing.length > 0) {
    console.warn(
      `[agents] ${missing.length} optional var(s) missing — the matching agents will be inert. ` +
        "This is expected on a fresh deploy before bootstrap; otherwise re-run bootstrap-gamification.",
    );
  }
}

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
    { name: "ParlayWorker",      cron: env("AGENT_CRON_PARLAY_WORKER",      "*/1 * * * *"), fn: runParlayWorker },
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
  // The prediction_market and streak_system/prize_pool modules all
  // live in ONE published package (just with different source-
  // namespace prefixes: `suipredict::` vs
  // `suipredict_agent_policy::`). The canonical env var is
  // AGENT_POLICY_PACKAGE_ID; PREDICT_PACKAGE_ID and MARKET_PACKAGE_ID
  // are legacy aliases. If they disagree, AGENT_POLICY_PACKAGE_ID
  // wins — silently picking the first non-empty value (the previous
  // behavior) let stale PREDICT_PACKAGE_ID values override the real
  // deployed package, which made every event-indexer find zero hits.
  const canonical = process.env.AGENT_POLICY_PACKAGE_ID ?? "";
  const legacyA = process.env.PREDICT_PACKAGE_ID ?? "";
  const legacyB = process.env.MARKET_PACKAGE_ID ?? "";
  if (canonical && legacyA && canonical !== legacyA) {
    console.warn(
      `[agents] AGENT_POLICY_PACKAGE_ID (${canonical}) differs from PREDICT_PACKAGE_ID (${legacyA}); using AGENT_POLICY_PACKAGE_ID. ` +
        "Update your .env to drop the stale PREDICT_PACKAGE_ID line.",
    );
  }
  if (canonical && legacyB && canonical !== legacyB) {
    console.warn(
      `[agents] AGENT_POLICY_PACKAGE_ID (${canonical}) differs from MARKET_PACKAGE_ID (${legacyB}); using AGENT_POLICY_PACKAGE_ID. ` +
        "Update your .env to drop the stale MARKET_PACKAGE_ID line.",
    );
  }
  const pkg = canonical || legacyA || legacyB || "";
  if (pkg) {
    process.env.AGENT_POLICY_PACKAGE_ID = pkg;
    process.env.PREDICT_PACKAGE_ID = pkg;
    process.env.MARKET_PACKAGE_ID = pkg;
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
  createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    if (handleMarketsRoute(req, res, url)) return;
    if (await handleGamificationRoute(req, res, url)) return;
    if (url.pathname === "/health") {
      // Expose the configured package id and other env-derived config
      // so the web client can detect drift between the web bundle
      // (which bakes NEXT_PUBLIC_AGENT_POLICY_PACKAGE_ID at build time)
      // and the agents runtime. A mismatch means PTBs built from the
      // web bundle will fail with `package object not found` — the
      // /agents page surfaces this as a banner.
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(
        JSON.stringify({
          status: "ok",
          package_id: process.env.AGENT_POLICY_PACKAGE_ID ?? "",
          deepbook_registry_id:
            process.env.DEEPBOOK_REGISTRY_ID ?? "",
          vault_id: process.env.VAULT_OBJECT_ID ?? "",
          prize_pool_id: process.env.PRIZE_POOL_ID ?? "",
          streak_registry_id: process.env.STREAK_REGISTRY_ID ?? "",
          ts_ms: Date.now(),
        }),
      );
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
    if (url.pathname === "/agents/manifest") {
      // Returns the live list of agents registered with the
      // scheduler, including their cron expressions. The web
      // `/agents` page consumes this so adding a new agent
      // doesn't require a UI rebuild.
      //
      // Each entry has:
      //   { name, cron, kind: "primary" | "legacy" }
      // `kind` is derived from the entry's name against a small
      // whitelist; expand the whitelist (or move it to .env) if
      // a future agent is added that doesn't fit the dichotomy.
      const legacyNames = new Set([
        "MarketStrategist",
        "PLPManager",
        "RedeemKeeper",
      ]);
      const schedule = buildSchedule();
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(
        JSON.stringify(
          schedule.map((s) => ({
            name: s.name,
            cron: s.cron,
            kind: legacyNames.has(s.name) ? "legacy" : "primary",
          })),
        ),
      );
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
  validateBootConfig();
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
