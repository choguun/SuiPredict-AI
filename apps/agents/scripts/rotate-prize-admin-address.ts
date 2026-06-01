#!/usr/bin/env tsx
/**
 * Manual rotation helper for the PrizeAdmin *address* (the hot wallet
 * that signs claim_prize payloads). Use this when the backend moves
 * from one signer to another. To rotate the ed25519 *pubkey* without
 * changing the address, use `rotate-prize-pubkey.ts` instead.
 *
 *   $ pnpm --filter @suipredict/agents tsx scripts/rotate-prize-admin-address.ts
 *
 * Reads PRIZE_ADMIN_ID, AGENT_PRIVATE_KEY (the current admin) and
 * PRIZE_NEW_ADMIN_ADDRESS (the new admin's Sui address) from env.
 *
 * After this completes:
 *   1. Update AGENT_PRIVATE_KEY in .env to the new admin's key
 *   2. The new admin's public key must be set on-chain via
 *      `rotate-prize-pubkey.ts` if it changed as well
 *   3. Restart apps/agents so /prize/signature uses the new key
 *
 * The on-chain `prize_pool::claim_prize` only checks the address field
 * of `PrizeAdmin`, not the stored pubkey — the pubkey is what verifies
 * the ed25519 signature. So if the new admin uses the same key, this
 * is sufficient. Otherwise run rotate-prize-pubkey.ts after.
 */
import "dotenv/config";
import {
  buildRotateAdminTx,
  createClient,
  executeTransaction,
  keypairFromPrivateKey,
} from "@suipredict/sdk";

async function main() {
  const adminCapId = process.env.PRIZE_ADMIN_ID ?? "";
  const currentPk = process.env.AGENT_PRIVATE_KEY ?? "";
  const newAdmin = process.env.PRIZE_NEW_ADMIN_ADDRESS ?? "";
  if (!adminCapId || !currentPk || !newAdmin) {
    console.error(
      "Set PRIZE_ADMIN_ID, AGENT_PRIVATE_KEY, and PRIZE_NEW_ADMIN_ADDRESS in .env before running.",
    );
    process.exit(1);
  }

  const client = createClient();
  const signer = keypairFromPrivateKey(currentPk);
  const tx = buildRotateAdminTx(adminCapId, newAdmin);
  const r = await executeTransaction(client, tx, signer);
  console.log(`rotate_admin tx digest: ${r.digest}`);
  console.log(`PrizeAdmin.admin is now: ${newAdmin}`);
  console.log("\nNext steps:");
  console.log("  1. Update AGENT_PRIVATE_KEY in .env to the new admin's signer key");
  console.log("  2. If the new admin uses a different ed25519 key, also run");
  console.log("     scripts/rotate-prize-pubkey.ts to update the on-chain pubkey");
  console.log("  3. Restart the agents service so /prize/signature uses the new key");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
