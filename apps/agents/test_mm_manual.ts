import { config as loadEnv } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../../.env") });

import { Transaction } from "@mysten/sui/transactions";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { keypairFromPrivateKey, executeTransaction, yesCoinType, DUSDC_TYPE } from "@suipredict/sdk";

async function test() {
  const signer = keypairFromPrivateKey(process.env.AGENT_PRIVATE_KEY!);
  const client = new SuiGrpcClient({ network: "testnet", baseUrl: "https://fullnode.testnet.sui.io:443" });
  const DB = "0x4f179980d20c9bcc9347494d65d21fda8f54093971d476be8e5230f4aa6ddf36";
  const POOL = "0x93a00df8200f5383b6d348b057346a31e6c15b95cda8001c3fc465f76bc98e6f";
  const BM = "0x932b87dfc8f7a9e75e37d21e7c8fb1ef2cb139ffb4aa466e207d796ed32a7562";
  const base = yesCoinType();
  const quote = DUSDC_TYPE;
  console.log("Base:", base);
  console.log("Quote:", quote);

  // Step 1: Just generate proof
  const tx1 = new Transaction();
  tx1.moveCall({ target: DB + "::balance_manager::generate_proof_as_owner", arguments: [tx1.object(BM)] });
  try { const r = await executeTransaction(client, tx1, signer); console.log("1. Proof: OK", r.digest); }
  catch(e) { console.error("1. FAIL:", (e instanceof Error ? e.message : String(e)).slice(0,200)); return; }

  // Step 2: withdraw_settled_amounts
  const tx2 = new Transaction();
  const p2 = tx2.moveCall({ target: DB + "::balance_manager::generate_proof_as_owner", arguments: [tx2.object(BM)] });
  tx2.moveCall({ target: DB + "::pool::withdraw_settled_amounts", typeArguments: [base, quote], arguments: [tx2.object(POOL), tx2.object(BM), p2] });
  try { const r = await executeTransaction(client, tx2, signer); console.log("2. Withdraw: OK", r.digest); }
  catch(e) { console.error("2. FAIL:", (e instanceof Error ? e.message : String(e)).slice(0,300)); }

  // Step 3: place_limit_order bid
  const tx3 = new Transaction();
  const p3 = tx3.moveCall({ target: DB + "::balance_manager::generate_proof_as_owner", arguments: [tx3.object(BM)] });
  tx3.moveCall({ target: DB + "::pool::place_limit_order", typeArguments: [base, quote], arguments: [
    tx3.object(POOL), tx3.object(BM), p3,
    tx3.pure.u64(0n), tx3.pure.u8(0), tx3.pure.u8(1),
    tx3.pure.u64(500_000_000n), tx3.pure.u64(1_000_000n),
    tx3.pure.bool(true), tx3.pure.bool(true),
    tx3.pure.u64(BigInt(Date.now() + 3600_000)),
    tx3.object.clock(),
  ]});
  try { const r = await executeTransaction(client, tx3, signer); console.log("3. Bid: OK", r.digest); }
  catch(e) { console.error("3. FAIL:", (e instanceof Error ? e.message : String(e)).slice(0,300)); }

  process.exit(0);
}
test();
