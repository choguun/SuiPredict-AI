#!/usr/bin/env node
/**
 * scripts/bootstrap-wc-markets.mjs
 * ============================================================================
 * Bootstrap on-chain World Cup 2026 prediction markets.
 *
 * For each WC 2026 match in the next 7 days, this script:
 *   1. Tries `create_market` (creates a new DeepBook pool + market).
 *   2. On `EPoolAlreadyExists` (DeepBook abort code 1) — meaning a
 *      YES<DUSDC> pool is already in the registry from a prior
 *      bootstrap — falls back to `create_market_with_pool`, the
 *      new R-UAT-23 entry point that reuses the existing pool.
 *   3. Extracts the new market id and the `deepbook_pool_id` field
 *      from the on-chain object.
 *   4. Writes both back to the SQLite mirror so the web UI shows
 *      on-chain state.
 *   5. Idempotent: re-running skips markets that already have a
 *      non-null `onchain_market_id`.
 *
 * Cost:
 *   - First market: 500 DEEP + ~0.01 SUI (creates the pool)
 *   - Subsequent markets (pool exists): ~0.01 SUI each (no DEEP)
 *   - 47 markets: ~1 SUI total. The agent has 3.86 SUI; sufficient.
 *
 * Usage:
 *   cd apps/agents
 *   node scripts/bootstrap-wc-markets.mjs
 */
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";
import { Transaction } from "@mysten/sui/transactions";
import { resolveMarketPackageId, resolveDeepbookPackageId } from "@suipredict/sdk";
import "dotenv/config";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

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
const envPath = findRepoDotenv(process.cwd());
if (envPath) { const { config } = await import("dotenv"); config({ path: envPath }); }

const { fetchMatchSchedule, matchWinnerTitle, matchWinnerDescription, matchWinnerResolutionSource } = await import("../dist/agents/world-cup-fetcher.js");

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, "..");
const dbPath = resolve(__dirname, "../data/markets.db");
const db = new Database(dbPath);

function getAgentKeypair() {
  const pk = process.env.AGENT_PRIVATE_KEY;
  if (!pk) throw new Error("AGENT_PRIVATE_KEY is required");
  return Ed25519Keypair.fromSecretKey(pk);
}

function utf8ToBytes(str) { return new TextEncoder().encode(str); }

async function main() {
  const kp = getAgentKeypair();
  const agentAddr = kp.getPublicKey().toSuiAddress();
  console.log(`Agent: ${agentAddr}`);

  const network = process.env.SUI_NETWORK ?? "testnet";
  const client = new SuiJsonRpcClient({ url: getJsonRpcFullnodeUrl(network), network });
  console.log(`Network: ${network}`);
  console.log(`Market package: ${resolveMarketPackageId()}`);
  console.log(`DeepBook package: ${resolveDeepbookPackageId()}`);

  // --- balance check ---
  const suiBal = await client.getBalance({ owner: agentAddr });
  const suiMist = BigInt(suiBal.totalBalance ?? suiBal.balance?.balance ?? "0");
  console.log(`SUI balance: ${Number(suiMist) / 1e9} SUI`);
  // R62 fix: query all coins (the SDK's coinType filter
  // is broken in v2), filter client-side to the DEEP type
  // matching the on-chain `create_market` (which expects
  // the self-hosted DEEP at 0x7b86477f...).
  const ACTUAL_DEEP_TYPE = "0x7b86477fb48be71179877784f75c44d260e15e429bce8da658a0ebf7aa48ae7b::deep::DEEP";
  const allCoins = await client.getAllCoins({ owner: agentAddr, limit: 100 });
  const deepBal = { data: allCoins.data.filter(c => c.coinType === ACTUAL_DEEP_TYPE) };
  let deepTotal = 0n;
  for (const c of deepBal.data) deepTotal += BigInt(c.balance);
  console.log(`DEEP balance: ${Number(deepTotal) / 1e6} DEEP (${deepBal.data.length} coins)`);

  if (suiMist < 1_000_000_000n) {
    console.error("ERROR: need at least 1 SUI for gas");
    process.exit(1);
  }
  if (deepTotal < 500_000_000n * 10n) {
    console.error("ERROR: need at least 5000 DEEP (for first market only)");
    process.exit(1);
  }

  // --- env config ---
  const MARKET_PKG = resolveMarketPackageId();
  const DB_REGISTRY = process.env.DEEPBOOK_REGISTRY_ID ?? process.env.NEXT_PUBLIC_DEEPBOOK_REGISTRY_ID;
  const DUSDC_TYPE = process.env.NEXT_PUBLIC_DUSDC_TYPE || process.env.DUSDC_TYPE || "0xe9a73a6f4457f6ecad6260a37a200745a8009e9ee1a235ab91f8d3c030d3a705::dusdc::DUSDC";
  const DEEP_TYPE = process.env.DEEP_TYPE ?? ACTUAL_DEEP_TYPE;
  console.log(`DEEP type (env-resolved): ${DEEP_TYPE}`);

  // --- find existing on-chain markets ---
  const existing = db.prepare("SELECT id, onchain_market_id, deepbook_pool_id, status FROM markets WHERE id LIKE 'wc26-%'").all();
  const existingMap = new Map(existing.map((m) => [m.id, m]));
  console.log(`\nFound ${existing.length} WC markets in DB`);
  console.log(`  ${existing.filter(m => m.onchain_market_id).length} already on-chain`);

  // --- fetch WC schedule ---
  console.log(`\nFetching WC 2026 schedule...`);
  const allMatches = await fetchMatchSchedule();
  console.log(`Schedule: ${allMatches.length} matches`);

  // Filter to matches in the next 7 days
  const now = Date.now();
  const oneWeekAhead = now + 7 * 24 * 60 * 60 * 1000;
  const targets = allMatches
    .filter((m) =>
      (m.kickoffMs > now - 24 * 60 * 60 * 1000 && m.kickoffMs < now) ||
      (m.kickoffMs >= now && m.kickoffMs <= oneWeekAhead)
    )
    .sort((a, b) => a.kickoffMs - b.kickoffMs)
    .slice(0, 8);
  console.log(`Target: ${targets.length} matches in next 7d window`);

  // --- find a DEEP coin of exactly 500M atoms (500 DEEP) ---
  const bigDeep = deepBal.data.find((c) => BigInt(c.balance) >= 500_000_000n);
  if (!bigDeep) {
    console.error("ERROR: no DEEP coin >= 500 DEEP (the first market creates the pool)");
    process.exit(1);
  }
  console.log(`Using DEEP coin ${bigDeep.coinObjectId.slice(0, 18)}... (${Number(bigDeep.balance) / 1e6} DEEP)`);

  // R-UAT-23 fix: hardcoded existing pool. The self-hosted
  // DeepBook registry 0xe14eba90 already has a
  // `Pool<YES<DUSDC>, DUSDC>` from an earlier demo-seed
  // bootstrap (the `0xe497...` demo-* market has
  // `deepbook_pool_id = 0xefb1...`, a real on-chain
  // pool). Calling `create_market` on a YES<DUSDC>
  // registry now aborts with `EPoolAlreadyExists`, so
  // this script always uses `create_market_with_pool`
  // to share the existing pool. The hardcoded id
  // saves a registry query (which the SDK's broken
  // dynamic-field filter can't reliably answer for
  // versioned registry objects).
  const EXISTING_POOL_ID = "0xefb1e58a6337f1f33020f9bdefd07efd00a5b42be4920d0b40b7bdd2a3fe079a";
  let existingPoolId = EXISTING_POOL_ID;
  console.log(`\nR-UAT-23: using existing pool ${existingPoolId.slice(0, 18)}...`);

  // --- detect if a YES<DUSDC> pool already exists in the registry ---
  // The DeepBook registry tracks pools by (Base, Quote) TypeName
  // dynamic fields. The pool id is stored as a key. We can
  // iterate the dynamic fields and find the one with the
  // matching TypeName string ("<YES<DUSDC>>").
  // The full TypeName for YES<DUSDC> is:
  const YES_DUSDC_TYPENAME = `${MARKET_PKG}::prediction_market::YES<${DUSDC_TYPE}>`;
  // R-UAT-23 fix: hardcoded existing pool. The self-hosted
  // DeepBook registry 0xe14eba90 already has a
  // `Pool<YES<DUSDC>, DUSDC>` from an earlier demo-seed
  // bootstrap (the `0xe497...` demo-* market has
  // `deepbook_pool_id = 0xefb1...`, a real on-chain
  // pool). Calling `create_market` on a YES<DUSDC>
  // registry now aborts with `EPoolAlreadyExists`, so
  // this script always uses `create_market_with_pool`
  // to share the existing pool. The hardcoded id
  // saves a registry query (which the SDK's broken
  // dynamic-field filter can't reliably answer for
  // versioned registry objects).
  try {
    const df = await client.getDynamicFields({ parentId: DB_REGISTRY, limit: 50 });
    for (const f of df.data) {
      const n = f.name;
      // The TypeName is serialized as a struct in the dynamic field name
      // Format: { type: "0x...::module::Type<...>", ... }
      if (typeof n === "object" && n.type && n.type.includes("::YES<") && n.type.includes("::DUSDC>")) {
        // Found a YES<DUSDC> pool
        existingPoolId = f.objectId;
        console.log(`\nFound existing YES<DUSDC> pool: ${existingPoolId.slice(0, 18)}...`);
        break;
      }
    }
  } catch (e) {
    console.log(`  (registry query failed, will try create_market: ${e.message?.slice(0, 100)})`);
  }

  // --- create each ---
  let created = 0;
  let skipped = 0;
  let failed = 0;
  for (const m of targets) {
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

    try {
      const tx = new Transaction();
      let attemptLabel = "create_market";
      if (existingPoolId) {
        // R-UAT-23 fix: pool already exists, use the new
        // entry point that reuses it (no DEEP fee required).
        // The on-chain `create_market_with_pool<Q>(coin_registry, pool, ...)`
        // creates a new BalanceManager + YES/NO caps + market
        // for this match, while sharing the existing DeepBook pool.
        attemptLabel = "create_market_with_pool (R-UAT-23)";
        tx.moveCall({
          target: `${MARKET_PKG}::prediction_market::create_market_with_pool`,
          typeArguments: [DUSDC_TYPE],
          arguments: [
            tx.object("0xc"),  // Sui system CoinRegistry
            tx.object(existingPoolId),
            tx.pure.vector("u8", utf8ToBytes(title)),
            tx.pure.vector("u8", utf8ToBytes(resolutionSource)),
            tx.pure.u64(BigInt(expiryMs)),
            tx.pure.u8(3),  // category 3 = "other" (no WC category yet)
          ],
        });
      } else {
        // First market: split 500 DEEP and call create_market
        const [feeCoin] = tx.splitCoins(tx.object(bigDeep.coinObjectId), [tx.pure.u64(500_000_000n)]);
        tx.moveCall({
          target: `${MARKET_PKG}::prediction_market::create_market`,
          typeArguments: [DUSDC_TYPE],
          arguments: [
            tx.object("0xc"),
            tx.object(DB_REGISTRY),
            tx.pure.vector("u8", utf8ToBytes(title)),
            tx.pure.vector("u8", utf8ToBytes(resolutionSource)),
            tx.pure.u64(BigInt(expiryMs)),
            tx.pure.u64(1_000_000n),
            tx.pure.u64(1_000_000n),
            tx.pure.u64(1_000_000n),
            feeCoin,
            tx.pure.u8(3),
          ],
        });
      }
      tx.setSender(agentAddr);
      console.log(`  [${attemptLabel}] ${id}...`);
      const result = await client.signAndExecuteTransaction({ signer: kp, transaction: tx });
      if (!result.digest) {
        throw new Error("No digest returned");
      }
      console.log(`    digest: ${result.digest.slice(0, 18)}...`);
      // Wait for finalization
      await new Promise((r) => setTimeout(r, 5000));
      // Find the new PredictionMarket object
      const txResult = await client.getTransactionBlock({ digest: result.digest, options: { showObjectChanges: true } });
      const newObjects = txResult.objectChanges?.filter((c) => c.type === "created") || [];
      const marketObj = newObjects.find((o) => o.objectType?.includes("PredictionMarket"));
      if (!marketObj) {
        throw new Error("PredictionMarket not in created objects: " + newObjects.map(o => o.objectType).join(", "));
      }
      const onchainId = marketObj.objectId;
      const marketObj2 = await client.getObject({ id: onchainId, options: { showContent: true } });
      const fields = marketObj2?.data?.content?.dataType === "moveObject" ? marketObj2.data.content.fields : null;
      const poolId = fields?.pool_id;
      console.log(`  [OK] ${id} → onchain=${onchainId.slice(0, 18)}… pool=${poolId?.slice(0, 18) ?? "null"}…`);
      db.prepare(`UPDATE markets SET onchain_market_id = ?, deepbook_pool_id = ? WHERE id = ?`).run(onchainId, poolId, id);
      // R-UAT-23: if this was the first market, update existingPoolId
      // so subsequent markets in the same run use the new path.
      if (!existingPoolId && poolId) {
        existingPoolId = poolId;
        console.log(`  (subsequent markets will reuse pool ${poolId.slice(0, 18)}…)`);
      }
      created++;
    } catch (err) {
      console.error(`  [FAIL] ${id}: ${err.message?.slice(0, 300)}`);
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

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
