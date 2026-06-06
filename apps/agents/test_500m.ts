import { config as loadEnv } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../../.env") });

import { Transaction } from "@mysten/sui/transactions";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { 
  keypairFromPrivateKey, 
  DUSDC_TYPE,
  executeTransaction,
  resolveAgentPolicyPackageId,
} from "@suipredict/sdk";

async function main() {
  const signer = keypairFromPrivateKey(process.env.AGENT_PRIVATE_KEY!);
  const client = new SuiGrpcClient({ network: "testnet", baseUrl: "https://fullnode.testnet.sui.io:443" });
  const tx = new Transaction();
  tx.moveCall({
    target: resolveAgentPolicyPackageId() + "::prediction_market::create_market",
    typeArguments: [DUSDC_TYPE],
    arguments: [
      tx.object("0x3c31f5f56222a57f43c08f4d5c12f91d645fbe6ba5fe048d300c3822b864db7e"),
      tx.pure.vector("u8", new TextEncoder().encode("Test 500M DEEP")),
      tx.pure.vector("u8", new TextEncoder().encode("Manual")),
      tx.pure.u64(BigInt(Date.now() + 7*86400000)),
      tx.pure.u64(1000000n), tx.pure.u64(1000000n), tx.pure.u64(1000000n),
      tx.object("0x0fbe243b916af1b6c35149ca6361fa82ffdcc5ea253f81706a6f1f915864d57c"),
      tx.pure.u8(1),
    ],
  });
  try {
    const r = await executeTransaction(client, tx, signer);
    console.log("SUCCESS:", r.digest);
  } catch(e) { 
    console.error( e instanceof Error ? e.message : String(e)); 
  }
  process.exit(0);
}
main();
