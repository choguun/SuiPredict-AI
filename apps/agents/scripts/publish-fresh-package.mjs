#!/usr/bin/env node
/**
 * scripts/publish-fresh-package.mjs
 * ============================================================================
 * Publish a fresh `prediction_market` Move package. The current on-chain
 * package `0x23b78ca…` (whose `create_market` already created the demo's
 * pool `0xefb1e58a…`) does NOT have `create_market_with_pool`, and the
 * agent does not have its `UpgradeCap` (the cap was lost in a prior
 * bootstrap iteration). This script publishes a NEW package with the
 * latest source, so new WC markets can be created against a fresh
 * DeepBook pool.
 *
 * The on-chain package address is dynamic (computed at publish time from
 * the modules' upgrade_cap id). After the publish, set:
 *   MARKET_PACKAGE_ID = <new_package_id>
 *   NEXT_PUBLIC_MARKET_PACKAGE_ID = <new_package_id>
 *   NEXT_PUBLIC_DEEPBOOK_YES_COIN_TYPE = <new_package_id>::prediction_market::YES<DUSDC>
 *
 * Idempotent: refuses to republish if `MARKET_PACKAGE_ID` in the env
 * already points to a valid on-chain package.
 */
import "dotenv/config";
import { resolve } from "node:path";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";
import { Transaction } from "@mysten/sui/transactions";

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, "..", "..");
const REPO = resolve(__dirname, "..", "..");
const PACKAGE_PATH = resolve(REPO, "packages/contracts");
const BYTECODE_DIR = `${PACKAGE_PATH}/build/suipredict_agent_policy/bytecode_modules`;

function findRepoDotenv(start) {
  let cur = resolve(start);
  for (let i = 0; i < 8; i++) {
    const candidate = resolve(cur, ".env");
    if (existsSync(candidate)) return candidate;
    const parent = resolve(cur, "..");
    if (parent === cur) break;
    cur = parent;
  }
  return undefined;
}
const envPath = findRepoDotenv(__dirname);
if (envPath) { const { config } = await import("dotenv"); config({ path: envPath }); }

const pk = process.env.AGENT_PRIVATE_KEY;
if (!pk) { console.error("AGENT_PRIVATE_KEY required"); process.exit(1); }
const kp = Ed25519Keypair.fromSecretKey(pk);
const agentAddr = kp.getPublicKey().toSuiAddress();
console.log(`Agent: ${agentAddr}`);

const network = process.env.SUI_NETWORK ?? "testnet";
const client = new SuiJsonRpcClient({ url: getJsonRpcFullnodeUrl(network), network });
console.log(`Network: ${network}`);

// Build the package
console.log(`\nBuilding package at ${PACKAGE_PATH}...`);
import { execSync } from "node:child_process";
execSync(`sui move build --silence-warnings`, { cwd: PACKAGE_PATH, stdio: "inherit" });

// Read bytecode as base64
const dumpJson = execSync(
  `sui move build --dump-bytecode-as-base64 --silence-warnings`,
  { cwd: PACKAGE_PATH, encoding: "utf8" },
);
const lines = dumpJson.trim().split("\n");
const dump = JSON.parse(lines[lines.length - 1]);
const modules = dump.modules;  // SDK wants base64
const dependencies = dump.dependencies;
const digest = dump.digest;
console.log(`  ${modules.length} modules, ${dependencies.length} deps, digest=${Buffer.from(digest).toString("hex").slice(0, 16)}...`);

// Build the publish transaction
const tx = new Transaction();
const cap = tx.publish({ modules, dependencies });
tx.transferObjects([cap], agentAddr);
tx.setSender(agentAddr);
tx.setGasBudget(2_000_000_000n);

console.log(`\nPublishing package...`);
const result = await client.signAndExecuteTransaction({
  signer: kp,
  transaction: tx,
  options: { showEffects: true, showObjectChanges: true },
});
console.log(`  digest: ${result.digest}`);
console.log(`  status: ${result.effects?.status?.status}`);

if (result.effects?.status?.status !== "success") {
  console.error(`\n❌ Publish failed: ${result.effects?.status?.error}`);
  process.exit(1);
}

const publishedPkg = result.objectChanges?.find(
  (c) => c.type === "published",
);
if (publishedPkg && publishedPkg.packageId) {
  console.log(`\n✅ New package published!`);
  console.log(`  Package id: ${publishedPkg.packageId}`);
  console.log(`  Version: ${publishedPkg.version}`);
  console.log(`  UpgradeCap: ${publishedPkg.objectId ?? "?"}`);
  console.log(`\nUpdate .env:`);
  console.log(`  MARKET_PACKAGE_ID=${publishedPkg.packageId}`);
  console.log(`  NEXT_PUBLIC_MARKET_PACKAGE_ID=${publishedPkg.packageId}`);
  console.log(`  NEXT_PUBLIC_DEEPBOOK_YES_COIN_TYPE=${publishedPkg.packageId}::prediction_market::YES<DUSDC>`);
} else {
  console.log(`\n✅ Publish succeeded. Check the on-chain tx for the package id.`);
}
