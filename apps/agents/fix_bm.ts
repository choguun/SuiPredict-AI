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
  const DB = "0xc93ae840671495202260c7afb93c820bf11c081b884b660106399208871dec5a";
  const REG = "0xe14eba90fc8cc14a2eac1199b207d4e664931f8196f612b5aacf0c4a7f7d7a6f";
  const ADMIN = "0x279d04fc77303f2aebfa56045f868976414b61ff7d633eeaa7341fb1e37ba3b2";
  const PKG = "0x23b78cabb824ccaf9a24f3fe335ae144b3fa3d21a53955ca4e3f01544a0c2d52";
  const YES_POOL = "0xefb1e58a6337f1f33020f9bdefd07efd00a5b42be4920d0b40b7bdd2a3fe079a";
  const DEEP = "0x7b86477fb48be71179877784f75c44d260e15e429bce8da658a0ebf7aa48ae7b::deep::DEEP";
  const QUOTE = "0xe9a73a6f4457f6ecad6260a37a200745a8009e9ee1a235ab91f8d3c030d3a705::dusdc::DUSDC";
  const BASE = PKG + "::prediction_market::YES<" + QUOTE + ">";

  // Step 1: Authorize app in DeepBook registry
  console.log("1. Authorizing app...");
  const tx1 = new Transaction();
  tx1.moveCall({
    target: DB + "::registry::authorize_app",
    typeArguments: [PKG + "::prediction_market::YES<" + QUOTE + ">"],
    arguments: [tx1.object(REG), tx1.object(ADMIN)],
  });
  try { const r = await executeTransaction(c, tx1, s); console.log("   OK:", r.digest); }
  catch(e) { console.error("   FAIL:", (e as Error).message.slice(0,200)); }

  // Step 2: Create BM with caps
  console.log("2. Creating BM with caps...");
  const tx2 = new Transaction();
  const bmResult = tx2.moveCall({
    target: DB + "::balance_manager::new_with_custom_owner_caps_v2",
    typeArguments: [PKG + "::prediction_market::PredictionMarket"],
    arguments: [tx2.object(REG), tx2.pure.address(addr)],
  });
  // Share BM, transfer caps to creator
  tx2.moveCall({ target: "0x2::transfer::public_share_object", typeArguments: [DB + "::balance_manager::BalanceManager"], arguments: [bmResult] });
  try { const r = await executeTransaction(c, tx2, s); console.log("   OK:", r.digest); }
  catch(e) { console.error("   FAIL:", (e as Error).message.slice(0,200)); }

  process.exit(0);
}
test();
