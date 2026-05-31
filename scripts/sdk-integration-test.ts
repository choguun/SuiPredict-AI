/**
 * SDK Integration Test - Trading on Pre-deployed DeepBook Pool
 * 
 * Uses the npm package's pre-deployed deepbook (0x22be4c...) and pool (0xe86b99...).
 * We need DBUSDC to trade - we have ML DEEP (0x36db...) but no DBUSDC.
 * 
 * This script tests:
 * 1. SDK connection to testnet
 * 2. DeepBookClient with pre-deployed pool
 * 3. Balance manager creation and deposit
 * 4. Place limit order on DEEP/DBUSDC pool
 */

import { SuiGrpcClient } from "@mysten/sui/grpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import {
  DeepBookClient,
  OrderType,
  SelfMatchingOptions,
  testnetCoins,
  testnetPools,
} from "@mysten/deepbook-v3";
import { DeepBookContract } from "@mysten/deepbook-v3/dist/transactions/deepbook.mjs";

// Constants from npm package
const DEEPBOOK_PACKAGE_ID = "0x22be4cade64bf2d02412c7e8d0e8beea2f78828b948118d46735315409371a3c";
const REGISTRY_ID = "0x7c256edbda983a2cd6f946655f4bf3f00a41043993781f8674a7046e8c0e11d1";
const DEEP_TYPE = "0x36dbef866a1d62bf7328989a10fb2f07d769f4ee587c0de4a0a256e57e0a58a8::deep::DEEP";
const DBUSDC_TYPE = "0xf7152c05930480cd740d7311b5b8b45c6f488e3a53a11c3f74a6fac36a52e0d7::DBUSDC::DBUSDC";
const DEEP_DBUSDC_POOL_ID = "0xe86b991f8632217505fd859445f9803967ac84a9d4a1219065bf191fcb74b622";

// Our wallet
const PRIVATE_KEY = process.env.SUI_PRIVATE_KEY || "suiprivkey..."; // Set via env
const SUI_GRPC_URL = "https://fullnode.testnet.sui.io:443";
const NETWORK = "testnet";

async function main() {
  console.log("=" .repeat(60));
  console.log("SDK Integration Test - DeepBook Trading");
  console.log("=" .repeat(60));
  console.log(`Network: ${NETWORK}`);
  console.log(`SUI GRPC: ${SUI_GRPC_URL}`);
  console.log(`DeepBook Package: ${DEEPBOOK_PACKAGE_ID}`);
  console.log(`Registry: ${REGISTRY_ID}`);
  console.log(`DEEP/DBUSDC Pool: ${DEEP_DBUSDC_POOL_ID}`);
  console.log();

  // 1. Create client
  const client = new SuiGrpcClient({ network: NETWORK, baseUrl: SUI_GRPC_URL });
  console.log("[1] SuiClient created");

  // 2. Create keypair
  let keypair: Ed25519Keypair;
  if (PRIVATE_KEY.startsWith("suiprivkey")) {
    keypair = Ed25519Keypair.fromSecretKey(PRIVATE_KEY);
  } else {
    const hex = PRIVATE_KEY.startsWith("0x") ? PRIVATE_KEY.slice(2) : PRIVATE_KEY;
    keypair = Ed25519Keypair.fromSecretKey(Uint8Array.from(Buffer.from(hex, "hex")));
  }
  const address = keypair.getPublicKey().toSuiAddress();
  console.log(`[2] Wallet: ${address}`);
  console.log();

  // 3. Check our DEEP and DBUSDC balances
  console.log("[3] Checking coin balances...");
  const coins = await client.getCoins({ owner: address, coinType: DEEP_TYPE });
  console.log(`  DEEP coins: ${coins.data.length}`);
  for (const coin of coins.data) {
    console.log(`    ${coin.coinObjectId}: ${Number(coin.balance) / 1e6} DEEP`);
  }

  const dbusdcCoins = await client.getCoins({ owner: address, coinType: DBUSDC_TYPE });
  console.log(`  DBUSDC coins: ${dbusdcCoins.data.length}`);
  for (const coin of dbusdcCoins.data) {
    console.log(`    ${coin.coinObjectId}: ${Number(coin.balance) / 1e6} DBUSDC`);
  }
  console.log();

  // 4. Create DeepBookClient with pre-deployed pool
  console.log("[4] Creating DeepBookClient...");
  const dbClient = new DeepBookClient({
    client,
    address,
    network: NETWORK,
    balanceManagers: {},  // Will create one
    coins: testnetCoins,
    pools: testnetPools,
  });
  console.log("  DeepBookClient created");
  console.log();

  // 5. Create balance manager
  console.log("[5] Creating balance manager...");
  const createManagerTx = new Transaction();
  const manager = dbClient.balanceManager.createAndShareBalanceManager()(createManagerTx);
  
  createManagerTx.setSender(address);
  const mb = await client.signAndExecuteTransaction({
    transaction: createManagerTx,
    signer: keypair,
  });
  
  if (mb.$kind === "FailedTransaction") {
    console.log(`  ERROR: ${mb.FailedTransaction.status.error?.message}`);
  } else {
    console.log(`  TX: ${mb.Transaction.digest}`);
    // Find the balance manager ID from created objects
    const effects = mb.Transaction.effects;
    if (effects?.$kind === "Effects") {
      const created = effects.Effects.created;
      for (const c of created || []) {
        if (c.owner?.$kind === "Shared") {
          console.log(`  Balance Manager: ${c.reference.objectId}`);
        }
      }
    }
  }
  console.log();

  // 6. Get pool info
  console.log("[6] Pool info:");
  try {
    const pool = await dbClient.deepBook.getPool("DEEP_DBUSDC");
    console.log(`  Pool ID: ${pool}`);
    console.log(`  Base Asset: ${pool?.baseAsset}`);
    console.log(`  Quote Asset: ${pool?.quoteAsset}`);
  } catch (e) {
    console.log(`  Error getting pool: ${e}`);
  }
  console.log();

  // 7. Place a limit order (sell DEEP for DBUSDC)
  // We need DBUSDC to place a bid, or DEEP to place an ask
  // Since we have DEEP but no DBUSDC, we can place an ask (sell DEEP)
  console.log("[7] Placing limit order (ASK - selling DEEP for DBUSDC)...");
  
  if (coins.data.length === 0) {
    console.log("  No DEEP coins available - skipping order placement");
  } else {
    const deepCoinId = coins.data[0].coinObjectId;
    const placeOrderTx = new Transaction();
    
    // Build the place order transaction
    const orderTx = dbClient.deepBook.placeLimitOrder({
      poolKey: "DEEP_DBUSDC",
      balanceManagerKey: "DEEP_DBUSDC",
      clientOrderId: BigInt(Date.now()),
      price: 0.5,  // 0.5 DBUSDC per DEEP (we want to sell DEEP)
      quantity: 10, // 10 DEEP
      isBid: false, // ASK - selling base
      expiration: BigInt(Math.floor(Date.now() / 1000) + 3600), // 1 hour
      orderType: OrderType.NO_RESTRICTION,
      selfMatchingOption: SelfMatchingOptions.SELF_MATCHING_ALLOWED,
      payWithDeep: true,  // Pay fees with DEEP
    })(placeOrderTx);
    
    placeOrderTx.setSender(address);
    
    try {
      const result = await client.signAndExecuteTransaction({
        transaction: placeOrderTx,
        signer: keypair,
      });
      
      if (result.$kind === "FailedTransaction") {
        console.log(`  ERROR: ${result.FailedTransaction.status.error?.message}`);
      } else {
        console.log(`  SUCCESS! TX: ${result.Transaction.digest}`);
      }
    } catch (e) {
      console.log(`  Error: ${e}`);
    }
  }
  
  console.log();
  console.log("=" .repeat(60));
  console.log("Integration test complete");
  console.log("=" .repeat(60));
}

main().catch(console.error);
