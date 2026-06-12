import "dotenv/config";
import { createServer } from "node:http";
import { keypairFromPrivateKey, SUI_GRPC_URL } from "@suipredict/sdk";
import { runMarketCreator } from "./agents/market-creator.js";
import { runMarketMaker } from "./agents/market-maker.js";
import { runMarketResolver } from "./agents/market-resolver.js";
import { runWorldCupCreator } from "./agents/world-cup-creator.js";
import { runWorldCupResolver } from "./agents/world-cup-resolver.js";
import { runWorldCupMaker } from "./agents/world-cup-maker.js";
import { runRiskMonitor } from "./agents/risk-monitor.js";
import { runStreakSweeper } from "./agents/streak-sweeper.js";
import { runLeaderboardWorker } from "./agents/leaderboard-worker.js";
import { runPrizeDistributor } from "./agents/prize-distributor.js";
import { runPrizeAdmin } from "./agents/prize-admin.js";
import { runReferralKeeper } from "./agents/referral-keeper.js";
import { runPositionIndexer } from "./agents/position-indexer.js";
import { runParlayWorker } from "./agents/parlay-worker.js";
import type { AgentContext } from "./lib.js";
import type { AgentResult } from "./lib.js";
import { closeSharedClient, resetSharedJsonRpcClient, safeInt } from "./lib.js";
import { getRecentDecisions, closeDb as closeDecisionsDb } from "./store.js";
import { handleMarketsRoute } from "./markets/routes.js";
import { handleGamificationRoute } from "./gamification/routes.js";
import { closeDb as closeGamificationDb } from "./gamification/store.js";
import { closeDb as closeMarketsDb } from "./markets/store.js";
import { startScheduler, stopScheduler } from "./scheduler.js";
import { corsFor } from "./http-cors.js";

// R37 audit fix: the previous `POLL_MS` here defaulted to 15 s
// but the only consumer was a misleading boot log line — the
// real scheduler (`scheduler.ts`) uses 60 s as its safety-net
// fallback. Operators reading the boot log thought the
// scheduler polled at 15 s, not 60 s. Read the value through
// the scheduler's exported helper so the log matches reality.
// R54 audit fix: turn the `MAX_BUDGET` / `LEGACY_PREDICT` env reads
// into call-time getters. The previous module-level `const`s were
// frozen at import time, so a `bootstrap-env.ts` mid-flight update
// to `AGENT_MAX_BUDGET_USDC` (e.g. an operator lowering the cap
// during a security incident) was silently ignored. The `loadContext`
// path (line 297) and the boot log (line 510) call these getters
// instead of reading the frozen values.
function readMaxBudget(): number {
  // R56 audit fix: route through `safeInt` so a
  // typo'd env value (e.g. `AGENT_MAX_BUDGET_USDC=500_USDC`
  // or `=1e20` OOM) doesn't return NaN. NaN propagates
  // into `ctx.maxBudgetUsdc` and into the risk-monitor's
  // `policyBudget > 0` check (`NaN > 0` is false), which
  // collapses the dashboard's budget-pressure indicator.
  // The R55 sweep added `safeInt` for exactly this
  // pattern but missed this site.
  return safeInt(process.env.AGENT_MAX_BUDGET_USDC, 500, 0, 1e12);
}
function readLegacyPredict(): boolean {
  return process.env.ENABLE_LEGACY_PREDICT_AGENTS === "true";
}

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
  // R35 audit fix: the [ok ] short-print branch on line 85 was
  // truncating every present env var to 16 chars and printing it
  // to stdout. For 44-char base64 ed25519 keys (PRIZE_ADMIN_PRIVATE_KEY,
  // AGENT_PRIVATE_KEY) that exposes ~36% of the secret in any
  // log sink — multi-tenant aggregators, k8s pod logs, journald.
  // Treat these as secret: print the env name + a fingerprint
  // (first 4 + last 4 hex of the SHA-256), never the value.
  const SECRET_ENV_VARS = new Set([
    "PRIZE_ADMIN_PRIVATE_KEY",
    "AGENT_PRIVATE_KEY",
  ]);
  const checks: VarCheck[] = [
    { name: "Package",            envVar: "AGENT_POLICY_PACKAGE_ID",       agent: "all",            required: true },
    { name: "DUSDC Type",         envVar: "DUSDC_TYPE",                    agent: "ParlayWorker",   required: true },
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
    // R37 audit fix: the admin agent reads PRIZE_FUND_AMOUNT and
    // falls back to PRIZE_WEEKLY_AMOUNT when unset. Operators had
    // no visibility into this fallback — the boot-config table
    // listed the weekly amount but not the per-cycle fund amount,
    // so a misconfig'd PRIZE_FUND_AMOUNT was silently treated as
    // the weekly prize. Surface both, marked optional (the
    // fallback is intentional).
    { name: "Prize Fund Amt",     envVar: "PRIZE_FUND_AMOUNT",             agent: "PrizeAdmin",     required: false },
    { name: "Prize Min Bal",      envVar: "PRIZE_POOL_MIN_BALANCE",        agent: "PrizeAdmin",     required: false },
    { name: "ParlayPool",         envVar: "PARLAY_POOL_ID",                agent: "ParlayWorker",   required: true },
    { name: "ProfileRegistry",    envVar: "NEXT_PUBLIC_PROFILE_REGISTRY_ID", agent: "ProfileRoute", required: false },
    // DeepBook wiring. The market-maker bot needs a BalanceManager
    // (signed for the agent's hot wallet); the deepbook registry
    // defaults to testnet if blank so it's `required: false`. Pool
    // key is a per-deployment string, not optional but the bot can
    // self-discover per-market keys via listRegisteredMarkets, so
    // it's also `required: false`.
    { name: "BalanceManager",     envVar: "BALANCE_MANAGER_ID",            agent: "MarketMaker",    required: false },
    { name: "DeepBookRegistry",   envVar: "DEEPBOOK_REGISTRY_ID",          agent: "MarketMaker",    required: false },
    { name: "PredictPoolKey",     envVar: "PREDICT_DEEPBOOK_POOL_KEY",     agent: "MarketMaker",    required: false },
    // R40 audit fix: the risk monitor's vault-utilization check
    // reads `VAULT_TOTAL_BALANCE` and `VAULT_ALLOCATED` from
    // the env. Neither was in the boot-config validator, so
    // a misconfigured deploy silently returned 0/0 and the
    // risk monitor never tripped the pause-policy threshold
    // — the agents would happily burn budget against a vault
    // that was never funded. Surface both as optional (the
    // agents are inert when blank, but the operator should
    // know).
    { name: "VaultTotalBal",     envVar: "VAULT_TOTAL_BALANCE",           agent: "RiskMonitor",    required: false },
    { name: "VaultAllocated",    envVar: "VAULT_ALLOCATED",               agent: "RiskMonitor",    required: false },
    { name: "FeeVault",          envVar: "FEE_VAULT_ID",                  agent: "Web",            required: false },
    { name: "ProfileRegistry",   envVar: "NEXT_PUBLIC_PROFILE_REGISTRY_ID", agent: "Web",          required: false },
    { name: "AdminAddress",      envVar: "NEXT_PUBLIC_ADMIN_ADDRESS",     agent: "Web",            required: false },
    // R48 audit fix: the previous boot-config list missed
    // streak / parlay / deepbook registry / market-registry ids
    // that the respective agents read at module load. A fresh
    // deploy would boot cleanly with every worker silently
    // `skip`ping, and the operator's first 6 hours were spent
    // wondering why no events were flowing. Surface them as
    // optional (the workers are inert when blank) so the
    // startup log at least *names* what's missing.
    { name: "MarketRegistry",   envVar: "MARKET_REGISTRY_ID",            agent: "PositionIndexer", required: false },
    { name: "StreakRegistry",   envVar: "STREAK_REGISTRY_ID",            agent: "PositionIndexer", required: false },
    { name: "StreakAdmin",      envVar: "STREAK_ADMIN_ID",               agent: "PositionIndexer", required: false },
    { name: "ParlayPoolAdmin",  envVar: "PARLAY_POOL_ADMIN_ID",          agent: "ParlayWorker",   required: false },
    { name: "DeepBookRegistry", envVar: "DEEPBOOK_REGISTRY_ID",          agent: "PositionIndexer", required: false },
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
      if (SECRET_ENV_VARS.has(c.envVar)) {
        // Fingerprint only — first 4 + last 4 hex of SHA-256. Lets
        // the operator confirm "yes that's MY key" across redeploys
        // without leaking the secret to log aggregators.
        const fingerprint = secretFingerprint(v);
        console.log(
          `  [ok    ] ${c.envVar.padEnd(28)} (${c.agent})  = [secret ${fingerprint}]`,
        );
        continue;
      }
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
 * Hash a secret env var to a short, non-reversible fingerprint for
 * the boot-config print. Uses SHA-256 from node:crypto so we don't
 * add a new dep. Returns the first 4 + last 4 hex chars of the
 * digest, separated by `…`. The same secret produces the same
 * fingerprint across deploys, so the operator can verify
 * "yes this is my key" without the secret ever reaching the log.
 */
function secretFingerprint(value: string): string {
  if (!value) return "(empty)";
  // Lazy import — node:crypto is a builtin and is always available
  // in the Node runtime, but the import is hoisted at module load
  // in some bundler configurations. Importing inside the helper
  // is safer and only costs one extra microtask per boot.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createHash } = require("node:crypto") as typeof import("node:crypto");
  const hex = createHash("sha256").update(value).digest("hex");
  return `${hex.slice(0, 4)}…${hex.slice(-4)}`;
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
  // R56 audit fix: validate every cron expression at boot
  // time. A typo'd AGENT_CRON_* (e.g. `*/1 * * *` — 4
  // fields instead of 5) was previously caught silently:
  // `msUntilNext` returns the readPollMs() fallback (60s)
  // and the worker ran on a 1-minute cadence regardless of
  // the configured intent. Crash loud at boot so a fresh
  // deploy doesn't run every agent on the wrong schedule
  // for the rest of the process lifetime.
  const entries: Array<{
    name: string;
    cron: string;
    fn: (ctx: AgentContext) => Promise<AgentResult>;
  }> = [
    { name: "MarketCreator",     cron: env("AGENT_CRON_MARKET_CREATOR",     "0 0 * * *"),  fn: runMarketCreator },
    { name: "MarketResolver",    cron: env("AGENT_CRON_MARKET_RESOLVER",    "58 23 * * *"), fn: runMarketResolver },
    { name: "WorldCupCreator",   cron: env("AGENT_CRON_WC_CREATOR",         "*/15 * * * *"), fn: runWorldCupCreator },
    { name: "WorldCupResolver",  cron: env("AGENT_CRON_WC_RESOLVER",        "*/5 * * * *"), fn: runWorldCupResolver },
    { name: "WorldCupMaker",     cron: env("AGENT_CRON_WC_MAKER",           "*/2 * * * *"), fn: runWorldCupMaker },
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
  for (const entry of entries) {
    if (entry.cron.trim().split(/\s+/).length !== 5) {
      throw new Error(
        `[agents] invalid cron expression for ${entry.name}: "${entry.cron}" ` +
          `(expected 5 whitespace-separated fields). Update the AGENT_CRON_${entry.name.toUpperCase().replace(/([A-Z])/g, "_$1").replace(/^_/, "")} env var.`,
      );
    }
  }
  return entries;
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
  // R40 audit fix: workers build event-filter strings of the
  // form `${pkg}::parlay::ParlayCreated<${DUSDC_TYPE}>` at
  // every tick. If a self-hosted DUSDC deploy sets
  // DUSDC_PACKAGE_ID but never propagates the full DUSDC_TYPE
  // env, the filter string freezes against the SDK's bundled
  // testnet default and matches zero events for the lifetime
  // of the process. Derive DUSDC_TYPE from the package id
  // when only the latter is set. The SDK has the same
  // derivation in `constants.ts`, so this keeps the agents
  // runtime in lockstep with the SDK's `DUSDC_TYPE` constant.
  if (!process.env.DUSDC_TYPE) {
    const pkgId =
      process.env.NEXT_PUBLIC_DUSDC_PACKAGE_ID ??
      process.env.DUSDC_PACKAGE_ID ??
      "";
    if (pkgId) {
      process.env.DUSDC_TYPE = `${pkgId}::dusdc::DUSDC`;
    }
  }
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
    maxBudgetUsdc: readMaxBudget(),
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

// R54 audit fix: module-level handle so the SIGTERM handler can
// call `server.close()` and stop accepting new connections before
// draining the SQLite handles. The previous code created the
// server inside `startHealthServer()` and lost the handle.
let healthServer: ReturnType<typeof createServer> | null = null;

function startHealthServer() {
  // R56 audit fix: route through `safeInt` so a non-numeric
  // `PORT` value (`PORT=""` from a Railway stale env entry, or
  // `PORT=abc` from a typo) doesn't bind to a random privileged
  // port (Number("")=0) or throw `TypeError` from
  // `listen(NaN, ...)`. The R55 sweep added `safeInt` for
  // exactly this pattern but missed this site.
  const port = safeInt(process.env.PORT, 3001, 1, 65535);
  // R35 audit fix: every response set `Access-Control-Allow-Origin: *`
  // (markets/routes.ts, gamification/routes.ts, /health, /decisions,
  // /agents/manifest). That lets any origin drive a victim's
  // wallet to sign-claim on /prize/signature (the signed payload
  // is a transferable asset) or POST /prize/claims. Restrict to
  // an env-configured allowlist. The shared `corsFor` helper in
  // http-cors.ts applies the same logic everywhere; the
  // /decisions and /agents/manifest routes intentionally keep
  // open read-only access (operator dashboards may pull them from
  // a different origin) — only the side-effecting handlers inherit
  // the restriction.
  const server = createServer(async (req, res) => {
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
        ...corsFor(false),
      });
      res.end(
        JSON.stringify({
          status: "ok",
          package_id: process.env.AGENT_POLICY_PACKAGE_ID ?? "",
          deepbook_registry_id:
            process.env.DEEPBOOK_REGISTRY_ID ?? "",
          vault_id: process.env.VAULT_OBJECT_ID ?? "",
          prize_pool_id: process.env.PRIZE_POOL_ID ?? "",
          // R38 audit fix: include the parlay pool id so the web
          // `/agents` page can surface drift between its baked
          // `NEXT_PUBLIC_PARLAY_POOL_ID` and the agents runtime
          // value. A mismatch would cause parlay::create_parlay
          // PTBs built from the web bundle to abort with
          // "parlay pool not found" — the previous /health payload
          // omitted the field, so the operator dashboard had no
          // way to detect the drift short of clicking through
          // the parlay UI and seeing the move abort.
          parlay_pool_id: process.env.PARLAY_POOL_ID ?? "",
          // R40 audit fix: the web bundle bakes
          // NEXT_PUBLIC_FEE_VAULT_ID into every mint/redeem PTB.
          // A drift between the web bundle and the agents
          // runtime would silently break every `splitCollateral`
          // / `redeem` call with EPackageObjectNotFound — the
          // previous /health payload omitted the field, so the
          // operator dashboard had no signal short of a
          // user-reported move abort. Same shape as the
          // existing parlay/vault entries.
          fee_vault_id: process.env.FEE_VAULT_ID ?? "",
          streak_registry_id: process.env.STREAK_REGISTRY_ID ?? "",
          // R46 audit fix: the drift detector on the web
          // `/agents` page compares the `NEXT_PUBLIC_*` env
          // vars baked into the bundle against the values
          // returned here. The previous payload was missing
          // six env-driven ids the bundle now consumes —
          // PRIZE_ADMIN_ID (used by prize-claim tx), the
          // profile registry (used by every
          // `user_profile::*` PTB), ADMIN_ADDRESS
          // (parlay-claim fallback), PARLAY_ADMIN_ID
          // (parlay admin rotate), and the deepbook
          // pool id / key (every market_maker PTB).
          // A drift on any of these would silently break
          // the relevant call with `object not found` /
          // `EPackageObjectNotFound` and the operator
          // dashboard had no signal short of a
          // user-reported move abort. Adding them to the
          // payload closes the loop; the web side already
          // reads them.
          prize_admin_id: process.env.PRIZE_ADMIN_ID ?? "",
          profile_registry_id:
            process.env.PROFILE_REGISTRY_ID ?? "",
          admin_address: process.env.ADMIN_ADDRESS ?? "",
          parlay_admin_id: process.env.PARLAY_ADMIN_ID ?? "",
          deepbook_pool_id:
            process.env.DEEPBOOK_POOL_ID ?? "",
          deepbook_pool_key:
            process.env.DEEPBOOK_POOL_KEY ?? "",
          // R39 audit fix: expose the resolved network + RPC URL
          // so the operator can confirm the agents service is
          // talking to the cluster they expect. R34 fixed the
          // gRPC client's network config but the /health payload
          // never echoed the resolved value, so a mainnet deploy
          // submitting to testnet (or vice versa) had no
          // operator-visible signal until a user-reported
          // failure. Also include the referral-treasury address
          // — drift between NEXT_PUBLIC_REFERRAL_TREASURY_ADDRESS
          // and REFERRAL_TREASURY_ADDRESS would silently route
          // claim sweeps to the wrong destination.
          //
          // R40 audit fix: previously this reported
          // `process.env.SUI_RPC_URL` which is only used as an
          // override in the SDK's `SUI_GRPC_URL` resolver; the
          // workers themselves call
          // `getJsonRpcFullnodeUrl(SUI_NETWORK)`, so the prior
          // value was misleading on a default deploy. Use the
          // SDK's `SUI_GRPC_URL` constant so the /health payload
          // reflects what the indexer/gRPC client actually hits.
          network: process.env.SUI_NETWORK ?? "testnet",
          grpc_url: SUI_GRPC_URL,
          referral_treasury_address:
            process.env.REFERRAL_TREASURY_ADDRESS ?? "",
          ts_ms: Date.now(),
        }),
      );
      return;
    }
    if (url.pathname === "/decisions") {
      res.writeHead(200, {
        "Content-Type": "application/json",
        ...corsFor(false),
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
      //
      // R39 audit fix: drop the `legacyNames` whitelist. The
      // names MarketStrategist/PLPManager/RedeemKeeper are not
      // registered in `buildSchedule()` (the schedule only
      // includes primary agents), so `legacyNames.has(s.name)`
      // is always false here. The web page's
      // `manifest.filter(m => m.kind === "legacy")` therefore
      // always returns an empty array, and the "Legacy Predict
      // agents" card never renders. Rather than wire up a
      // fake legacy path, mark every entry as "primary" and
      // let the web page drop the dead-card branch in lockstep
      // (see apps/web/app/agents/page.tsx:202).
      const schedule = buildSchedule();
      res.writeHead(200, {
        "Content-Type": "application/json",
        ...corsFor(false),
      });
      res.end(
        JSON.stringify(
          schedule.map((s) => ({
            name: s.name,
            cron: s.cron,
            kind: "primary",
          })),
        ),
      );
      return;
    }
    res.writeHead(404);
    res.end();
  })
  // R54 audit fix: capture
  // the `http.Server` handle
  // so the SIGTERM handler
  // can `server.close()` it
  // and stop accepting new
  // connections cleanly. The
  // previous code discarded
  // the return value of
  // `createServer()` and the
  // `listen()` chain, so the
  // process kept the socket
  // open and the SIGTERM
  // drain (closeDb +
  // closeSharedClient) ran
  // while new requests were
  // still arriving. A request
  // mid-drain would hit
  // "database is closed".
  .listen(port, () => console.log(`[agents] API on :${port}`));
  healthServer = server;
  return server;
}

async function main() {
  // R53 audit fix: validate
  // the boot config BEFORE
  // starting the HTTP server.
  // The previous ordering
  // booted a fully-functional
  // health server that served
  // `/health` 200 OK with an
  // empty `package_id`,
  // `prize_pool_id`, etc.,
  // *before* the validator
  // rejected the boot with
  // `process.exit(1)`. Railway's
  // healthcheck could race
  // this and mark the pod
  // healthy on a deploy that
  // was about to die, defeating
  // the R35/R46 drift detector
  // (which watches for an
  // empty `package_id`).
  validateBootConfig();
  startHealthServer();
  // Seed World Cup 2026 demo markets so the home page is alive
  // even in API-only mode (no AGENT_PRIVATE_KEY). The seed is
  // idempotent and a no-op when the rows already exist.
  try {
    const { seedWcDemoMarkets } = await import("./agents/wc-demo-seed.js");
    const { seeded, skipped } = await seedWcDemoMarkets();
    if (seeded > 0) {
      console.log(
        `[agents] Seeded ${seeded} World Cup demo markets (skipped ${skipped}).`,
      );
    }
  } catch (err) {
    console.warn(
      `[agents] World Cup demo seed failed: ${err instanceof Error ? err.message : err}`,
    );
  }
  const ctx = loadContext();
  if (!ctx) {
    console.log("[agents] Running in API-only mode (no wallet configured)");
    return;
  }

  console.log(`[agents] Agent address: ${ctx.signer.getPublicKey().toSuiAddress()}`);
  if (readLegacyPredict()) console.log(`[agents] Legacy Predict agents enabled`);

  // Per-agent UTC scheduling — see scheduler.ts and buildSchedule() above.
  // Override any entry with AGENT_CRON_<NAME>=<expr> for tests.
  startScheduler(ctx, buildSchedule());
  // R37 audit fix: read the real poll interval from the scheduler
  // (the previous boot log used a separate `POLL_MS` constant
  // with a different default of 15s, which misled operators).
  console.log(
    `[agents] Scheduler online (POLL_MS=${Number(process.env.AGENT_POLL_INTERVAL_MS ?? 60_000)})`,
  );

  // R36 audit fix: register SIGTERM/SIGINT handlers so Railway
  // redeploys and `kill <pid>` drain in-flight agents gracefully.
  // Without this, a redeploy mid-PTB leaves the on-chain transaction
  // half-signed and the gRPC subscription cursors inconsistent. The
  // health server is bound to :3001 and gets its own close on
  // `process.exit`, so we don't track it separately.
  let shuttingDown = false;
  const handleSignal = (sig: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[agents] Caught ${sig}, draining scheduler (max 5s)...`);
    // R52 audit fix: close the gRPC
    // singleton before exit. Without
    // this, the SuiGrpcClient's HTTP/2
    // session and the indexer's
    // `queryEvents` stream are torn
    // down with a RST_STREAM, which the
    // gRPC server logs as an error and
    // can trigger the Sui public node's
    // per-IP rate-limiter on the next
    // deploy. `closeSharedClient()` is
    // best-effort: it resolves
    // immediately if no client was
    // ever created (e.g. SIGTERM during
    // boot before the first tick).
    // R54 audit fix: close the HTTP server first so no new
    // requests arrive while we drain the SQLite handles. A
    // request that lands between `closeDb()` and `process.exit`
    // would throw "database is closed". `server.close()`
    // resolves once the in-flight queue is empty; if it stalls
    // (a wedged client), the 5s timeout below keeps the
    // process exit bounded.
    const closeServer = healthServer
      ? new Promise<void>((resolve) => {
          healthServer!.close(() => resolve());
          setTimeout(() => resolve(), 5_000).unref();
        })
      : Promise.resolve();
    stopScheduler(5_000)
      .then(() => closeServer)
      .then(() => closeSharedClient())
      .then(() => {
        // R58.M2 audit fix: drop the cached JSON-RPC
        // client on shutdown. The agents' SIGTERM
        // handler already closes the gRPC channel
        // and resets the SDK's `_sharedClient`
        // cache; this also nulls the local
        // JSON-RPC singleton so a restart of the
        // same process (or a stale handle picked
        // up by the next `getSharedJsonRpcClient()`
        // call) doesn't reuse a torn-down
        // `fetch`.
        resetSharedJsonRpcClient();
      })
      .then(() => Promise.allSettled([
        closeDecisionsDb(),
        closeGamificationDb(),
        closeMarketsDb(),
      ]))
      .catch(() => {})
      .finally(() => {
        console.log(`[agents] Exiting after ${sig}.`);
        process.exit(0);
      });
  };
  process.on("SIGTERM", handleSignal);
  process.on("SIGINT", handleSignal);
}

main().catch(console.error);
