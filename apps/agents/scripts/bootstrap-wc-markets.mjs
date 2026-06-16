#!/usr/bin/env node
/**
 * scripts/bootstrap-wc-markets.mjs
 * ============================================================================
 * Bootstrap on-chain World Cup 2026 prediction markets.
 *
 * For each WC 2026 match in the next 7 days, this script:
 *   1. Reads the schedule from the world-cup-fetcher.
 *   2. Splits 500 DEEP off the agent's largest DEEP coin.
 *   3. Builds a single PTB with the `create_market` call (which
 *      mints the on-chain `PredictionMarket`, the DeepBook pool,
 *      the BalanceManager, the YES/NO TreasuryCaps, and emits
 *      `MarketCreatedEvent`).
 *   4. Submits, extracts the new market id and the
 *      `deepbook_pool_id` field.
 *   5. Writes both back to the SQLite mirror so the web UI
 *      shows the on-chain state.
 *   6. Idempotent: re-running skips markets with non-null
 *      `onchain_market_id`.
 *
 * Cost: ~0.01-0.02 SUI + 500 DEEP per market. The agent has
 * 2.56 SUI + 100M DEEP, so 47 markets = ~1 SUI + 23,500 DEEP.
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

function utf8ToBytes(str) {
  return new TextEncoder().encode(str);
}

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
  // R62 fix: the @mysten/sui v2 gRPC client returns
  // `totalBalance` (a `string`), not the legacy
  // `balance.balance` nested object. The old shape
  // was `bal.balance.balance` (V1 JSON-RPC); the v2
  // gRPC client renamed it. Reading the legacy field
  // produces undefined → NaN → falls through to the
  // "need 1 SUI" guard. The fix: read totalBalance
  // with a fallback to the v1 nested field.
  const suiBal = await client.getBalance({ owner: agentAddr });
  const suiMist = BigInt(suiBal.totalBalance ?? suiBal.balance?.balance ?? "0");
  console.log(`SUI balance: ${Number(suiMist) / 1e9} SUI`);
  // R62 fix: the @mysten/sui v2 gRPC client's
  // `getAllCoins({ coinType })` is BROKEN — it
  // ignores the `coinType` filter and returns
  // every coin the agent owns, including SUI gas
  // coins and DUSDC. The pre-fix script then did
  // `find(c => BigInt(c.balance) >= 500M)` and
  // matched the 3.86 SUI gas coin (3.86B MIST >
  // 500M), passed it to `create_market` as the DEEP
  // coin, and the on-chain `deep_coin: Coin<DEEP>`
  // argument check rejected it with
  // `CommandArgumentError { arg_idx: 8, kind: TypeMismatch }`.
  // The fix: fetch ALL coins without a filter, then
  // client-side filter to the DEEP type the on-chain
  // `create_market` was compiled against. The
  // self-hosted DEEP at `0x7b86477f...` is the one
  // (the Published.toml confirms
  // `published-at = 0x7b86477f...`).
  const ACTUAL_DEEP_TYPE = "0x7b86477fb48be71179877784f75c44d260e15e429bce8da658a0ebf7aa48ae7b::deep::DEEP";
  const allCoins = await client.getAllCoins({ owner: agentAddr, limit: 100 });
  const deepBal = { data: allCoins.data.filter(c => c.coinType === ACTUAL_DEEP_TYPE) };
  console.log(`DEEP coins (type ${ACTUAL_DEEP_TYPE.slice(0,18)}...): ${deepBal.data.length}`);
  let deepTotal = 0n;
  for (const c of deepBal.data) deepTotal += BigInt(c.balance);
  console.log(`DEEP balance: ${Number(deepTotal) / 1e6} DEEP (${deepBal.data.length} coins)`);

  if (suiMist < 1_000_000_000n) {
    console.error("ERROR: need at least 1 SUI for gas");
    process.exit(1);
  }
  if (deepTotal < 500_000_000n * 10n) {
    console.error("ERROR: need at least 5000 DEEP");
    process.exit(1);
  }

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

  // --- find a DEEP coin of at least 500M atoms (500 DEEP) ---
  const bigDeep = deepBal.data.find((c) => BigInt(c.balance) >= 500_000_000n);
  if (!bigDeep) {
    console.error("ERROR: no DEEP coin >= 500");
    process.exit(1);
  }
  console.log(`Using DEEP coin ${bigDeep.coinObjectId.slice(0, 18)}... (${Number(bigDeep.balance) / 1e6} DEEP)`);

  // --- env config ---
  // --- env config ---
  const MARKET_PKG = resolveMarketPackageId();
  const DB_REGISTRY = process.env.DEEPBOOK_REGISTRY_ID ?? process.env.NEXT_PUBLIC_DEEPBOOK_REGISTRY_ID;
  const DUSDC_TYPE = process.env.NEXT_PUBLIC_DUSDC_TYPE || process.env.DUSDC_TYPE || "0xe9a73a6f4457f6ecad6260a37a200745a8009e9ee1a235ab91f8d3c030d3a705::dusdc::DUSDC";

  // R62 fix: read the DEEP coin type from the agent's
  // actual wallet, not from the SDK's hardcoded default
  // (`0x7b86477f...::deep::DEEP`). The agent's DEEP comes
  // from a different DeepBook package (the bootstrapping
  // process minted DEEP at `0xef95963...::deep::DEEP`),
  // and using the wrong type produces
  // `CommandArgumentError { arg_idx: 8, kind: TypeMismatch }`
  // on every create_market PTB. The first DEEP coin
  // carries the right type; fall back to the SDK default
  // if the agent has no DEEP at all (the pre-flight
  // check below catches that case).
  // R62 fix: hardcode the DEEP type from the
  // env-resolved value. The previous "use the first
  // wallet coin's type" override grabbed the SUI gas
  // coin (always at index 0) which isn't DEEP, so the
  // override fell through to the SDK default. The
  // ACTUAL_DEEP_TYPE is the self-hosted DEEP type
  // matching the DeepBook registry at
  // 0xe14eba90...; the env now also sets
  // DEEP_TYPE=... so the SDK import resolves to the
  // same value (and the typeArguments below use it).
  const DEEP_TYPE = process.env.DEEP_TYPE ?? ACTUAL_DEEP_TYPE;
  console.log(`DEEP type (env-resolved): ${DEEP_TYPE}`);

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
      // Build the PTB inline (avoids Transaction-merging complexity)
      const tx = new Transaction();
      // Split 500 DEEP off the existing coin
      const [feeCoin] = tx.splitCoins(tx.object(bigDeep.coinObjectId), [tx.pure.u64(500_000_000n)]);
      // Call create_market<Q>(coin_registry, deepbook_registry, title, resolution_source, expiry_ms, tick_size, lot_size, min_size, deep_coin, category)
      tx.moveCall({
        target: `${MARKET_PKG}::prediction_market::create_market`,
        typeArguments: [DUSDC_TYPE],
        arguments: [
          tx.object("0xc"),  // Sui system CoinRegistry
          tx.object(DB_REGISTRY),
          tx.pure.vector("u8", utf8ToBytes(title)),
          tx.pure.vector("u8", utf8ToBytes(resolutionSource)),
          tx.pure.u64(BigInt(expiryMs)),
          tx.pure.u64(1_000_000n),  // tick_size
          tx.pure.u64(1_000_000n),  // lot_size
          tx.pure.u64(1_000_000n),  // min_size
          feeCoin,  // the split DEEP coin
          tx.pure.u8(3),  // category 3 = "other" (no WC category yet)
        ],
      });
      tx.setSender(agentAddr);
      console.log(`  [CREATE] ${id}...`);
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
      // Get the pool_id from the market's fields
      const marketObj2 = await client.getObject({ id: onchainId, options: { showContent: true } });
      const fields = marketObj2?.data?.content?.dataType === "moveObject" ? marketObj2.data.content.fields : null;
      const poolId = fields?.pool_id;
      console.log(`  [OK] ${id} → onchain=${onchainId.slice(0, 18)}… pool=${poolId?.slice(0, 18) ?? "null"}…`);
      // Update SQLite
      db.prepare(`UPDATE markets SET onchain_market_id = ?, deepbook_pool_id = ? WHERE id = ?`).run(onchainId, poolId, id);
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
