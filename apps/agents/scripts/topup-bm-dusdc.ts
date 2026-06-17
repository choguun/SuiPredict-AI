/**
 * One-shot helper: mint $10,000 DUSDC to the agent wallet and deposit
 * it to the BM so the MarketMaker has balance to quote against.
 *
 * Why: the maker's self-mint path (market-maker.ts:204) does
 * `coin::mint_and_transfer(TreasuryCap, 1_000_000_000_000, agentAddr)`
 * — 1M USDC. The agent address has 11 zero-balance DUSDC coins but
 * no DUSDC balance, suggesting the mint tx is silently failing
 * (caught by the maker's catch block at line 298, surfaces as
 * `quote_failed`). Run this script once to seed the BM.
 */
import { Transaction } from "@mysten/sui/transactions";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import {
  executeTransaction,
  keypairFromPrivateKey,
  DUSDC_TYPE,
} from "@suipredict/sdk";

const pk = process.env.AGENT_PRIVATE_KEY;
const treasuryCapId =
  process.env.DUSDC_TREASURY_CAP_ID ?? process.env.NEXT_PUBLIC_DUSDC_TREASURY_CAP_ID;
const bmId =
  process.env.BALANCE_MANAGER_ID ?? process.env.NEXT_PUBLIC_BALANCE_MANAGER_ID;
const dbPkg =
  process.env.NEXT_PUBLIC_DEEPBOOK_PACKAGE_ID ?? process.env.DEEPBOOK_PACKAGE_ID;
if (!pk) { console.error("AGENT_PRIVATE_KEY not set"); process.exit(1); }
if (!treasuryCapId) { console.error("DUSDC_TREASURY_CAP_ID not set"); process.exit(1); }
if (!bmId) { console.error("BALANCE_MANAGER_ID not set"); process.exit(1); }
if (!dbPkg) { console.error("DEEPBOOK_PACKAGE_ID not set"); process.exit(1); }

const keypair = keypairFromPrivateKey(pk);
const addr = keypair.getPublicKey().toSuiAddress();
console.log("agent:", addr);
console.log("treasuryCap:", treasuryCapId);
console.log("balanceManager:", bmId);
console.log("deepBook pkg:", dbPkg);

const RPC = "https://fullnode.testnet.sui.io:443";
const client = new SuiGrpcClient({ network: "testnet", baseUrl: RPC });

// 1. Mint 10,000 USDC (10^10 raw) to the agent wallet.
const MINT_AMOUNT = 10_000_000_000n; // 10,000 USDC at 6 decimals
console.log("\n[mint] minting", Number(MINT_AMOUNT) / 1e6, "USDC →", addr);
const mintTx = new Transaction();
mintTx.moveCall({
  target: "0x2::coin::mint_and_transfer",
  typeArguments: [DUSDC_TYPE],
  arguments: [
    mintTx.object(treasuryCapId),
    mintTx.pure.u64(MINT_AMOUNT),
    mintTx.pure.address(addr),
  ],
});
const mintRes = await executeTransaction(client, mintTx, keypair);
console.log("mint digest:", mintRes.digest);

// 2. List DUSDC coins via JSON-RPC (the gRPC client doesn't expose getCoins).
const coinsRes = await fetch(RPC, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    jsonrpc: "2.0",
    method: "suix_getCoins",
    params: [addr, DUSDC_TYPE, null, 20],
    id: 1,
  }),
});
const coinsJson = (await coinsRes.json()) as {
  result?: { data?: Array<{ coinObjectId: string; balance: string }> };
};
const allCoins = coinsJson.result?.data ?? [];
console.log(`agent has ${allCoins.length} DUSDC coins`);
allCoins.sort((a, b) => Number(BigInt(b.balance) - BigInt(a.balance)));
const fresh = allCoins.find((c) => BigInt(c.balance) >= MINT_AMOUNT);
if (!fresh) {
  console.error("no DUSDC coin with sufficient balance after mint");
  console.error("coins:", allCoins.map((c) => ({ id: c.coinObjectId, bal: c.balance })));
  process.exit(2);
}
console.log("fresh DUSDC coin:", fresh.coinObjectId, "bal:", fresh.balance);

// 3. Deposit to the BM.
const depositTx = new Transaction();
depositTx.moveCall({
  target: `${dbPkg}::balance_manager::deposit`,
  typeArguments: [DUSDC_TYPE],
  arguments: [depositTx.object(bmId), depositTx.object(fresh.coinObjectId)],
});
const depRes = await executeTransaction(client, depositTx, keypair);
console.log("deposit digest:", depRes.digest);
console.log("\n✓ BM topped up. MarketMaker should resume quoting on next tick.");
