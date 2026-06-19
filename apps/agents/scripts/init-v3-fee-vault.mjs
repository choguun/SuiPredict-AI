#!/usr/bin/env node
/**
 * R-WC-3.3: initialize a v3 `FeeVault<DUSDC>` on the published v3
 * prediction_market package. Required because `mint_shares` (called
 * by the wc-creator for initial liquidity seeding) borrows a
 * `&mut FeeVault<Q>` — the v1 `FEE_VAULT_ID` env var points at a
 * FeeVault from the old package and the v3 module rejects it with
 * `arg_idx: 2, kind: TypeMismatch`.
 *
 * The v3 contract exposes a permissionless `init_fee_vault_fallback`
 * (see `prediction_market.move:399`) that creates a fresh
 * `FeeVault<DUSDC>` with the caller as admin. It refuses to create
 * a second vault per package (the type-system identity is unique),
 * so this is safe to re-run.
 */
import "dotenv/config";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import {
  buildInitFeeVaultFallbackTx,
  executeTransaction,
  keypairFromPrivateKey,
  PREDICT_MARKET_PACKAGE_ID,
  SHARED_TREASURY_HOLDER_ID,
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

console.log("--- R-WC-3.3 v3 FeeVault init ---");
console.log(`package:  ${PREDICT_MARKET_PACKAGE_ID}`);
console.log(`caller:   ${addr}`);
console.log(`shared_caps: ${SHARED_TREASURY_HOLDER_ID}`);

const tx = buildInitFeeVaultFallbackTx();

try {
  const result = await executeTransaction(client, tx, keypair);
  console.log(`\n✅ v3 FeeVault<DUSDC> created`);
  console.log(`   digest: ${result.digest}`);
  console.log(`   status: ${result.effects?.status?.status ?? "unknown"}`);
  if (result.effects?.created) {
    console.log("   created objects:");
    for (const o of result.effects.created) {
      console.log(`     - ${o.objectId} (${o.objectType ?? "?"})`);
    }
  }
  console.log(
    "\nNEXT STEP: copy the FeeVault<DUSDC> id above and set it on Railway as",
    "\n  FEE_VAULT_ID=<that-id>",
    "\n  NEXT_PUBLIC_FEE_VAULT_ID=<that-id>",
    "\n  NEXT_PUBLIC_FEE_VAULT_ID_V3=<that-id>",
  );
} catch (e) {
  console.error("\n❌ v3 FeeVault init failed:", e instanceof Error ? e.message : e);
  process.exit(1);
}
