#!/usr/bin/env tsx
/**
 * Manual key-rotation helper for the PrizePool admin pubkey.
 *
 *   $ pnpm --filter @suipredict/agents tsx scripts/rotate-prize-admin.ts
 *
 * Reads PRIZE_POOL_ID and PRIZE_ADMIN_ID from env. Generates a fresh
 * ed25519 keypair (or reads PRIZE_NEW_ADMIN_PRIVATE_KEY from env),
 * then submits `prize_pool::rotate_pubkey` with the new pubkey.
 *
 * After this script prints the new secret key, copy it to:
 *   - .env as PRIZE_ADMIN_PRIVATE_KEY
 *   - .env as PRIZE_ADMIN_PUBKEY_B64 (already printed in b64 form)
 *
 * Old claims already signed by the previous admin will fail
 * verification, so coordinate the rotation with downtime or staged
 * re-issuance.
 */
import "dotenv/config";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import {
  buildRotatePubkeyTx,
  createClient,
  executeTransaction,
  keypairFromPrivateKey,
} from "@suipredict/sdk";

async function main() {
  const poolId = process.env.PRIZE_POOL_ID ?? "";
  const adminCapId = process.env.PRIZE_ADMIN_ID ?? "";
  const currentPk = process.env.AGENT_PRIVATE_KEY ?? "";
  if (!poolId || !adminCapId || !currentPk) {
    console.error(
      "Set PRIZE_POOL_ID, PRIZE_ADMIN_ID, and AGENT_PRIVATE_KEY in .env before running.",
    );
    process.exit(1);
  }

  const newKey = process.env.PRIZE_NEW_ADMIN_PRIVATE_KEY
    ? Ed25519Keypair.fromSecretKey(process.env.PRIZE_NEW_ADMIN_PRIVATE_KEY)
    : new Ed25519Keypair();
  const newPubkey = newKey.getPublicKey().toSuiBytes();
  console.log(
    `New admin pubkey (b64): ${Buffer.from(newPubkey).toString("base64")}`,
  );
  console.log(
    `New admin secret key: ${Buffer.from(newKey.getSecretKey()).toString("base64")}`,
  );

  const client = createClient();
  const signer = keypairFromPrivateKey(currentPk);
  const tx = buildRotatePubkeyTx(adminCapId, newPubkey);
  const r = await executeTransaction(client, tx, signer);
  console.log(`rotate_pubkey tx digest: ${r.digest}`);
  console.log("\nNext steps:");
  console.log("  1. Update PRIZE_ADMIN_PUBKEY_B64 in .env");
  console.log("  2. Update PRIZE_ADMIN_PRIVATE_KEY in .env (secret)");
  console.log("  3. Restart the agents service so /prize/signature uses the new key");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
