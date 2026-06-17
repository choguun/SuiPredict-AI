/**
 * Diagnostic: try `create_market` in isolation against the Railway env's
 * package/registry/deepbook ids to surface the exact `arg_idx: 1,
 * TypeMismatch` failure with full error context. The wc-creator's catch
 * block truncates the error message; this script logs everything.
 */
import { Transaction } from "@mysten/sui/transactions";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import {
  executeTransaction,
  keypairFromPrivateKey,
  DUSDC_TYPE,
  PREDICT_MARKET_PACKAGE_ID,
  DEEPBOOK_REGISTRY_ID,
} from "@suipredict/sdk";

const pk = process.env.AGENT_PRIVATE_KEY;
if (!pk) { console.error("AGENT_PRIVATE_KEY required"); process.exit(1); }
const keypair = keypairFromPrivateKey(pk);
const addr = keypair.getPublicKey().toSuiAddress();

const RPC = "https://fullnode.testnet.sui.io:443";
const client = new SuiGrpcClient({ network: "testnet", baseUrl: RPC });

// Find a fresh DEEP coin >= 500_000_000 (500 DEEP at 6 decimals)
const DEEP_TYPE = process.env.DEEP_TYPE ?? "0x7b86477fb48be71179877784f75c44d260e15e429bce8da658a0ebf7aa48ae7b::deep::DEEP";
const deepRes = await fetch(RPC, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    jsonrpc: "2.0",
    method: "suix_getCoins",
    params: [addr, DEEP_TYPE, null, 20],
    id: 1,
  }),
});
const deepJson = (await deepRes.json()) as {
  result?: { data?: Array<{ coinObjectId: string; balance: string }> };
};
const allDeep = (deepJson.result?.data ?? []).filter((c) => BigInt(c.balance) >= 500_000_000n);
if (allDeep.length === 0) {
  console.error("No DEEP coin >= 500 DEEP for agent", addr);
  process.exit(2);
}
allDeep.sort((a, b) => Number(BigInt(b.balance) - BigInt(a.balance)));
const deepCoinId = allDeep[0].coinObjectId;
console.log("agent:", addr);
console.log("package:", PREDICT_MARKET_PACKAGE_ID);
console.log("registry:", DEEPBOOK_REGISTRY_ID);
console.log("DEEP_TYPE:", DEEP_TYPE);
console.log("DUSDC_TYPE:", DUSDC_TYPE);
console.log("deep coin:", deepCoinId, "bal:", allDeep[0].balance);

const expiryMs = BigInt(Date.now() + 7 * 24 * 60 * 60 * 1000);
const tx = new Transaction();
tx.moveCall({
  target: `${PREDICT_MARKET_PACKAGE_ID}::prediction_market::create_market`,
  typeArguments: [DUSDC_TYPE],
  arguments: [
    tx.object("0xc"),
    tx.object(DEEPBOOK_REGISTRY_ID),
    tx.pure.vector("u8", new TextEncoder().encode("diag: who wins next WC match?")),
    tx.pure.vector("u8", new TextEncoder().encode("https://en.wikipedia.org/wiki/2026_FIFA_World_Cup")),
    tx.pure.u64(expiryMs),
    tx.pure.u64(1_000_000n),
    tx.pure.u64(1_000_000n),
    tx.pure.u64(1_000_000n),
    tx.object(deepCoinId),
    tx.pure.u8(3),
  ],
});

try {
  const result = await executeTransaction(client, tx, keypair);
  console.log("✓ digest:", result.digest);
} catch (err) {
  console.error("✗ FAILED:");
  console.error(err);
  process.exit(3);
}
