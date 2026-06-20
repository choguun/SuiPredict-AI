#!/usr/bin/env -S npx tsx
/**
 * One-shot test: cancel all stale open orders on the agent's BalanceManager
 * across the 8 wc26 v3 markets.
 *
 * Why this exists:
 *  - The wc-maker places a bid every 2 minutes on each wc26 market but
 *    never cancels the previous tick's bid (DeepBook's `place_order` is
 *    additive — it does not replace).
 *  - DeepBook's `state::process_create` aborts with `EMaxOpenOrders`
 *    (abort code 2) once the agent has 100+ open orders on a single pool.
 *    We currently have ~102 open orders and every new tick fails.
 *  - The fix is structural (the maker should cancel old quotes before
 *    placing new ones), but as a one-shot we just clear the slot so the
 *    next tick succeeds.
 */
import dotenv from "dotenv";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const p = "/Users/choguun/Documents/workspaces/hackathon/SuiPredict-AI/.env";
if (existsSync(p)) dotenv.config({ path: p, override: true });

const { SuiGrpcClient } = await import("@mysten/sui/grpc");
const { Ed25519Keypair } = await import("@mysten/sui/keypairs/ed25519");
const { buildCancelAllOrdersTx, executeTransaction } = await import("@suipredict/sdk");

const kp = Ed25519Keypair.fromSecretKey(process.env.AGENT_PRIVATE_KEY);
const addr = kp.getPublicKey().toSuiAddress();
const client = new SuiGrpcClient({ network: "testnet", baseUrl: "https://fullnode.testnet.sui.io:443" });
const BM = process.env.BALANCE_MANAGER_ID;

// The 8 wc26 v3 markets (matches the backfilled wc26 rows).
const MARKETS = [
  { id: "0x7090b18d71ed188625ae762765cc8d69d81a7c4cfa0a9fd1f370da8546defdd0", name: "A1v2" },
  { id: "0x8c467c163db4a6039d2b69e8b87d15a0257147b61136da638bf19f3d8f56f4dc", name: "B1v2" },
  { id: "0x9cb0dcded50d9fb1ef2c23bca7b4e49def1e6a54cd6f3af810b7a3e583b1a101", name: "A3v4" },
  { id: "0x49e87b11c451e426e2a06c9a0cbeb638678ed4a3d214acbee8551e588247806a", name: "C1v2" },
  { id: "0x3d53486c845c32f8ba0f95142a954e3e699be0cb6720995974ad384d84e957e9", name: "B3v4" },
  { id: "0xee1ea13d501231d712a2608c6e4152b9e66ce814f045f3c35020b4b151c7aa27", name: "D1v2" },
  { id: "0x5ec114ae86e1b6e3bc65afbb68c3258bebe90635f1aaa4cff45918a9d0884d50", name: "C3v4" },
  { id: "0x99d44bb4746834a019d5079e402b800a49b2506411730939f3e3736a881d13fd", name: "E1v2" },
];
const POOL_ID = "0x0fbe4fb2a26272f88c0656b99efbe7cfaa32ac80618dd9250c8065150ccd0555";

console.log("agent:", addr);
console.log("BM:", BM);
console.log("markets:", MARKETS.length);

for (const m of MARKETS) {
  try {
    const tx = buildCancelAllOrdersTx({
      marketId: m.id,
      poolId: POOL_ID,
      balanceManagerId: BM,
    });
    const result = await executeTransaction(client, () => tx, kp);
    console.log(`  [OK] ${m.name} digest=${result.digest}`);
  } catch (e) {
    console.log(`  [SKIP] ${m.name}: ${e.message?.slice(0, 120)}`);
  }
}
