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
  const addr = signer.getPublicKey().toSuiAddress();
  const DB = "0xc93ae840671495202260c7afb93c820bf11c081b884b660106399208871dec5a";

  const tx = new Transaction();
  const bm = tx.moveCall({
    target: `${DB}::balance_manager::new_with_custom_owner`,
    arguments: [tx.pure.address(addr)],
  });
  tx.moveCall({
    target: `0x2::transfer::public_share_object`,
    typeArguments: [`${DB}::balance_manager::BalanceManager`],
    arguments: [bm],
  });
  try {
    const r = await executeTransaction(client, tx, signer);
    console.log("BM created + shared:", r.digest);
    // Find the BM object ID from effects
    const effects = await client.getTransaction({ digest: r.digest, include: { effects: true, objectTypes: true } });
    if (effects.$kind === "Transaction") {
      for (const co of effects.Transaction.effects.changedObjects) {
        if (co.idOperation === "Created" && co.outputOwner?.$kind === "Shared") {
          console.log("BM shared object:", co.objectId);
          console.log("Set BALANCE_MANAGER_ID=", co.objectId);
        }
      }
    }
  } catch(e) {
    console.error(e instanceof Error ? e.message : String(e));
  }
  process.exit(0);
}
main();
