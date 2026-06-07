import { config as loadEnv } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../../.env") });

import { Transaction } from "@mysten/sui/transactions";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { keypairFromPrivateKey, executeTransaction, listAllCoins } from "@suipredict/sdk";

async function test() {
  const s = keypairFromPrivateKey(process.env.AGENT_PRIVATE_KEY!);
  const addr = s.getPublicKey().toSuiAddress();
  const c = new SuiGrpcClient({ network: "testnet", baseUrl: "https://fullnode.testnet.sui.io:443" });
  const DB = "0x0e99a58323bfe5db564e66ddbe760f7328c694b64174370933ca19d56549691d";
  const REG = "0x3c31f5f56222a57f43c08f4d5c12f91d645fbe6ba5fe048d300c3822b864db7e";
  const DEEP_TYPE = "0x7b86477fb48be71179877784f75c44d260e15e429bce8da658a0ebf7aa48ae7b::deep::DEEP";

  const coins = await listAllCoins(c, addr, DEEP_TYPE);
  const feeCoin = coins.find((x: any) => BigInt(x.balance) === 500_000_000n);
  if (!feeCoin) { console.log("No 500M DEEP coin"); process.exit(1); }
  console.log("Using coin:", feeCoin.objectId);

  const tx = new Transaction();
  tx.moveCall({
    target: DB + "::pool::create_permissionless_pool",
    typeArguments: [DEEP_TYPE, "0xe9a73a6f4457f6ecad6260a37a200745a8009e9ee1a235ab91f8d3c030d3a705::dusdc::DUSDC"],
    arguments: [tx.object(REG), tx.pure.u64(1000000n), tx.pure.u64(1000n), tx.pure.u64(1000n), tx.object(feeCoin.objectId)],
  });
  try {
    const r = await executeTransaction(c, tx, s);
    console.log("DEEP pool created:", r.digest);
  } catch(e) { console.error((e as Error).message.slice(0,400)); }
  process.exit(0);
}
test();
