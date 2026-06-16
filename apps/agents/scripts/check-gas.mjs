#!/usr/bin/env node
/**
 * scripts/check-gas.mjs
 * ============================================================================
 * Check the agent's SUI balance and surface a clear "what to do" if it's
 * below the gas threshold. Run before the demo:
 *
 *   node scripts/check-gas.mjs
 *   node scripts/check-gas.mjs --min 0.5
 *
 * The Sui CLI's `sui client faucet` redirects to the Web UI on testnet
 * (see `sui client faucet --address <addr>` → "For testnet tokens, please
 * use the Web UI"). This script is the friendlier replacement.
 *
 * Optional env overrides:
 *   GAS_THRESHOLD_SUI  default 0.05 (the minimum for one PTB on testnet)
 *   AGENT_PRIVATE_KEY  default: read from apps/agents/.env or repo root .env
 * ============================================================================
 */
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { existsSync } from "node:fs";

// ---------------------------------------------------------------------------
// Env loading — find the repo root and load .env
// ---------------------------------------------------------------------------
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
const dotenvPath = findRepoDotenv(process.cwd());
if (dotenvPath) loadDotenv({ path: dotenvPath });

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const minArgIdx = args.indexOf("--min");
const minSui = minArgIdx >= 0
  ? Number(args[minArgIdx + 1])
  : Number(process.env.GAS_THRESHOLD_SUI ?? "0.05");

if (!process.env.AGENT_PRIVATE_KEY) {
  console.error("ERROR: AGENT_PRIVATE_KEY is not set in .env");
  console.error("       Run from the repo root so the script can find .env");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Balance check
// ---------------------------------------------------------------------------
const kp = Ed25519Keypair.fromSecretKey(process.env.AGENT_PRIVATE_KEY);
const addr = kp.getPublicKey().toSuiAddress();
const network = process.env.SUI_NETWORK ?? "testnet";
const baseUrl = network === "mainnet"
  ? "https://fullnode.mainnet.sui.io:443"
  : network === "devnet"
  ? "https://fullnode.devnet.sui.io:443"
  : "https://fullnode.testnet.sui.io:443";

const client = new SuiGrpcClient({ network, baseUrl });
const balance = await client.getBalance({ owner: addr });
const balanceMist = BigInt(balance.balance?.balance ?? "0");
const balanceSui = Number(balanceMist) / 1e9;

console.log(`\nAgent address: ${addr}`);
console.log(`Network:       ${network}`);
console.log(`SUI balance:   ${balanceSui.toFixed(6)} SUI (${balanceMist} MIST)`);
console.log(`Threshold:     ${minSui} SUI`);

if (balanceSui < minSui) {
  console.error(`\n❌ Agent is BELOW the gas threshold.`);
  console.error(`   The faucet will fail with "Faucet is out of gas" until topped up.\n`);
  console.error(`   To top up on testnet, visit one of:`);
  console.error(`     https://faucet.sui.io/?address=${addr}`);
  console.error(`     https://docs.sui.io/guides/developer/getting-started/get-test-tokens\n`);
  console.error(`   Or transfer from another testnet account:`);
  console.error(`     sui client transfer-sui <amount_in_MIST> ${addr}\n`);
  process.exit(2);
}

console.log(`\n✅ Agent has enough gas for ~${Math.floor(balanceSui / minSui)} faucet mints.`);
process.exit(0);
