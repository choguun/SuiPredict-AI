#!/usr/bin/env node
/**
 * R-WC-1.4 bootstrap: a one-off script to bootstrap a complete
 * working set of on-chain objects (FeeVault, Market, Pool,
 * BalanceManager) for the new package. This is meant to be
 * run once after the contract has been republished with the
 * `init_fee_vault_fallback` function.
 *
 * Usage:
 *   cd apps/agents
 *   AGENT_PRIVATE_KEY=... node scripts/bootstrap-new-package.mjs
 *
 * Or, to use a specific package id (skip publish):
 *   AGENT_PRIVATE_KEY=... NEW_PACKAGE_ID=0x... node scripts/bootstrap-new-package.mjs --skip-publish
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import Database from "better-sqlite3";
import "dotenv/config";
import { DUSDC_TYPE, DEEP_TYPE, POOL_CREATION_FEE_DEEP } from "@suipredict/sdk";
import {
  fetchMatchSchedule,
  matchWinnerTitle,
  matchWinnerResolutionSource,
} from "../dist/agents/world-cup-fetcher.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "../../..");
const PKG_DIR = resolve(REPO_ROOT, "packages/contracts");
const AGENTS_ENV = resolve(REPO_ROOT, ".env");
const WEB_ENV = resolve(REPO_ROOT, "apps/web/.env.local");
const DB_PATH = resolve(__dirname, "../data/markets.db");

function readEnv(p) {
  if (!existsSync(p)) return {};
  const lines = readFileSync(p, "utf-8").split("\n");
  const out = {};
  for (const line of lines) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function writeEnv(p, env) {
  const lines = Object.entries(env)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  writeFileSync(p, lines + "\n");
}

/**
 * Sign + execute a Transaction via the sui CLI. The SDK's
 * gRPC-based `executeTransaction` has been hitting transient
 * "Cannot read properties of undefined (reading 'endsWith')"
 * errors on the public testnet; the CLI is more reliable
 * for one-off bootstraps.
 */
async function executeViaCli(tx, kp, network, client) {
  // 1. Build the tx (unsigned) to base64
  const txBytes = await tx.build({ client, onlyTransactionKind: false });
  const txB64 = Buffer.from(txBytes).toString("base64");
  // 2. Sign the tx with the agent's keypair. signTransaction
  //    returns `{ bytes, signature }` where `signature` is the
  //    base64-encoded `flag || sig || pubkey` — the exact format
  //    the sui CLI's `execute-signed-tx --signatures` expects.
  const { signature } = await kp.signTransaction(txBytes);
  // 3. Run sui execute-signed-tx
  const result = spawnSync("sui", [
    "client", "execute-signed-tx",
    "--tx-bytes", txB64,
    "--signatures", signature,
    "--json",
  ], { encoding: "utf-8" });
  if (result.status !== 0) {
    throw new Error(`sui execute-signed-tx failed: ${result.stderr.slice(-1500)}`);
  }
  // The CLI outputs JSON
  const out = result.stdout;
  // Find the last JSON object
  let jsonStart = -1, jsonEnd = -1, depth = 0;
  for (let i = 0; i < out.length; i++) {
    if (out[i] === "{") {
      if (jsonStart === -1) jsonStart = i;
      depth++;
    } else if (out[i] === "}") {
      depth--;
      if (depth === 0 && jsonStart !== -1) {
        const candidate = out.slice(jsonStart, i + 1);
        try {
          const parsed = JSON.parse(candidate);
          if (parsed.digest || parsed.effects) {
            return parsed;
          }
        } catch {}
        jsonStart = -1;
      }
    }
  }
  throw new Error("executeViaCli: no valid JSON in output: " + out.slice(-500));
}

function findCreatedObjectId(result, typeFilter) {
  for (const c of result.objectChanges ?? []) {
    if (c.type === "created" && c.objectType?.includes(typeFilter)) {
      return c.objectId;
    }
  }
  return undefined;
}

async function publishNewPackage() {
  console.log("Publishing new package (this takes ~30s on testnet)...");
  const env = { ...process.env, SUI_NETWORK: process.env.SUI_NETWORK ?? "testnet" };
  const publish = spawnSync("sui", [
    "client", "publish", "--json", "--gas-budget", "300000000", "--silence-warnings",
  ], {
    cwd: PKG_DIR, env, encoding: "utf-8", maxBuffer: 128 * 1024 * 1024,
  });
  if (publish.status !== 0) {
    console.error("publish failed:", publish.stderr.slice(-2000));
    process.exit(1);
  }
  const out = publish.stdout;
  // Find the last JSON object
  let jsonStart = -1;
  let jsonEnd = -1;
  let depth = 0;
  for (let i = 0; i < out.length; i++) {
    if (out[i] === "{") {
      if (jsonStart === -1) jsonStart = i;
      depth++;
    } else if (out[i] === "}") {
      depth--;
      if (depth === 0 && jsonStart !== -1) {
        jsonEnd = i + 1;
        // Keep scanning for a larger valid JSON
        const candidate = out.slice(jsonStart, jsonEnd);
        if (candidate.includes("objectChanges")) {
          const result = JSON.parse(candidate);
          const newPackageId = result.objectChanges?.find((c) => c.type === "published")?.packageId;
          const newAdminCapId = result.objectChanges?.find(
            (c) => c.type === "created" && c.objectType?.includes("ProtocolAdminCap"),
          )?.objectId;
          if (newPackageId) {
            return { newPackageId, newAdminCapId };
          }
        }
        jsonStart = -1;
      }
    }
  }
  throw new Error("publish: no valid publish JSON found");
}

async function main() {
  const pk = process.env.AGENT_PRIVATE_KEY;
  if (!pk) throw new Error("AGENT_PRIVATE_KEY is required");
  const kp = Ed25519Keypair.fromSecretKey(pk);
  const agentAddr = kp.getPublicKey().toSuiAddress();
  console.log(`agent: ${agentAddr}`);
  const network = process.env.SUI_NETWORK ?? "testnet";

  // ─── 1. Publish (or use existing) ──────────────────────────────
  let newPackageId, newAdminCapId;
  if (!process.argv.includes("--skip-publish") && !process.env.NEW_PACKAGE_ID) {
    const pub = await publishNewPackage();
    newPackageId = pub.newPackageId;
    newAdminCapId = pub.newAdminCapId;
  } else {
    newPackageId = process.env.NEW_PACKAGE_ID;
    newAdminCapId = process.env.NEW_ADMIN_CAP_ID ?? "0x0";
  }
  console.log(`Package: ${newPackageId}`);
  console.log(`AdminCap: ${newAdminCapId}`);

  // ─── 2. Set up the JSON-RPC client ─────────────────────────────
  const client = new SuiJsonRpcClient({ url: getJsonRpcFullnodeUrl(network), network });

  // ─── 3. init_fee_vault_fallback ────────────────────────────────
  console.log("Calling init_fee_vault_fallback<DUSDC>...");
  {
    const tx = new Transaction();
    tx.moveCall({
      target: `${newPackageId}::prediction_market::init_fee_vault_fallback`,
      typeArguments: [DUSDC_TYPE],
      arguments: [],
    });
    tx.setSender(agentAddr);
    const result = await executeViaCli(tx, kp, network, client);
    if (result.effects?.status?.status !== "success") {
      throw new Error(`init_fee_vault_fallback failed: ${JSON.stringify(result.effects?.status)}`);
    }
    const feeVaultId = findCreatedObjectId(result, "FeeVault");
    if (!feeVaultId) throw new Error("init_fee_vault_fallback: no FeeVault in effects");
    console.log(`FeeVault: ${feeVaultId}`);
    globalThis.feeVaultId = feeVaultId;
  }
  const feeVaultId = globalThis.feeVaultId;

  // ─── 4. Find the next WC match ─────────────────────────────────
  const allMatches = await fetchMatchSchedule();
  const now = Date.now();
  const oneWeekAhead = now + 7 * 24 * 60 * 60 * 1000;
  const nextMatch = allMatches
    .filter((m) => m.kickoffMs > now && m.kickoffMs < oneWeekAhead)
    .sort((a, b) => a.kickoffMs - b.kickoffMs)[0];
  if (!nextMatch) throw new Error("no WC match in the next 7 days");
  console.log(`Next match: ${nextMatch.id}`);

  // ─── 5. Get a 500-DEEP coin ─────────────────────────────────────
  const allCoins = await client.getAllCoins({ owner: agentAddr });
  const deepCoins = allCoins.data.filter((c) => c.coinType === DEEP_TYPE);
  const bigDeep = deepCoins.find((c) => BigInt(c.balance) >= POOL_CREATION_FEE_DEEP);
  if (!bigDeep) throw new Error("no DEEP coin >= 500 DEEP");

  // ─── 6. Create the market ──────────────────────────────────────
  console.log(`Creating wc26-${nextMatch.id} market...`);
  let newMarketId, newPoolId;
  {
    const tx = new Transaction();
    tx.moveCall({
      target: `${newPackageId}::prediction_market::create_market`,
      typeArguments: [DUSDC_TYPE],
      arguments: [
        tx.object("0xc"),
        tx.object(process.env.DEEPBOOK_REGISTRY_ID ?? "0xe14eba90fc8cc14a2eac1199b207d4e664931f8196f612b5aacf0c4a7f7d7a6f"),
        tx.pure.vector("u8", new TextEncoder().encode(matchWinnerTitle(nextMatch))),
        tx.pure.vector("u8", new TextEncoder().encode(matchWinnerResolutionSource(nextMatch))),
        tx.pure.u64(BigInt(nextMatch.kickoffMs + 2 * 60 * 60 * 1000)),
        tx.pure.u64(1_000_000n),
        tx.pure.u64(1_000_000n),
        tx.pure.u64(1_000_000n),
        tx.object(bigDeep.coinObjectId),
        tx.pure.u8(3),
      ],
    });
    tx.setSender(agentAddr);
    const result = await executeViaCli(tx, kp, network, client);
    if (result.effects?.status?.status !== "success") {
      throw new Error(`create_market failed: ${JSON.stringify(result.effects?.status)}`);
    }
    newMarketId = findCreatedObjectId(result, "PredictionMarket");
    if (!newMarketId) throw new Error("create_market: no PredictionMarket in effects");
    const newMarketObj = await client.getObject({ id: newMarketId, options: { showContent: true } });
    newPoolId = newMarketObj.data?.content?.fields?.pool_id;
    if (!newPoolId) throw new Error("create_market: no pool_id");
  }
  console.log(`Market: ${newMarketId}`);
  console.log(`Pool:   ${newPoolId}`);

  // ─── 7. Update SQLite ──────────────────────────────────────────
  const db = new Database(DB_PATH);
  const wcId = `wc26-${nextMatch.id}`;
  const res = db.prepare(`UPDATE markets SET
    onchain_market_id = ?, deepbook_pool_id = ?, status = 'active',
    pool_id = ?, order_book_id = ?,
    created_at_ms = COALESCE(created_at_ms, ?)
    WHERE id = ?`).run(
    newMarketId, newPoolId, newPoolId, newPoolId, Date.now(), wcId,
  );
  console.log(`SQLite: ${res.changes} row(s) updated for ${wcId}`);
  db.close();

  // ─── 8. Update env vars ────────────────────────────────────────
  const envAgents = readEnv(AGENTS_ENV);
  const envWeb = readEnv(WEB_ENV);
  for (const env of [envAgents, envWeb]) {
    env.NEXT_PUBLIC_MARKET_PACKAGE_ID = newPackageId;
    env.NEXT_PUBLIC_AGENT_POLICY_PACKAGE_ID = newPackageId;
    env.NEXT_PUBLIC_FEE_VAULT_ID = feeVaultId;
  }
  envAgents.MARKET_PACKAGE_ID = newPackageId;
  envAgents.AGENT_POLICY_PACKAGE_ID = newPackageId;
  envAgents.FEE_VAULT_ID = feeVaultId;
  writeEnv(AGENTS_ENV, envAgents);
  writeEnv(WEB_ENV, envWeb);
  console.log("env: updated");

  // ─── 9. Summary ────────────────────────────────────────────────
  console.log("\n=== Summary ===");
  console.log(`Package:  ${newPackageId}`);
  console.log(`AdminCap: ${newAdminCapId}`);
  console.log(`FeeVault: ${feeVaultId}`);
  console.log(`Market:   ${newMarketId}`);
  console.log(`Pool:     ${newPoolId}`);
  console.log(`WC id:    ${wcId}`);
  console.log("\nRestart agents + web to pick up new env vars.");
  console.log(`\nRe-run with: --skip-publish NEW_PACKAGE_ID=${newPackageId}`);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
