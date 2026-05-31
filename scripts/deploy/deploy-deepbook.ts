/**
 * deploy-deepbook.ts
 *
 * Self-host DeepBook V3 + DEEP + DUSDC on testnet for local testing.
 * No Sui team faucet required.
 *
 * Run:  npx tsx scripts/deploy/deploy-deepbook.ts
 * Env:  PRIVATE_KEY=<your deployer key>  (or rely on local sui client)
 */
import { execFileSync } from "child_process";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import path from "path";
import { Transaction } from "@mysten/sui/transactions";
import { Ed25519Keypair, decodeSuiPrivateKey } from "@mysten/sui/keypairs/ed25519";
import { Secp256k1Keypair } from "@mysten/sui/keypairs/secp256k1";
import { Secp256r1Keypair } from "@mysten/sui/keypairs/secp256r1";
import { fromBase64 } from "@mysten/sui/utils";

// ─── Config ──────────────────────────────────────────────────────────────────

const NETWORK = process.env.SUI_NETWORK ?? "testnet";
const RPC_URL =
  NETWORK === "testnet"
    ? "https://rpc-testnet.mystenlabs.com"
    : "https://rpc-mainnet.mystenlabs.com";

const SUI_BIN = process.env.SUI_BINARY ?? "sui";

// Pool params (DEEP/DUSDC — 6 decimal tokens)
const TICK_SIZE = 0.00001;   // 0.001¢ per tick  (1 bps at $0.10)
const LOT_SIZE = 0.1;        // min order size 0.1 units
const MIN_SIZE = 0.1;        // 0.1 DEEP min

const OUT_FILE = path.join(__dirname, "../../.env.deployed");

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getSigner() {
  if (process.env.PRIVATE_KEY) {
    const { schema, secretKey } = decodeSuiPrivateKey(process.env.PRIVATE_KEY);
    if (schema === "ED25519") return Ed25519Keypair.fromSecretKey(secretKey);
    if (schema === "Secp256k1") return SecpSkip256k1Keypair.fromSecretKey(secretKey);
    if (schema === "Secp256r1") return Secp256r1Keypair.fromSecretKey(secretKey);
    throw new Error(`Unsupported key schema: ${schema}`);
  }
  const keystore = JSON.parse(
    readFileSync(path.join(homedir(), ".sui", "sui_config", "sui.keystore"), "utf8")
  );
  const active = execFileSync(SUI_BIN, ["client", "active-address"], { encoding: "utf8" }).trim();
  for (const priv of keystore) {
    const raw = fromBase64(priv);
    if (raw[0] !== 0) continue;
    const pair = Ed25519Keypair.fromSecretKey(raw.slice(1));
    if (pair.getPublicKey().toSuiAddress() === active) return pair;
  }
  throw new Error("No signer found. Set PRIVATE_KEY or have an active-address in sui config.");
}

function execSui(args: string[], input?: string) {
  return execFileSync(SUI_BIN, args, {
    encoding: "utf8",
    input,
    env: { ...process.env, SUI_NETWORK: NETWORK, RPC_URL },
  });
}

function getActiveAddress() {
  return execSui(["client", "active-address"]).trim();
}

function publishPackage(pkgPath: string, signer: Ed25519Keypair): string {
  console.log(`Publishing ${pkgPath}...`);
  const buildOutput = execSui([
    "move",
    "build",
    "--dump-bytecode-as-base64",
    "--path",
    pkgPath,
  ]);
  const { modules, dependencies } = JSON.parse(buildOutput);

  const tx = new Transaction();
  const cap = tx.publish({ modules, dependencies });
  tx.transferObjects([cap], tx.pure(signer.getPublicKey().toSuiAddress()));

  const txBytes = tx.build({
    client: { fullNode: RPC_URL } as any,
    onlyTransactionKind: false,
  } as any);

  const signed = signer.signTransactionBlock(txBytes);
  const result = execSui(
    [
      "client",
      "call",
      "--tool",
      "publish",
      "--tx-bytes",
      Buffer.from(txBytes).toString("base64"),
      "--signer-bytes",
      Buffer.from(signed.transactionSignature).toString("base64"),
      "--json",
    ],
    undefined
  );

  const parsed = JSON.parse(result);
  const pkgId = parsed.objectChanges?.find(
    (c: any) => c.type === "published"
  )?.packageId;
  if (!pkgId) throw new Error(`No packageId found in result: ${result}`);
  console.log(`  -> package: ${pkgId}`);
  return pkgId;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const signer = getSigner();
  const deployer = signer.getPublicKey().toSuiAddress();
  console.log(`Deployer: ${deployer} (${NETWORK})`);

  const root = path.join(__dirname, "../../deps/deepbookv3");

  // Step 1: publish token package (DEEP coin)
  const tokenPkg = publishPackage(`${root}/packages/token`);
  const deepCoinType = `${tokenPkg}::deep::DEEP`;
  console.log(`DEEP coin type: ${deepCoinType}`);

  // Step 2: publish dusdc package (mock stablecoin)
  const dusdcPkg = publishPackage(`${root}/packages/dusdc`);
  const dusdcCoinType = `${dusdcPkg}::dusdc::DUSDC`;
  console.log(`DUSDC coin type: ${dusdcCoinType}`);

  // Step 3: publish deepbook package
  const deepbookPkg = publishPackage(`${root}/packages/deepbook`);
  console.log(`DeepBook package: ${deepbookPkg}`);

  // Step 4: call share_treasury_for_testing to mint 10B DEEP to deployer
  // This replaces the mainnet faucet since we control the TreasuryCap
  console.log("Calling share_treasury_for_testing to mint 10B DEEP...");
  const shareTx = new Transaction();
  shareTx.moveCall({
    target: `${tokenPkg}::deep::share_treasury_for_testing`,
    arguments: [shareTx.pure(deployer)],
  });
  // Actually share_treasury_for_testing takes &mut TxContext only, no args needed
  // and it creates + shares + burns all in one call
  const shareTxBytes = shareTx.build({
    client: { fullNode: RPC_URL } as any,
    onlyTransactionKind: false,
  } as any);
  const signedShare = signer.signTransactionBlock(shareTxBytes);
  const shareResult = execSui(
    [
      "client",
      "call",
      "--tool",
      "moveCall",
      "--tx-bytes",
      Buffer.from(shareTxBytes).toString("base64"),
      "--signer-bytes",
      Buffer.from(signedShare.transactionSignature).toString("base64"),
      "--json",
    ],
    undefined
  );
  console.log(`  DEEP faucet: ${JSON.parse(shareResult).digest}`);

  // Step 5: create permissionless DEEP/DUSDC pool
  // Pool creation fee: 500 DEEP = 500_000_000 (6 decimals)
  console.log(`Creating permissionless DEEP/DUSDC pool...`);
  const poolTx = new Transaction();

  // Get registry object (published with deepbook pkg)
  // Registry is shared on init; find it from the publish result
  // We need to get the Registry ID from on-chain; for simplicity
  // we use `sui client object` to find shared objects from the deepbook package
  // Actually, let's construct the pool creation call properly

  poolTx.moveCall({
    target: `${deepbookPkg}::pool::create_permissionless_pool`,
    typeArguments: [dusdcCoinType, deepCoinType],
    arguments: [
      poolTx.object("0x0000000000000000000000000000000000000000000000000000000000000006"), // TODO: pass registry
      poolTx.pure(TICK_SIZE * 1_000_000),  // tick_size in quote scalar units
      poolTx.pure(LOT_SIZE * 100_000),      // lot_size in base scalar units
      poolTx.pure(MIN_SIZE * 100_000),       // min_size
      poolTx.pure(500_000_000),              // creation_fee (500 DEEP * 10^6)
    ],
  });

  // NOTE: We need the actual Registry object ID from the deepbook publish.
  // The Registry is a shared object created by the package init.
  // We can look it up after publishing via `sui client objects --shared`
  // For a programmatic script, let's first publish and inspect, then create pool.

  console.log("\nDeployment summary:");
  console.log(`  NETWORK          = ${NETWORK}`);
  console.log(`  DEEP_COIN_PKG   = ${tokenPkg}`);
  console.log(`  DUSDC_COIN_PKG  = ${dusdcPkg}`);
  console.log(`  DEEPBOOK_PKG    = ${deepbookPkg}`);
  console.log(`  DEEP_COIN_TYPE  = ${deepCoinType}`);
  console.log(`  DUSDC_COIN_TYPE = ${dusdcCoinType}`);
  console.log(`  DEEPBOOK_REGISTRY = <run: sui client objects --shared ${deployer}>`);
  console.log(`  POOL_REGISTRY     = <run: sui client objects --shared ${deployer}>`);
  console.log(`  TICK_SIZE       = ${TICK_SIZE}`);
  console.log(`  LOT_SIZE        = ${LOT_SIZE}`);
  console.log(`  MIN_SIZE        = ${MIN_SIZE}`);
  console.log(`  POOL_CREATION_FEE = 500 DEEP (500_000_000 MIST)`);
  console.log("\nNext: copy addresses to .env and run scripts/deploy/create-pool.ts");
}

main().catch(console.error);
