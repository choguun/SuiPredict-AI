import { config as loadEnv } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../../.env") });

import { SuiGrpcClient } from "@mysten/sui/grpc";
import { 
  keypairFromPrivateKey,
  executeTransaction,
  createMarketDeepBookClient,
  buildPlaceYesLimitOrderTx,
  buildWithdrawSettledTx,
  PREDICT_DEEPBOOK_POOL_KEY,
} from "@suipredict/sdk";

async function main() {
  const signer = keypairFromPrivateKey(process.env.AGENT_PRIVATE_KEY!);
  const client = new SuiGrpcClient({ network: "testnet", baseUrl: "https://fullnode.testnet.sui.io:443" });
  const addr = signer.getPublicKey().toSuiAddress();
  const poolId = "0x93a00df8200f5383b6d348b057346a31e6c15b95cda8001c3fc465f76bc98e6f";
  const bmId = process.env.BALANCE_MANAGER_ID!;

  // Step 1: Create DeepBook client
  let dbClient;
  try {
    dbClient = createMarketDeepBookClient(client, addr, poolId, undefined, bmId);
    console.log("1. DeepBook client: OK");
  } catch(e) { console.error("1. FAIL:", e instanceof Error ? e.message : String(e)); process.exit(1); }

  // Step 2: Try withdraw settled
  try {
    const tx = buildWithdrawSettledTx(dbClient, PREDICT_DEEPBOOK_POOL_KEY);
    await executeTransaction(client, tx, signer);
    console.log("2. Withdraw settled: OK");
  } catch(e) { console.error("2. FAIL:", (e instanceof Error ? e.message : String(e)).slice(0, 300)); }

  // Step 3: Try place bid
  try {
    const tx = buildPlaceYesLimitOrderTx(dbClient, PREDICT_DEEPBOOK_POOL_KEY, {
      price: 0.4, quantity: 1, isBid: true,
      clientOrderId: `test-bid-${Date.now()}`,
      expiration: Math.floor(Date.now()/1000) + 3600,
    });
    await executeTransaction(client, tx, signer);
    console.log("3. Place bid: OK");
  } catch(e) { console.error("3. FAIL:", (e instanceof Error ? e.message : String(e)).slice(0, 300)); }

  process.exit(0);
}
main();
