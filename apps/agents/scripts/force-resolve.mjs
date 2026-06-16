#!/usr/bin/env node
/**
 * scripts/force-resolve.mjs
 * ============================================================================
 * Manually invoke the MarketResolver to settle any expired markets.
 *
 * The MarketResolver agent runs at 58 23 * * * (UTC), so an expired
 * market in the morning won't be resolved until 11:58 PM. For a demo
 * where the audience wants to see resolved markets, run this script
 * after the demo to settle the past-expired markets.
 *
 * Usage:
 *   node scripts/force-resolve.mjs            # resolve all expired
 *   node scripts/force-resolve.mjs --dry-run  # list without resolving
 *   node scripts/force-resolve.mjs <market_id>  # resolve one market
 */
import "dotenv/config";
import { runMarketResolver } from "../src/agents/market-resolver.ts";
import { runWorldCupResolver } from "../src/agents/world-cup-resolver.ts";
import { keypairFromPrivateKey } from "@suipredict/sdk";
import { listMarkets } from "../src/markets/store.ts";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const targetId = args.find((a) => !a.startsWith("--"));

const pk = process.env.AGENT_PRIVATE_KEY;
if (!pk) {
  console.error("[force-resolve] AGENT_PRIVATE_KEY is required (set in .env)");
  process.exit(1);
}

const ctx = {
  signer: keypairFromPrivateKey(pk),
  managerId: process.env.AGENT_MANAGER_ID ?? "",
  policyId: process.env.AGENT_POLICY_ID,
  maxBudgetUsdc: 500,
};

const now = Date.now();
const all = listMarkets();
const expired = all.filter(
  (m) =>
    m.status === "active" &&
    m.expiry_ms <= now &&
    m.category !== "worldcup" &&
    (!targetId || m.id === targetId),
);
const expiredWc = all.filter(
  (m) =>
    m.status === "active" &&
    m.expiry_ms <= now &&
    m.category === "worldcup" &&
    (!targetId || m.id === targetId),
);

console.log(`[force-resolve] Found ${expired.length} non-WC expired market(s)`);
for (const m of expired) {
  console.log(`  - ${m.id}: ${m.title}`);
}
console.log(`[force-resolve] Found ${expiredWc.length} WC expired market(s)`);
for (const m of expiredWc) {
  console.log(`  - ${m.id}: ${m.title}`);
}

if (dryRun) {
  console.log(`[force-resolve] --dry-run; not resolving.`);
  process.exit(0);
}

if (expired.length > 0) {
  console.log(`[force-resolve] Running MarketResolver…`);
  const r = await runMarketResolver(ctx);
  console.log(`  action: ${r.action}`);
  console.log(`  reasoning: ${r.reasoning.slice(0, 200)}`);
}

if (expiredWc.length > 0) {
  console.log(`[force-resolve] Running WorldCupResolver…`);
  const r = await runWorldCupResolver(ctx);
  console.log(`  action: ${r.action}`);
  console.log(`  reasoning: ${r.reasoning.slice(0, 200)}`);
}

process.exit(0);
