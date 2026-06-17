import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";
import { Transaction } from "@mysten/sui/transactions";
import "dotenv/config";

const PKG = "0xf6f11b4e98d0d3250938f730be04b61ca4a47938653cda70d048b72cea8cc577";
const DEEPBOOK_REGISTRY = "0xe14eba90fc8cc14a2eac1199b207d4e664931f8196f612b5aacf0c4a7f7d7a6f";
const DUSDC_TYPE = "0xe9a73a6f4457f6ecad6260a37a200745a8009e9ee1a235ab91f8d3c030d3a705::dusdc::DUSDC";
const DEEP_TYPE = "0x7b86477fb48be71179877784f75c44d260e15e429bce8da658a0ebf7aa48ae7b::deep::DEEP";

const pk = Ed25519Keypair.fromSecretKey(process.env.AGENT_PRIVATE_KEY);
const addr = pk.getPublicKey().toSuiAddress();
console.log("Agent:", addr);

const client = new SuiJsonRpcClient({ url: getJsonRpcFullnodeUrl("testnet"), network: "testnet" });

// Find a 500+ DEEP coin
const coins = await client.getAllCoins({ owner: addr, limit: 100 });
const deepCoin = coins.data.find(c => c.coinType === DEEP_TYPE && BigInt(c.balance) >= 500_000_000n);
if (!deepCoin) { console.log("No big DEEP coin"); process.exit(1); }
console.log("DEEP coin:", deepCoin.coinObjectId.slice(0,18) + "...", deepCoin.balance);

const tx = new Transaction();
// Split 500 DEEP
const [feeCoin] = tx.splitCoins(tx.object(deepCoin.coinObjectId), [tx.pure.u64(500_000_000n)]);
tx.moveCall({
  target: `${PKG}::prediction_market::create_market`,
  typeArguments: [DUSDC_TYPE],
  arguments: [
    tx.object("0xc"),
    tx.object(DEEPBOOK_REGISTRY),
    tx.pure.vector("u8", Array.from(Buffer.from("Test market from bootstrap"))),
    tx.pure.vector("u8", Array.from(Buffer.from("CoinGecko"))),
    tx.pure.u64(BigInt(Date.now() + 7 * 24 * 60 * 60 * 1000)),
    tx.pure.u64(1_000_000n),
    tx.pure.u64(1_000_000n),
    tx.pure.u64(1_000_000n),
    feeCoin,
    tx.pure.u8(3),
  ],
});
tx.setSender(addr);
tx.setGasBudget(1_000_000_000n);

const result = await client.signAndExecuteTransaction({ signer: pk, transaction: tx, options: { showEffects: true, showObjectChanges: true } });
console.log("Digest:", result.digest);
console.log("Status:", result.effects?.status);
if (result.effects?.status?.status === "failure") console.log("Error:", result.effects.status.error);
for (const c of result.objectChanges ?? []) {
  if (c.type === "created" && c.objectType?.includes("PredictionMarket")) {
    console.log("Market created:", c.objectId);
  }
  if (c.type === "created" && c.objectType?.includes("Pool")) {
    console.log("Pool created:", c.objectId);
  }
}
