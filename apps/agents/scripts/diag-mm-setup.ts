/**
 * Diagnostic: replicate the MarketMaker's setup PTB in isolation to
 * capture the full `arg_idx: 0, TypeMismatch in command 1` error
 * (the Railway logs truncate at the single-quote delimiter).
 */
import { Transaction } from "@mysten/sui/transactions";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import {
  executeTransaction,
  keypairFromPrivateKey,
  DUSDC_TYPE,
} from "@suipredict/sdk";

const pk = process.env.AGENT_PRIVATE_KEY;
if (!pk) process.exit(1);
const keypair = keypairFromPrivateKey(pk);
const addr = keypair.getPublicKey().toSuiAddress();
const RPC = "https://fullnode.testnet.sui.io:443";
const client = new SuiGrpcClient({ network: "testnet", baseUrl: RPC });

const bmId = process.env.BALANCE_MANAGER_ID!;
const policyId = process.env.AGENT_POLICY_ID!;
const policyPkg = process.env.AGENT_POLICY_PACKAGE_ID!;
const dbPkg = process.env.NEXT_PUBLIC_DEEPBOOK_PACKAGE_ID!;

// Find a DUSDC coin >= 1 USDC
const dusdcRes = await fetch(RPC, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    jsonrpc: "2.0",
    method: "suix_getCoins",
    params: [addr, DUSDC_TYPE, null, 20],
    id: 1,
  }),
});
const dusdcJson = (await dusdcRes.json()) as { result?: { data?: Array<{ coinObjectId: string; balance: string }> } };
const dusdcCoin = dusdcJson.result?.data?.find((c) => BigInt(c.balance) >= 1_000_000n);
if (!dusdcCoin) {
  console.error("No DUSDC coin >= 1 USDC for", addr);
  process.exit(2);
}
console.log("agent:", addr);
console.log("bm:", bmId);
console.log("policy:", policyId, "(pkg", policyPkg + ")");
console.log("db pkg:", dbPkg);
console.log("dusdc coin:", dusdcCoin.coinObjectId, "bal:", dusdcCoin.balance);

// Replicate the setup PTB (commands 0 + 1)
const tx = new Transaction();
tx.moveCall({
  target: `${dbPkg}::balance_manager::deposit`,
  typeArguments: [DUSDC_TYPE],
  arguments: [tx.object(bmId), tx.object(dusdcCoin.coinObjectId)],
});
tx.moveCall({
  target: `${policyPkg}::agent_policy::authorize_spend`,
  typeArguments: [],
  arguments: [
    tx.object(policyId),
    tx.pure.u64(2_000_000n),
    tx.object.clock(),
  ],
});

try {
  const result = await executeTransaction(client, tx, keypair);
  console.log("✓ digest:", result.digest);
} catch (err) {
  console.error("✗ FAILED:");
  console.error(JSON.stringify(err, null, 2));
}
