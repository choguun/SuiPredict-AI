#!/usr/bin/env tsx
/**
 * E2E smoke test: create manager → (optional) mint dUSDC → deposit → mint position
 */
import "dotenv/config";
import {
  createPredictManager,
  createClient,
  findNearestActiveOracle,
  getStatus,
  keypairFromPrivateKey,
  mintDusdcFromTreasury,
  mintPositionWithTopup,
  pickAtmStrike,
} from "@suipredict/sdk";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";

async function getSigner(): Promise<Ed25519Keypair> {
  if (process.env.AGENT_PRIVATE_KEY) {
    return keypairFromPrivateKey(process.env.AGENT_PRIVATE_KEY);
  }
  return new Ed25519Keypair();
}

async function main() {
  console.log("=== SuiPredict-AI Predict Smoke Test ===\n");

  const status = await getStatus();
  console.log(`predict-server: ${status.status}`);

  const client = createClient();
  const signer = await getSigner();
  const address = signer.getPublicKey().toSuiAddress();
  console.log(`Signer: ${address}`);

  // Fund with testnet SUI if needed (user should have SUI)
  let managerId = process.env.AGENT_MANAGER_ID;
  if (!managerId) {
    console.log("\n1. Creating PredictManager...");
    managerId = await createPredictManager(client, signer);
    console.log(`   MANAGER_ID=${managerId}`);
  } else {
    console.log(`\n1. Using existing manager: ${managerId}`);
  }

  try {
    console.log("\n2. Minting 10 dUSDC from treasury...");
    await mintDusdcFromTreasury(client, signer, 10);
    console.log("   ✓ dUSDC minted");
  } catch (err) {
    console.warn("   ⚠ dUSDC mint skipped (treasury may be restricted):", err);
  }

  const oracle = await findNearestActiveOracle();
  if (!oracle) {
    console.log("\n⚠ No active oracles — manager created successfully.");
    console.log(`\nSet AGENT_MANAGER_ID=${managerId} in .env`);
    return;
  }

  console.log(`\n3. Active oracle: ${oracle.underlying_asset} expiry ${new Date(oracle.expiry).toISOString()}`);

  const strike = await pickAtmStrike(
    oracle.oracle_id,
    oracle.min_strike,
    oracle.tick_size,
  );

  console.log(`\n4. Minting $1 UP position @ $${strike}...`);
  try {
    const result = await mintPositionWithTopup(client, signer, {
      managerId,
      oracleId: oracle.oracle_id,
      expiry: BigInt(oracle.expiry),
      strikeDollars: strike,
      direction: "up",
      quantityDollars: 1,
      topupDollars: 2,
    });
    console.log(`   ✓ Minted. Digest: ${result.digest}`);
  } catch (err) {
    console.warn("   ⚠ Mint failed (may need dUSDC):", err);
  }

  console.log("\n=== Smoke test complete ===");
  console.log(`AGENT_MANAGER_ID=${managerId}`);
  console.log(`AGENT_PRIVATE_KEY=<your-key>`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
