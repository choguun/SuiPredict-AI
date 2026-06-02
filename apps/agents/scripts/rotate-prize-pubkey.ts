#!/usr/bin/env tsx
/**
 * Manual key-rotation helper for the PrizePool admin pubkey (the
 * ed25519 public key used to verify claim_prize signatures). To
 * rotate the *address* (hot-wallet move) instead, use
 * `rotate-prize-admin-address.ts`.
 *
 *   $ pnpm --filter @suipredict/agents tsx scripts/rotate-prize-pubkey.ts
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
  // `toRawBytes()` returns the 32 raw ed25519 public-key bytes — the
  // form the on-chain `ed25519::ed25519_verify` expects. The previous
  // `toSuiBytes()` call returned 33 bytes (1 flag byte + 32 raw) and
  // was incorrectly used here, which would have caused every
  // `claim_prize` signature to fail verification. The bootstrap path
  // (`resume-bootstrap.ts:264`) already uses the correct form.
  const newPubkey = Array.from(newKey.getPublicKey().toRawBytes());
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
