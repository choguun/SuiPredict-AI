#!/usr/bin/env node
/**
 * scripts/bootstrap-wc-markets-simple.mjs
 * ============================================================================
 * Simple WC market bootstrapper: calls `create_market` for every market,
 * creating a fresh DeepBook pool (500 DEEP) per market. The 8 markets in
 * the next 7d window need 4,000 DEEP; the agent has 11,500 DEEP, so plenty
 * of headroom.
 *
 * Each market gets its own pool. This is less efficient than sharing a
 * pool via `create_market_with_pool`, but it works around the
 * `ECurrencyAlreadyExists` abort that fires when the SDK re-registers
 * the YES/NO types via `coin_registry::new_currency` for the same
 * (package, type) pair.
 *
 * Idempotent: re-runs skip markets that already have a non-null
 * `onchain_market_id` in the SQLite mirror.
 */
import "dotenv/config";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";
import { Transaction } from "@mysten/sui/transactions";
import { resolveMarketPackageId, resolveDeepbookPackageId, buildCreateMarketTx } from "@suipredict/sdk";

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, "..");
const dbPath = resolve(__dirname, "../data/markets.db");

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

const { fetchMatchSchedule, matchWinnerTitle, matchWinnerDescription, matchWinnerResolutionSource } = await import("../dist/agents/world-cup-fetcher.js");

async function main() {
  const pk = process.env.AGENT_PRIVATE_KEY;
  if (!pk) throw new Error("AGENT_PRIVATE_KEY required");
  const kp = Ed25519Keypair.fromSecretKey(pk);
  const agentAddr = kp.getPublicKey().toSuiAddress();
  console.log(`Agent: ${agentAddr}`);

  const network = process.env.SUI_NETWORK ?? "testnet";
  const client = new SuiJsonRpcClient({ url: getJsonRpcFullnodeUrl(network), network });
  const MARKET_PKG = resolveMarketPackageId();
  const DEEPBOOK_PKG = resolveDeepbookPackageId();
  const DEEPBOOK_REGISTRY = process.env.DEEPBOOK_REGISTRY_ID ?? "0xe14eba90fc8cc14a2eac1199b207d4e664931f8196f612b5aacf0c4a7f7d7a6f";
  const DUSDC_TYPE = process.env.NEXT_PUBLIC_DUSDC_TYPE || process.env.DUSDC_TYPE || "0xe9a73a6f4457f6ecad6260a37a200745a8009e9ee1a235ab91f8d3c030d3a705::dusdc::DUSDC";
  console.log(`Market package: ${MARKET_PKG}`);
  console.log(`DeepBook package: ${DEEPBOOK_PKG}`);

  // SUI balance
  const suiBal = await client.getBalance({ owner: agentAddr });
  const suiMist = BigInt(suiBal.totalBalance ?? suiBal.balance?.balance ?? "0");
  console.log(`SUI balance: ${Number(suiMist) / 1e9} SUI`);
  if (suiMist < 1_000_000_000n) {
    console.error("ERROR: need at least 5 SUI for gas (8 markets × ~0.5 SUI each)");
    process.exit(1);
  }

  // DEEP balance (self-hosted type)
  const ACTUAL_DEEP_TYPE = "0x7b86477fb48be71179877784f75c44d260e15e429bce8da658a0ebf7aa48ae7b::deep::DEEP";
  const allCoins = await client.getAllCoins({ owner: agentAddr, limit: 100 });
  const deepCoins = allCoins.data.filter((c) => c.coinType === ACTUAL_DEEP_TYPE && BigInt(c.balance) >= 500_000_000n);
  console.log(`DEEP coins >= 500: ${deepCoins.length}`);
  if (deepCoins.length < 8) {
    console.error("ERROR: need at least 8 DEEP coins of 500+ each");
    process.exit(1);
  }

  // DB
  const db = new Database(dbPath);
  const existing = db.prepare("SELECT id, onchain_market_id FROM markets WHERE id LIKE 'wc26-%'").all();
  const existingMap = new Map(existing.map((m) => [m.id, m]));

  // Fetch WC schedule
  const allMatches = await fetchMatchSchedule();
  const now = Date.now();
  const oneWeekAhead = now + 7 * 24 * 60 * 60 * 1000;
  const targets = allMatches
    .filter((m) => (m.kickoffMs > now - 24 * 60 * 60 * 1000 && m.kickoffMs < now) || (m.kickoffMs >= now && m.kickoffMs <= oneWeekAhead))
    .sort((a, b) => a.kickoffMs - b.kickoffMs)
    .slice(0, 8);

  console.log(`\nTarget: ${targets.length} WC markets in next 7d`);
  console.log(`Strategy: create_market per market (each gets its own pool, 500 DEEP)\n`);

  let created = 0, skipped = 0, failed = 0;
  for (let i = 0; i < targets.length; i++) {
    const m = targets[i];
    const id = `wc26-${m.id}`;
    const ex = existingMap.get(id);
    if (ex && ex.onchain_market_id) {
      console.log(`  [SKIP] ${id} already on-chain`);
      skipped++;
      continue;
    }
    const title = matchWinnerTitle(m);
    const description = matchWinnerDescription(m);
    const resolutionSource = matchWinnerResolutionSource(m);
    const expiryMs = m.kickoffMs + 2 * 60 * 60 * 1000;
    const deepCoin = deepCoins[i % deepCoins.length];
    try {
      const tx = buildCreateMarketTx({
        title,
        resolutionSource,
        expiryMs: BigInt(expiryMs),
        deepCoinId: deepCoin.coinObjectId,
        category: 3,
      });
      tx.setSender(agentAddr);
      const result = await client.signAndExecuteTransaction({ signer: kp, transaction: tx });
      if (!result.digest) throw new Error("No digest");
      console.log(`  [OK] ${id} → digest=${result.digest.slice(0, 18)}…`);
      await new Promise((r) => setTimeout(r, 5000));
      const txResult = await client.getTransactionBlock({ digest: result.digest, options: { showObjectChanges: true } });
      const newObjects = txResult.objectChanges?.filter((c) => c.type === "created") || [];
      const marketObj = newObjects.find((o) => o.objectType?.includes("PredictionMarket"));
      if (!marketObj) throw new Error("PredictionMarket not found");
      const onchainId = marketObj.objectId;
      const m2 = await client.getObject({ id: onchainId, options: { showContent: true } });
      const fields = m2?.data?.content?.dataType === "moveObject" ? m2.data.content.fields : null;
      const poolId = fields?.pool_id;
      console.log(`         onchain=${onchainId.slice(0, 18)}… pool=${poolId?.slice(0, 18) ?? "null"}…`);
      db.prepare("UPDATE markets SET onchain_market_id = ?, deepbook_pool_id = ? WHERE id = ?").run(onchainId, poolId, id);
      created++;
    } catch (err) {
      console.error(`  [FAIL] ${id}: ${err.message?.slice(0, 200)}`);
      failed++;
    }
  }

  console.log(`\n=== Summary ===`);
  console.log(`Created: ${created}`);
  console.log(`Skipped: ${skipped}`);
  console.log(`Failed: ${failed}`);
  db.close();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => { console.error("FATAL:", err); process.exit(1); });
