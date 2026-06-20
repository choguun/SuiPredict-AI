#!/usr/bin/env node
/**
 * R-WC-3 v3 follow-up: initialize a v3 `SharedTreasuryHolder<DUSDC>`
 * on the published v3 prediction_market package. The bootstrap
 * (`bootstrap-gamification.ts`) created the FeeVault and MarketRegistry
 * but missed the one-shot `init_yes_no_currencies` call that creates
 * the shared caps holder. Without it, every `create_market` / `create_market_with_pool`
 * PTB aborts with `arg_idx: 0, kind: TypeMismatch` because the SDK is
 * passing `SHARED_TREASURY_HOLDER_ID` (= FeeVault id) where the contract
 * expects a `SharedTreasuryHolder<Q>` object.
 *
 * The contract exposes `init_yes_no_currencies<Q>(admin_cap,
 * coin_registry, ctx)` — admin-gated. We locate the
 * `ProtocolAdminCap` for the current `PREDICT_MARKET_PACKAGE_ID`,
 * pass Sui's well-known CoinRegistry (`0xc`), and the resulting
 * SharedTreasuryHolder id is what `SHARED_TREASURY_HOLDER_ID`
 * should point at.
 *
 * The CoinRegistry registration is a one-shot per (package, `YES<Q>`)
 * tuple — re-running the script after success aborts with
 * `ECurrencyAlreadyExists`. Treat that as success: the holder from
 * the previous run is still on-chain and `SHARED_TREASURY_HOLDER_ID`
 * just needs to be re-pointed at it.
 */
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { Transaction } from "@mysten/sui/transactions";
import {
  executeTransaction,
  keypairFromPrivateKey,
  PREDICT_MARKET_PACKAGE_ID,
  DUSDC_TYPE,
} from "@suipredict/sdk";

const pk = process.env.AGENT_PRIVATE_KEY;
if (!pk) {
  console.error("AGENT_PRIVATE_KEY required");
  process.exit(1);
}
const keypair = keypairFromPrivateKey(pk);
const addr = keypair.getPublicKey().toSuiAddress();

const RPC = process.env.SUI_RPC ?? "https://fullnode.testnet.sui.io:443";
const client = new SuiGrpcClient({ network: "testnet", baseUrl: RPC });

console.log("--- R-WC-3 v3 SharedTreasuryHolder init ---");
console.log(`package:   ${PREDICT_MARKET_PACKAGE_ID}`);
console.log(`caller:    ${addr}`);
console.log(`coin reg:  0xc (system)`);

// Locate the ProtocolAdminCap for the CURRENT package.
let cursor = null;
const all = [];
do {
  const r = await client.listOwnedObjects({ owner: addr, limit: 50, cursor });
  all.push(...r.objects);
  cursor = r.cursor ?? null;
} while (cursor);
const adminCap = all.find((o) =>
  o.type?.includes(
    `${PREDICT_MARKET_PACKAGE_ID}::prediction_market::ProtocolAdminCap`,
  ),
);
if (!adminCap) {
  console.error(
    `No ProtocolAdminCap found in ${addr} for package ${PREDICT_MARKET_PACKAGE_ID}`,
  );
  process.exit(1);
}
console.log(`admin cap: ${adminCap.objectId}`);

const tx = new Transaction();
tx.moveCall({
  target: `${PREDICT_MARKET_PACKAGE_ID}::prediction_market::init_yes_no_currencies`,
  typeArguments: [DUSDC_TYPE],
  arguments: [
    tx.object(adminCap.objectId),
    tx.object("0xc"), // Sui system CoinRegistry
  ],
});

try {
  const result = await executeTransaction(client, () => tx, keypair);
  console.log(`\n✅ v3 SharedTreasuryHolder<DUSDC> created`);
  console.log(`   digest: ${result.digest}`);
  console.log(`   status: ${result.effects?.status?.status ?? "unknown"}`);
  if (result.effects?.created) {
    console.log("   created objects:");
    for (const o of result.effects.created) {
      console.log(`     - ${o.objectId} (${o.objectType ?? "?"})`);
    }
    const holder = result.effects.created.find((o) =>
      (o.objectType ?? "").includes("SharedTreasuryHolder"),
    );
    if (holder) {
      console.log("\nNEXT STEP: copy the SharedTreasuryHolder id above and set it on Railway + Vercel as");
      console.log(`  SHARED_TREASURY_HOLDER_ID=${holder.objectId}`);
      console.log(`  NEXT_PUBLIC_SHARED_TREASURY_HOLDER_ID=${holder.objectId}`);
    }
  }
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`\n❌ v3 SharedTreasuryHolder init failed: ${msg}`);
  if (/ECurrencyAlreadyExists|already exists/i.test(msg)) {
    console.error(
      "\nThe SharedTreasuryHolder<DUSDC> for this package already exists. " +
        "Look up the SharedTreasuryHolder via `sui client object <id>` — the SDK's " +
        "SHARED_TREASURY_HOLDER_ID likely points at a stale FeeVault id, not " +
        "the actual holder.",
    );
  }
  process.exit(1);
}