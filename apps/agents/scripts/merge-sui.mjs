// Merge all small SUI gas coins in the agent wallet into one big coin.
// Run via: node scripts/merge-sui.mjs
// Requires AGENT_PRIVATE_KEY in env.
//
// Strategy: bypass `executeTransaction` (predict-client.ts) because its
// `pinFreshGasCoin` always selects the largest coin as gas — and the
// largest coin is also the merge target, which Sui rejects as
// "Mutable object … cannot appear more than one in one transaction".
// Instead: pin the SECOND-largest coin as gas, merge the rest into
// the largest via `pay::join_vec`, then loop until only 1 coin remains.
import dotenv from "dotenv";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

for (const p of [
  resolve(process.cwd(), ".env"),
  resolve(process.cwd(), "../.env"),
  resolve(process.cwd(), "../../.env"),
]) {
  if (existsSync(p)) { dotenv.config({ path: p, override: true }); break; }
}

const { Transaction } = await import("@mysten/sui/transactions");
const { SuiGrpcClient } = await import("@mysten/sui/grpc");
const { Ed25519Keypair } = await import("@mysten/sui/keypairs/ed25519");
const { keypairFromPrivateKey } = await import("@suipredict/sdk");

const pk = process.env.AGENT_PRIVATE_KEY;
if (!pk) { console.error("AGENT_PRIVATE_KEY not set"); process.exit(1); }

const keypair = keypairFromPrivateKey(pk);
const addr = keypair.getPublicKey().toSuiAddress();
console.log("agent address:", addr);

const RPC = "https://fullnode.testnet.sui.io:443";
const client = new SuiGrpcClient({ network: "testnet", baseUrl: RPC });

async function fetchSuiCoins() {
  const resp = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "suix_getCoins",
      params: [addr, "0x2::sui::SUI", null, 50]
    }),
  });
  const j = await resp.json();
  return (j.result?.data ?? []).sort(
    (a, b) => Number(BigInt(b.balance) - BigInt(a.balance)),
  );
}

async function fetchFresh(objectId) {
  const resp = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "sui_getObject",
      params: [objectId, { showVersion: true, showDigest: true, showOwner: false }]
    }),
  });
  const j = await resp.json();
  const obj = j.result?.data ?? j.result;
  if (!obj || !obj.version) {
    throw new Error(`object not found: ${objectId}`);
  }
  return obj;
}

async function submitMergeTx(tx) {
  // `tx.sign` returns `{ signature, bytes }` with both already b64-encoded
  // strings (Ed25519 Sui sig format: 1-byte flag || 64-byte sig || 32-byte pubkey).
  const { signature, bytes } = await tx.sign({ client, signer: keypair });
  const resp = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "sui_executeTransactionBlock",
      params: [
        bytes,
        [signature],
        {
          showEffects: true,
          showObjectChanges: true,
        },
        "WaitForLocalExecution",
      ],
    }),
  });
  const j = await resp.json();
  if (j.error) throw new Error(`rpc error: ${JSON.stringify(j.error)}`);
  if (j.result?.effects?.status?.status !== "success") {
    throw new Error(`tx failed: ${JSON.stringify(j.result?.effects?.status)}`);
  }
  return j.result.digest;
}

let iter = 0;
while (true) {
  iter++;
  const coins = await fetchSuiCoins();
  console.log(`[iter ${iter}] ${coins.length} SUI coin(s):`);
  for (const c of coins) {
    console.log(`  ${c.coinObjectId.slice(0,18)}… ${c.balance} MIST`);
  }
  if (coins.length < 2) {
    console.log("only one coin — done");
    break;
  }
  if (coins.length === 2) {
    // Edge case: 2 coins, primary >= 0.01 SUI is already big enough
    // for any txs the agent cares about. The maker needs ~3.5M MIST
    // per tick, which fits in the 1+ SUI primary. Stop merging.
    console.log(
      "only 2 coins left — primary is large enough for the maker; skipping further merge",
    );
    break;
  }

  // pick primary = largest, gas = second-largest, sources = the rest
  const primary = coins[0];
  const gasCoin = coins[1];
  const sources = coins.slice(2);
  console.log(
    `Merging ${sources.length} coin(s) into ${primary.coinObjectId.slice(0,18)}…`
    + `, gas=${gasCoin.coinObjectId.slice(0,18)}… (${gasCoin.balance} MIST)`,
  );

  // Freshen version+digest for the gas coin (sibling txs can stale it)
  const gasFresh = await fetchFresh(gasCoin.coinObjectId);

  const tx = new Transaction();
  tx.setSender(addr);
  tx.setGasBudget(2_000_000); // 0.002 SUI
  tx.setGasPayment([{
    objectId: gasCoin.coinObjectId,
    version: gasFresh.version,
    digest: gasFresh.digest,
  }]);
  tx.moveCall({
    target: "0x2::pay::join_vec",
    typeArguments: ["0x2::sui::SUI"],
    arguments: [
      tx.object(primary.coinObjectId),
      tx.makeMoveVec({ elements: sources.map((s) => tx.object(s.coinObjectId)) }),
    ],
  });

  const digest = await submitMergeTx(tx);
  console.log(`  digest: ${digest}`);
}

const final = await fetchSuiCoins();
const total = final.reduce((acc, c) => acc + BigInt(c.balance), 0n);
console.log("\n=== FINAL ===");
console.log(`SUI coins: ${final.length}`);
for (const c of final) console.log(`  ${c.coinObjectId} ${c.balance} MIST`);
console.log(`Total: ${total} MIST (${Number(total) / 1e9} SUI)`);