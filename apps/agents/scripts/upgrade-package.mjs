#!/usr/bin/env node
/**
 * scripts/upgrade-package.mjs
 * ============================================================================
 * Upgrade the on-chain `prediction_market` package using the agent's
 * UpgradeCap. Adds the `create_market_with_pool` function so the
 * world-cup-creator can publish on-chain markets against the existing
 * DeepBook YES<DUSDC> pool (`0xefb1e58a...`).
 *
 * Required env (loaded from .env):
 *   AGENT_PRIVATE_KEY            — ed25519 secret of the agent
 *
 * Usage:
 *   cd apps/agents
 *   node scripts/upgrade-package.mjs
 */
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";
import { Transaction } from "@mysten/sui/transactions";
import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO = resolve(__dirname, "../../..");

// The OLD prediction_market package we want to upgrade.
// (See SOPs/AGENT-OPS.md for how the addresses were derived.)
const UPGRADE_CAP_ID =
  "0x4482d0a2e369d7580a5caf2b030b8d3e2126a685a9ec448ba3791b03b00cf499";
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
if (!pk) {
  console.error("ERROR: AGENT_PRIVATE_KEY is required (set in .env)");
  process.exit(1);
}
const kp = Ed25519Keypair.fromSecretKey(pk);
const agentAddr = kp.getPublicKey().toSuiAddress();
console.log(`Agent: ${agentAddr}`);

const network = process.env.SUI_NETWORK ?? "testnet";
const client = new SuiJsonRpcClient({ url: getJsonRpcFullnodeUrl(network), network });
console.log(`Network: ${network}`);

// 1. Build the package and dump bytecode as base64 to
// also extract the package digest (used as the
// `authorize_upgrade` digest argument). The digest is
// the SHA-256 of the [modules, dependencies, linkage]
// tuple, computed by the Move build tool and emitted
// only when `--dump-bytecode-as-base64` is used.
console.log(`\nBuilding package at ${PACKAGE_PATH}...`);
const dumpJson = execSync(
  `sui move build --dump-bytecode-as-base64 --silence-warnings`,
  { cwd: PACKAGE_PATH, encoding: "utf8" },
);
// The dump is the last JSON line of the build output.
const lines = dumpJson.trim().split("\n");
const dump = JSON.parse(lines[lines.length - 1]);
const modules = dump.modules.map((b64) => Uint8Array.from(Buffer.from(b64, "base64")));
const dependencies = dump.dependencies;
const digest = dump.digest;
console.log(`  ${modules.length} modules, ${dependencies.length} deps, digest=${Buffer.from(digest).toString("hex").slice(0, 16)}...`);

// 2. Build the upgrade transaction.
const tx = new Transaction();
const cap = tx.object(UPGRADE_CAP_ID);
const ticket = tx.moveCall({
  target: "0x2::package::authorize_upgrade",
  arguments: [
    cap,
    tx.pure.u8(0),  // UpgradePolicy::COMPATIBLE
    tx.pure.vector("u8", digest),
  ],
});
const receipt = tx.upgrade({
  modules,
  dependencies,
  package: "0x23b78cabb824ccaf9a24f3fe335ae144b3fa3d21a53955ca4e3f01544a0c2d52",  // OLD package
  ticket,
});
tx.moveCall({
  target: "0x2::package::commit_upgrade",
  arguments: [cap, receipt],
});
tx.setGasBudget(1_000_000_000n);

console.log(`\nBuilt upgrade tx (${tx.getData().commands.length} commands):`);
for (let i = 0; i < tx.getData().commands.length; i++) {
  const c = tx.getData().commands[i];
  console.log(`  [${i}]`, c.$kind, c.MoveCall?.target ?? c.Upgrade?.package?.slice(0,18) ?? '');
}

console.log(`\nSigning and executing upgrade tx...`);
const result = await client.signAndExecuteTransaction({
  signer: kp,
  transaction: tx,
  options: { showEffects: true, showObjectChanges: true },
});
console.log(`  digest: ${result.digest}`);
console.log(`  status: ${result.effects?.status?.status}`);

if (result.effects?.status?.status === "success") {
  const upgradedPkg = result.objectChanges?.find(
    (c) => c.type === "published" && c.packageId === "0x23b78cabb824ccaf9a24f3fe335ae144b3fa3d21a53955ca4e3f01544a0c2d52",
  );
  if (upgradedPkg) {
    console.log(`  Upgraded package id: ${upgradedPkg.packageId} (version ${upgradedPkg.version ?? "?"})`);
  } else {
    console.log(`  Upgrade succeeded. Check the on-chain package for new version.`);
  }
  console.log(`\n✅ Package upgraded. create_market_with_pool should now be on-chain.`);
} else {
  console.error(`\n❌ Upgrade failed: ${result.effects?.status?.error}`);
  process.exit(1);
}
