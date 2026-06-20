#!/usr/bin/env -S npx tsx
/**
 * One-shot test: invoke the wc-maker directly (skipping the agent scheduler)
 * to verify the backfilled wc26 rows now produce successful on-chain
 * `place_limit_order` PTBs against the v3 package.
 *
 * NB: the SDK caches `PREDICT_MARKET_PACKAGE_ID` at module-init time, so
 * we MUST load `.env` BEFORE any `import "@suipredict/sdk"`. ES modules
 * hoist all `import` statements, so we can't rely on import order — use
 * a dynamic `import()` for the maker and the keypair.
 */
import dotenv from "dotenv";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Load repo-root .env (script lives at apps/agents/scripts/ → ../../../
// is the repo root).
const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, "..");
for (const p of [
  resolve(__dirname, "../../../.env"),
  resolve(process.cwd(), ".env"),
  resolve(process.cwd(), "../.env"),
  resolve(process.cwd(), "../../.env"),
]) {
  if (existsSync(p)) {
    dotenv.config({ path: p, override: true });
    break;
  }
}

const { runWorldCupMaker } = await import("../dist/agents/world-cup-maker.js");
const { Ed25519Keypair } = await import("@mysten/sui/keypairs/ed25519");

const pk = process.env.AGENT_PRIVATE_KEY;
if (!pk) { console.error("AGENT_PRIVATE_KEY not set"); process.exit(1); }
const keypair = Ed25519Keypair.fromSecretKey(pk);

const ctx = {
  signer: keypair,
  managerId: process.env.BALANCE_MANAGER_ID ?? "",
  policyId: process.env.AGENT_POLICY_ID ?? "",
  maxBudgetUsdc: Number(process.env.AGENT_MAX_BUDGET_USDC ?? 500),
};

console.log("agent addr:", keypair.getPublicKey().toSuiAddress());
console.log("policy:", ctx.policyId);

const result = await runWorldCupMaker(ctx as unknown as Parameters<typeof runWorldCupMaker>[0]);
console.log("\nMaker result:", JSON.stringify(result, null, 2));
