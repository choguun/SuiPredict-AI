#!/usr/bin/env node
/**
 * R-WC-3.3 follow-up (Task #60): initialize a v3 `MarketRegistry`
 * on the published v3 agent_policy package. Required because the
 * `MARKET_REGISTRY_ID` env var still points at a registry from the
 * v1 package (`0xb1777f167c…`). The wc-creator's `register_market`
 * step sends `register_market(v1_registry, market_id)` which the
 * v3 module can't accept (the registry struct is package-typed,
 * and the v3 admin != v1 admin), so the call aborts with
 * `ETypeMismatch` / `ENotAdmin`.
 *
 * The v3 contract exposes a permissionless `registry::create_registry`
 * (see `packages/contracts/sources/registry.move:27`) that creates
 * a fresh `MarketRegistry` with `ctx.sender()` as admin. The new
 * registry is independent of any v1 registry — there can be any
 * number of `MarketRegistry` objects, so re-running this is safe
 * (the caller can ignore the second one).
 *
 * Companion migration steps (the script only handles step 1):
 *   1. ✅ run this script → copy the `MarketRegistry` id
 *   2. set `MARKET_REGISTRY_ID=<that-id>` on Railway + Vercel
 *      (`NEXT_PUBLIC_MARKET_REGISTRY_ID` does not exist — the
 *      SDK reads the server-side var only, so Vercel doesn't
 *      need a public variant for this migration)
 *   3. the wc-creator's best-effort `register_market` step will
 *      stop emitting `AGENT_POLICY_PACKAGE_ID drift` warnings on
 *      the next tick; the global `markets` table now fills in
 *      with the on-chain market count
 *   4. AgentPolicy and StreakRegistry are separate shared objects
 *      and need their own migration scripts (not in scope for
 *      this commit — see Task #60 follow-ups in CLAUDE.md / the
 *      audit trail)
 */
import "dotenv/config";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import {
  buildCreateRegistryTx,
  executeTransaction,
  keypairFromPrivateKey,
  PREDICT_MARKET_PACKAGE_ID,
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

console.log("--- R-WC-3.3 v3 MarketRegistry init ---");
console.log(`package:  ${PREDICT_MARKET_PACKAGE_ID}`);
console.log(`caller:   ${addr}`);

const tx = buildCreateRegistryTx();

try {
  const result = await executeTransaction(client, tx, keypair);
  console.log(`\n✅ v3 MarketRegistry created`);
  console.log(`   digest: ${result.digest}`);
  console.log(`   status: ${result.effects?.status?.status ?? "unknown"}`);
  if (result.effects?.created) {
    console.log("   created objects:");
    for (const o of result.effects.created) {
      console.log(`     - ${o.objectId} (${o.objectType ?? "?"})`);
    }
  }
  console.log(
    "\nNEXT STEP: copy the MarketRegistry id above and set it on Railway as",
    "\n  MARKET_REGISTRY_ID=<that-id>",
    "\n",
    "\nThe SDK reads MARKET_REGISTRY_ID server-side only, so no",
    "\nNEXT_PUBLIC_* variant is needed. Restart the agents service",
    "\nafter updating so the new id is picked up (or wait for the",
    "\nnext position-indexer tick — it reads the env every restart).",
  );
} catch (e) {
  console.error("\n❌ v3 MarketRegistry init failed:", e instanceof Error ? e.message : e);
  process.exit(1);
}