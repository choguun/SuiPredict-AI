/**
 * One-shot helper: create a fresh AgentPolicy with a $100k USDC budget and
 * 90-day expiry. Called when the current policy's `spent` field has hit
 * `max_budget` (the agent_policy module has no rotate_budget — only
 * create_policy). The agent address is both owner and signer because the
 * bootstrap ran with owner = ctx.sender() = agent.
 *
 * Output: prints the new policy id and writes it to
 * `apps/agents/data/agent-policy-id.txt` for the operator to copy into
 * Railway + Vercel as `AGENT_POLICY_ID` / `NEXT_PUBLIC_AGENT_POLICY_ID`.
 */
import { Transaction } from "@mysten/sui/transactions";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import {
  executeTransaction,
  keypairFromPrivateKey,
} from "@suipredict/sdk";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const pk = process.env.AGENT_PRIVATE_KEY;
const policyPkg =
  process.env.AGENT_POLICY_PACKAGE_ID ?? process.env.NEXT_PUBLIC_AGENT_POLICY_PACKAGE_ID;
if (!pk) { console.error("AGENT_PRIVATE_KEY not set"); process.exit(1); }
if (!policyPkg) { console.error("AGENT_POLICY_PACKAGE_ID not set"); process.exit(1); }

const keypair = keypairFromPrivateKey(pk);
const addr = keypair.getPublicKey().toSuiAddress();
console.log("agent address:", addr);
console.log("policy package:", policyPkg);

const RPC = "https://fullnode.testnet.sui.io:443";
const client = new SuiGrpcClient({ network: "testnet", baseUrl: RPC });
const BUDGET_USDC = 100_000_000_000n; // $100,000 USDC (6 decimals)
const EXPIRY_MS = BigInt(Date.now() + 90 * 24 * 60 * 60 * 1000);

const tx = new Transaction();
tx.moveCall({
  target: `${policyPkg}::agent_policy::create_policy`,
  arguments: [
    tx.pure.address(addr),
    tx.pure.u64(BUDGET_USDC),
    tx.pure.u64(EXPIRY_MS),
  ],
});

const result = await executeTransaction(client, tx, keypair);
console.log("digest:", result.digest);

// Resolve the new policy id from the tx's created objects via JSON-RPC.
const txRes = await fetch(RPC, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    jsonrpc: "2.0",
    method: "sui_getTransactionBlock",
    params: [
      result.digest,
      { showObjectChanges: true, showEffects: true },
    ],
    id: 1,
  }),
});
const txJson = (await txRes.json()) as {
  result?: {
    objectChanges?: Array<{
      type: string;
      objectType?: string;
      objectId?: string;
    }>;
  };
};
const created = txJson.result?.objectChanges?.find(
  (c) => c.type === "created" && c.objectType?.endsWith("::agent_policy::AgentPolicy"),
);
if (!created?.objectId) {
  console.error("No AgentPolicy in tx objectChanges:");
  console.error(JSON.stringify(txJson.result?.objectChanges, null, 2));
  process.exit(2);
}

const newId = created.objectId;
console.log("\n✓ NEW POLICY ID:", newId);

// Persist for operator convenience.
const out = join(process.cwd(), "data", "agent-policy-id.txt");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, newId + "\n");
console.log("written to:", out);
