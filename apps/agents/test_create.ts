import { config as loadEnv } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../../.env") });

import { Transaction } from "@mysten/sui/transactions";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { 
  keypairFromPrivateKey, 
  DEEPBOOK_REGISTRY_ID, 
  DUSDC_TYPE, 
  DEEP_TYPE, 
  POOL_CREATION_FEE_DEEP,
  listAllCoins,
  executeTransaction,
  resolveAgentPolicyPackageId,
} from "@suipredict/sdk";

async function main() {
  const pk = process.env.AGENT_PRIVATE_KEY!;
  const signer = keypairFromPrivateKey(pk);
  const addr = signer.getPublicKey().toSuiAddress();
  console.log("Signer:", addr);

  const client = new SuiGrpcClient({
    network: "testnet",
    baseUrl: "https://fullnode.testnet.sui.io:443",
  });

  // Find a DEEP coin
  const coins = await listAllCoins(client, addr, DEEP_TYPE);
  console.log("DEEP type:", DEEP_TYPE);
  console.log("Found", coins.length, "coins");
  const deepCoin = coins.find((c: any) => BigInt(c.balance) >= POOL_CREATION_FEE_DEEP);
  if (!deepCoin) {
    console.log("No DEEP coin >= 500M. Listing all:");
    for (const c of coins) console.log(`  ${c.objectId}: ${c.balance}`);
    return;
  }
  console.log("Using DEEP coin:", deepCoin.objectId, "balance:", deepCoin.balance);

  const tx = new Transaction();
  tx.moveCall({
    target: `${resolveAgentPolicyPackageId()}::prediction_market::create_market`,
    typeArguments: [DUSDC_TYPE],
    arguments: [
      tx.object(DEEPBOOK_REGISTRY_ID),
      tx.pure.vector("u8", new TextEncoder().encode("Test Market via CLI")),
      tx.pure.vector("u8", new TextEncoder().encode("Manual test")),
      tx.pure.u64(BigInt(Date.now() + 7 * 86400000)),
      tx.pure.u64(1_000_000n),
      tx.pure.u64(1_000_000n),
      tx.pure.u64(1_000_000n),
      tx.object(deepCoin.objectId),
      tx.pure.u8(1),
    ],
  });

  try {
    const result = await executeTransaction(client, tx, signer);
    console.log("SUCCESS! Digest:", result.digest);
  } catch (err) {
    console.error("FAILED:", err instanceof Error ? err.message : String(err));
  }
  process.exit(0);
}

main();
