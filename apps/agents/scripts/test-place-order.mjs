#!/usr/bin/env node
/**
 * One-shot test: place a single limit order on a v3 market to verify
 * the `place_order` PTB type-matches.
 */
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { Transaction } from "@mysten/sui/transactions";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import {
  buildPlaceOrderTx,
  executeTransaction,
  keypairFromPrivateKey,
  DUSDC_TYPE,
} from "@suipredict/sdk";

// Load repo-root .env
import dotenv from "dotenv";
const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, "..");
for (const p of [
  resolve(__dirname, "../../../.env"),
  resolve(process.cwd(), ".env"),
  resolve(process.cwd(), "../.env"),
  resolve(process.cwd(), "../../.env"),
]) {
  if (existsSync(p)) {
    dotenv.config({ path: p, override: true });
    break;
  }
}

const pk = process.env.AGENT_PRIVATE_KEY;
if (!pk) { console.error("AGENT_PRIVATE_KEY not set"); process.exit(1); }
const keypair = keypairFromPrivateKey(pk);
const addr = keypair.getPublicKey().toSuiAddress();
const RPC = "https://fullnode.testnet.sui.io:443";
const client = new SuiGrpcClient({ network: "testnet", baseUrl: RPC });

const MARKET_ID = "0x7090b18d71ed188625ae762765cc8d69d81a7c4cfa0a9fd1f370da8546defdd0";
const POOL_ID = "0x0fbe4fb2a26272f88c0656b99efbe7cfaa32ac80618dd9250c8065150ccd0555";
const BM_ID = process.env.BALANCE_MANAGER_ID;

console.log("agent:", addr);
console.log("market:", MARKET_ID);
console.log("pool:", POOL_ID);
console.log("BM:", BM_ID);

const placeTx = buildPlaceOrderTx({
  marketId: MARKET_ID,
  poolId: POOL_ID,
  balanceManagerId: BM_ID,
  clientOrderId: BigInt(Date.now() % 1_000_000),
  price: 500_000_000n, // 0.5 USDC in 1e9 units
  quantity: 1_000_000n, // 1 YES share
  isBid: true,
});

try {
  const result = await executeTransaction(client, () => placeTx, keypair);
  console.log("✅ digest:", result.digest);
} catch (e) {
  console.error("❌ failed:", e.message?.slice(0, 500));
}