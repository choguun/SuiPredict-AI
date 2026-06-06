import { config as loadEnv } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../../.env") });

import { Transaction } from "@mysten/sui/transactions";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { keypairFromPrivateKey, executeTransaction } from "@suipredict/sdk";

async function main() {
  const signer = keypairFromPrivateKey(process.env.AGENT_PRIVATE_KEY!);
  const client = new SuiGrpcClient({ network: "testnet", baseUrl: "https://fullnode.testnet.sui.io:443" });
  
  // Try with a simple coin: 0x2::coin::Coin<0x2::sui::SUI>
  const tx = new Transaction();
  tx.moveCall({
    target: "0x2::coin::create_currency",
    typeArguments: ["0x0000000000000000000000000000000000000000000000000000000000000002::coin::Coin<0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI>"],
    arguments: [],
  });
  try {
    const r = await executeTransaction(client, tx, signer);
    console.log("SUCCESS:", r.digest);
  } catch(e) { 
    console.error(e instanceof Error ? e.message : String(e)); 
  }
  process.exit(0);
}
main();
