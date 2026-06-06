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
  
  // Try just create_currency<YES<DUSDC>> directly
  const pkg = "0xe35d0a8f7a85de87b4b1498eaf80fdc98aac99b717f8e3ed419c7df896db3304";
  const typeArg = `${pkg}::prediction_market::YES<0xe9a73a6f4457f6ecad6260a37a200745a8009e9ee1a235ab91f8d3c030d3a705::dusdc::DUSDC>`;
  const tx = new Transaction();
  // Witness is the struct itself: YES<DUSDC> {}
  const witness = tx.moveCall({
    target: `${pkg}::prediction_market::create_yes_witness`,
    typeArguments: ["0xe9a73a6f4457f6ecad6260a37a200745a8009e9ee1a235ab91f8d3c030d3a705::dusdc::DUSDC"],
    arguments: [],
  });
  tx.moveCall({
    target: "0x2::coin::create_currency",
    typeArguments: [typeArg],
    arguments: [
      witness,
      tx.pure.u8(6),  // decimals
      tx.pure.vector("u8", new TextEncoder().encode("YES")),
      tx.pure.vector("u8", new TextEncoder().encode("Yes Token")),
      tx.pure.vector("u8", new TextEncoder().encode("Test")),
      tx.pure.option("string", null),
    ],
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
