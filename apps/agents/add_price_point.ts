import { config as loadEnv } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../../.env") });

import { Transaction } from "@mysten/sui/transactions";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { keypairFromPrivateKey, executeTransaction } from "@suipredict/sdk";

async function test() {
  const s = keypairFromPrivateKey(process.env.AGENT_PRIVATE_KEY!);
  const c = new SuiGrpcClient({ network: "testnet", baseUrl: "https://fullnode.testnet.sui.io:443" });
  const DB = "0x4f179980d20c9bcc9347494d65d21fda8f54093971d476be8e5230f4aa6ddf36";
  const YES_POOL = "0x93a00df8200f5383b6d348b057346a31e6c15b95cda8001c3fc465f76bc98e6f";
  const BASE = "0xd93cd206be97e6f801d378baa95a31afb54a2fd08ce3e3e9d2cb51e62fa11555::prediction_market::YES<0xe9a73a6f4457f6ecad6260a37a200745a8009e9ee1a235ab91f8d3c030d3a705::dusdc::DUSDC>";
  const QUOTE = "0xe9a73a6f4457f6ecad6260a37a200745a8009e9ee1a235ab91f8d3c030d3a705::dusdc::DUSDC";
  const DEEP = "0x7b86477fb48be71179877784f75c44d260e15e429bce8da658a0ebf7aa48ae7b::deep::DEEP";
  
  // Get the latest DEEP/DUSDC pool from the create_deep_pool script - let me find it from the tx effects
  console.log("Adding DEEP price point to YES pool...");
  
  const DEEP_POOL = "0xd8db41bfea9edadbcaed684ec6b611a1b5562c71e9651b2718522346d85614b9";
  
  console.log("Adding DEEP price point to YES pool...");
  
  const tx = new Transaction();
  tx.moveCall({
    target: DB + "::pool::add_deep_price_point",
    typeArguments: [BASE, QUOTE, DEEP, QUOTE],
    arguments: [tx.object(YES_POOL), tx.object(DEEP_POOL), tx.object.clock()],
  });
  try { 
    const r = await executeTransaction(c, tx, s); 
    console.log("OK:", r.digest); 
  } catch(e) { 
    console.error("FAIL:", (e instanceof Error ? e.message : String(e)).slice(0,400)); 
  }
  process.exit(0);
}
test();
