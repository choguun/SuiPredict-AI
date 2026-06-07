import { config as loadEnv } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../../.env") });

import { Transaction } from "@mysten/sui/transactions";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { keypairFromPrivateKey, executeTransaction, listAllCoins } from "@suipredict/sdk";

async function t() {
  const s = keypairFromPrivateKey(process.env.AGENT_PRIVATE_KEY!);
  const addr = s.getPublicKey().toSuiAddress();
  const c = new SuiGrpcClient({ network: "testnet", baseUrl: "https://fullnode.testnet.sui.io:443" });
  const DB = "0xc93ae840671495202260c7afb93c820bf11c081b884b660106399208871dec5a";
  const YES_POOL = "0xefb1e58a6337f1f33020f9bdefd07efd00a5b42be4920d0b40b7bdd2a3fe079a";
  const BM = "0x9128db447a76b4311ea0738159451cacb93ffc17cd19c7d59f852ca406720524";
  const BASE = "0x23b78cabb824ccaf9a24f3fe335ae144b3fa3d21a53955ca4e3f01544a0c2d52::prediction_market::YES<0xe9a73a6f4457f6ecad6260a37a200745a8009e9ee1a235ab91f8d3c030d3a705::dusdc::DUSDC>";
  const QUOTE = "0xe9a73a6f4457f6ecad6260a37a200745a8009e9ee1a235ab91f8d3c030d3a705::dusdc::DUSDC";
  const DUSDC = QUOTE;

  // Find a DUSDC coin  
  const coins = await listAllCoins(c, addr, DUSDC);
  const dCoin = coins.find((x: any) => BigInt(x.balance) >= 1000n);
  if (!dCoin) { console.log("No DUSDC coin"); process.exit(1); }
  console.log("Using DUSDC coin:", dCoin.objectId, "balance:", dCoin.balance);

  // 1. Deposit DUSDC into BM for fee payment
  console.log("1. Depositing DUSDC into BM...");
  const tx1 = new Transaction();
  tx1.moveCall({ target: DB + "::balance_manager::deposit", typeArguments: [DUSDC], arguments: [tx1.object(BM), tx1.object(dCoin.objectId)] });
  try { const r = await executeTransaction(c, tx1, s); console.log("   OK:", r.digest); }
  catch(e) { console.error("   FAIL:", (e as Error).message.slice(0,200)); process.exit(1); }

  // 2. Place bid (payWithDeep=false to use DUSDC fees)
  console.log("2. Placing bid...");
  const tx2 = new Transaction();
  const proof = tx2.moveCall({ target: DB + "::balance_manager::generate_proof_as_owner", arguments: [tx2.object(BM)] });
  tx2.moveCall({ target: DB + "::pool::place_limit_order", typeArguments: [BASE, QUOTE], arguments: [
    tx2.object(YES_POOL), tx2.object(BM), proof,
    tx2.pure.u64(0n), tx2.pure.u8(0), tx2.pure.u8(1),
    tx2.pure.u64(500_000_000n), tx2.pure.u64(1_000_000n),
    tx2.pure.bool(true), tx2.pure.bool(false),
    tx2.pure.u64(BigInt(Date.now() + 3600_000)),
    tx2.object.clock(),
  ]});
  try { const r = await executeTransaction(c, tx2, s); console.log("   OK:", r.digest); }
  catch(e) { console.error("   FAIL:", (e as Error).message.slice(0,300)); }
  process.exit(0);
}
t();
