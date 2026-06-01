/**
 * Bootstrap script: publish the contracts package, extract the
 * `StreakAdmin` / `StreakRegistry` / `PrizeAdmin` shared objects
 * created at init, generate a prize admin ed25519 keypair, create
 * a `PrizePool<DBUSDC>` seeded with a configurable amount, and
 * write all new IDs back to `.env` and `apps/web/.env.local`.
 *
 * Usage:
 *   pnpm --filter @suipredict/agents bootstrap
 *
 * Env required:
 *   AGENT_PRIVATE_KEY     — base58 ed25519 secret; the deployer/signer.
 * Env optional:
 *   PRIZE_ADMIN_PRIVATE_KEY  — if set, used as the prize admin keypair;
 *                              otherwise a fresh ed25519 keypair is
 *                              generated and its secret is printed
 *                              (you must save it before re-running).
 *   PRIZE_WEEKLY_AMOUNT      — amount of DUSDC to seed the pool with,
 *                              in base units (1_000_000 = 1 DUSDC).
 *                              Defaults to 1_000_000_000 (1000 DUSDC).
 *   SUI_NETWORK              — defaults to "testnet".
 */
import { config as loadEnv } from "dotenv";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Transaction } from "@mysten/sui/transactions";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import {
  createClient,
  DUSDC_TYPE,
  executeTransaction,
  keypairFromPrivateKey,
} from "@suipredict/sdk";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../..");
const PKG_DIR = resolve(REPO_ROOT, "packages/contracts");
const AGENTS_ENV = resolve(REPO_ROOT, ".env");
const WEB_ENV = resolve(REPO_ROOT, "apps/web/.env.local");

loadEnv({ path: AGENTS_ENV });

const NETWORK = process.env.SUI_NETWORK ?? "testnet";
const RPC_URL =
  NETWORK === "mainnet"
    ? "https://fullnode.mainnet.sui.io:443"
    : NETWORK === "devnet"
      ? "https://fullnode.devnet.sui.io:443"
      : "https://fullnode.testnet.sui.io:443";
const INITIAL_WEEK = Math.floor(Date.now() / (7 * 86_400_000));
const PRIZE_WEEKLY_AMOUNT = BigInt(
  process.env.PRIZE_WEEKLY_AMOUNT ?? "1000000000",
);

interface CreatedObject {
  type: string;
  objectId: string;
}

interface PublishResult {
  packageId: string;
  objects: CreatedObject[];
  digest: string;
}

function log(msg: string) {
  console.log(`[bootstrap] ${msg}`);
}

function err(msg: string): never {
  console.error(`[bootstrap] ERROR: ${msg}`);
  process.exit(1);
}

function runPublish(): PublishResult {
  log(`Publishing ${PKG_DIR} to ${NETWORK}...`);
  const publishedToml = join(PKG_DIR, "Published.toml");
  if (existsSync(publishedToml)) {
    try {
      writeFileSync(publishedToml, "");
    } catch {
      /* ignore — sui client will overwrite */
    }
  }
  let stdout: string;
  try {
    stdout = execFileSync(
      "sui",
      ["client", "publish", "--json", "--skip-dependency-verification", PKG_DIR],
      { encoding: "utf-8", env: { ...process.env, SUI_NETWORK: NETWORK } },
    );
  } catch (e: unknown) {
    const out =
      e && typeof e === "object" && "stdout" in e
        ? String((e as { stdout?: Buffer | string }).stdout ?? "")
        : String(e);
    err(`sui client publish failed:\n${out}`);
  }

  let parsed: {
    digest?: string;
    objectChanges?: {
      type: string;
      packageId?: string;
      objectType?: string;
      objectId?: string;
    }[];
  };
  try {
    parsed = JSON.parse(stdout);
  } catch {
    err(`Could not parse sui publish output:\n${stdout.slice(0, 800)}`);
  }

  const created =
    parsed.objectChanges
      ?.filter((c) => c.type === "created" && c.objectId && c.objectType)
      .map((c) => ({ type: c.objectType!, objectId: c.objectId! })) ?? [];

  const packageId = parsed.objectChanges?.find(
    (c) => c.type === "published" && c.packageId,
  )?.packageId;
  if (!packageId) err("No published package ID in publish output.");

  return { packageId, objects: created, digest: parsed.digest ?? "" };
}

function findSharedObject(
  objects: CreatedObject[],
  typeSuffix: string,
): string {
  const hit = objects.find((o) => o.type.endsWith(typeSuffix));
  if (!hit) {
    err(
      `Shared object "${typeSuffix}" not found. Got: ${objects
        .map((o) => o.type)
        .join(", ")}`,
    );
  }
  return hit.objectId;
}

function loadOrCreatePrizeKeypair(): {
  keypair: Ed25519Keypair;
  isNew: boolean;
} {
  const existing = process.env.PRIZE_ADMIN_PRIVATE_KEY;
  if (existing) {
    return {
      keypair: Ed25519Keypair.fromSecretKey(existing),
      isNew: false,
    };
  }
  return { keypair: new Ed25519Keypair(), isNew: true };
}

function setEnvVar(content: string, key: string, value: string): string {
  const re = new RegExp(`^${key}=.*$`, "m");
  const line = `${key}=${value}`;
  if (re.test(content)) return content.replace(re, line);
  return content.endsWith("\n") || content.length === 0
    ? `${content}${line}\n`
    : `${content}\n${line}\n`;
}

function updateEnv(path: string, updates: Record<string, string>) {
  let content = "";
  if (existsSync(path)) content = readFileSync(path, "utf-8");
  for (const [k, v] of Object.entries(updates)) {
    content = setEnvVar(content, k, v);
  }
  writeFileSync(path, content);
  log(`Updated env: ${path}`);
}

async function findDusdcCoin(
  client: SuiGrpcClient,
  owner: string,
  minAmount: bigint,
): Promise<string | null> {
  let cursor: string | null | undefined = undefined;
  do {
    const page = await client.listCoins({
      owner,
      coinType: DUSDC_TYPE,
      cursor: cursor ?? null,
      limit: 50,
    });
    for (const coin of page.objects) {
      if (BigInt(coin.balance) >= minAmount) return coin.objectId;
    }
    cursor = page.cursor ?? null;
  } while (cursor);
  return null;
}

async function findSharedObjects(
  client: SuiGrpcClient,
  owner: string,
  typeSuffix: string,
): Promise<string[]> {
  const out: string[] = [];
  let cursor: string | null | undefined = undefined;
  do {
    const page = await client.listOwnedObjects({
      owner,
      cursor: cursor ?? null,
      limit: 50,
    });
    for (const obj of page.objects) {
      if (obj.type?.includes(typeSuffix) && obj.objectId) {
        out.push(obj.objectId);
      }
    }
    cursor = page.cursor ?? null;
  } while (cursor);
  return out;
}

async function findVlpTreasuryCap(
  client: SuiGrpcClient,
  owner: string,
): Promise<string | null> {
  let cursor: string | null | undefined = undefined;
  do {
    const page = await client.listOwnedObjects({
      owner,
      cursor: cursor ?? null,
      limit: 50,
    });
    for (const obj of page.objects) {
      if (obj.type?.includes("::vlp::VLP") && obj.type?.includes("TreasuryCap")) {
        return obj.objectId;
      }
    }
    cursor = page.cursor ?? null;
  } while (cursor);
  return null;
}

async function getSharedObjectIdFromTx(
  client: SuiGrpcClient,
  digest: string,
  typeMatch: string,
): Promise<string> {
  const r = await client.getTransaction({
    digest,
    include: { effects: true, objectTypes: true },
  });
  if (r.$kind !== "Transaction") {
    err(`Transaction failed: ${digest}`);
  }
  const hit = r.Transaction.effects.changedObjects.find(
    (o) =>
      o.idOperation === "Created" &&
      o.outputOwner?.$kind === "Shared" &&
      (r.Transaction.objectTypes?.[o.objectId] ?? "").includes(typeMatch),
  )?.objectId;
  if (!hit) {
    err(
      `No shared object of type ${typeMatch} in tx ${digest}. Got: ` +
        JSON.stringify(r.Transaction.objectTypes ?? {}),
    );
  }
  return hit;
}

async function main() {
  if (!process.env.AGENT_PRIVATE_KEY) {
    err("AGENT_PRIVATE_KEY is required (the deployer signer).");
  }
  const signer = keypairFromPrivateKey(process.env.AGENT_PRIVATE_KEY);
  const signerAddr = signer.getPublicKey().toSuiAddress();
  log(`Deployer: ${signerAddr}`);

  // 1) Publish
  const { packageId, objects } = runPublish();
  log(`Package ID: ${packageId}`);

  // 2) Extract shared objects created at init
  const streakAdminId = findSharedObject(objects, "::streak_system::StreakAdmin");
  const streakRegistryId = findSharedObject(
    objects,
    "::streak_system::StreakRegistry",
  );
  const prizeAdminId = findSharedObject(objects, "::prize_pool::PrizeAdmin");
  // prediction_market::init shares a FeeVault<Q>. Extract it from the
  // publish effects; the `Q` placeholder in the type means we match by
  // suffix.
  const feeVaultId = findSharedObject(
    objects,
    "::prediction_market::FeeVault<",
  );
  log(`StreakAdmin:    ${streakAdminId}`);
  log(`StreakRegistry: ${streakRegistryId}`);
  log(`PrizeAdmin:     ${prizeAdminId}`);
  log(`FeeVault:       ${feeVaultId}`);

  // 3) Prize admin keypair
  const { keypair: prizeKey, isNew } = loadOrCreatePrizeKeypair();
  const prizePubkey = Array.from(prizeKey.getPublicKey().toRawBytes());
  const prizePubkeyB64 = Buffer.from(prizePubkey).toString("base64");
  const prizeAddress = prizeKey.getPublicKey().toSuiAddress();
  log(
    `Prize admin: ${prizeAddress} (${isNew ? "NEW keypair generated" : "loaded from env"})`,
  );
  if (isNew) {
    const secretB64 = Buffer.from(prizeKey.getSecretKey()).toString("base64");
    log(`  SAVE THIS — PRIZE_ADMIN_PRIVATE_KEY (base64): ${secretB64}`);
  }

  // 4) Set pubkey on-chain
  log("Setting PrizeAdmin pubkey on-chain...");
  const grpc = new SuiGrpcClient({ network: NETWORK as "testnet", baseUrl: RPC_URL });
  const txClient = createClient();
  {
    const tx = new Transaction();
    tx.moveCall({
      target: `${packageId}::prize_pool::rotate_pubkey`,
      arguments: [
        tx.object(prizeAdminId),
        tx.pure.vector("u8", prizePubkey),
      ],
    });
    const res = await executeTransaction(txClient, tx, signer);
    log(`  rotate_pubkey: ${res.digest}`);
  }

  // 5) Find a DBUSDC coin to seed the pool; mint from TreasuryCap if needed
  log("Looking for a DBUSDC coin >= seed amount in the deployer wallet...");
  let seedCoinId = await findDusdcCoin(grpc, signerAddr, PRIZE_WEEKLY_AMOUNT);
  if (!seedCoinId) {
    const treasuryCapId = process.env.DUSDC_TREASURY_CAP_ID;
    if (!treasuryCapId) {
      err(
        `No DBUSDC coin >= ${PRIZE_WEEKLY_AMOUNT} (${Number(PRIZE_WEEKLY_AMOUNT) / 1_000_000} DUSDC) found in ${signerAddr} ` +
          `and DUSDC_TREASURY_CAP_ID is unset. Mint DUSDC, set the TreasuryCap ID, then re-run.`,
      );
    }
    log(`  No seed coin — minting ${PRIZE_WEEKLY_AMOUNT} from TreasuryCap ${treasuryCapId}...`);
    const tx = new Transaction();
    const minted = tx.moveCall({
      target: "0x2::coin::mint",
      typeArguments: [DUSDC_TYPE],
      arguments: [tx.object(treasuryCapId), tx.pure.u64(PRIZE_WEEKLY_AMOUNT)],
    });
    tx.transferObjects([minted], signerAddr);
    const res = await executeTransaction(txClient, tx, signer);
    log(`  mint: ${res.digest}`);
    seedCoinId = await findDusdcCoin(grpc, signerAddr, PRIZE_WEEKLY_AMOUNT);
    if (!seedCoinId) {
      err(
        `Mint succeeded (${res.digest}) but no DBUSDC coin appeared. Check explorer.`,
      );
    }
  }
  log(`  seed coin: ${seedCoinId}`);

  // 6) Create the prize pool
  log("Creating PrizePool<DBUSDC>...");
  let createPoolDigest = "";
  {
    const tx = new Transaction();
    tx.moveCall({
      target: `${packageId}::prize_pool::create_pool`,
      typeArguments: [DUSDC_TYPE],
      arguments: [tx.object(seedCoinId), tx.pure.u64(INITIAL_WEEK)],
    });
    const res = await executeTransaction(txClient, tx, signer);
    createPoolDigest = res.digest;
    log(`  create_pool: ${createPoolDigest}`);
  }

  // 7) Find the new shared pool from the create_pool transaction's
  //    effects (the pool is shared via `transfer::share_object`, so it
  //    is not owned by the deployer and won't appear in
  //    `listOwnedObjects`).
  log("Fetching PrizePool object ID from create_pool effects...");
  const prizePoolId = await getSharedObjectIdFromTx(
    grpc,
    createPoolDigest,
    "::prize_pool::PrizePool<",
  );
  log(`PrizePool:      ${prizePoolId}`);

  // 7a) Create the MarketRegistry (not auto-created on publish)
  log("Creating MarketRegistry...");
  const registryDigest = await (async () => {
    const tx = new Transaction();
    tx.moveCall({
      target: `${packageId}::registry::create_registry`,
      arguments: [],
    });
    const res = await executeTransaction(txClient, tx, signer);
    log(`  create_registry: ${res.digest}`);
    return res.digest;
  })();
  const marketRegistryId = await getSharedObjectIdFromTx(
    grpc,
    registryDigest,
    "::registry::MarketRegistry",
  );
  log(`MarketRegistry: ${marketRegistryId}`);

  // 7b) Create the ProtocolVault<DBUSDC> from the deployer's VLP TreasuryCap
  log("Looking for VLP TreasuryCap in deployer wallet...");
  const vlpTreasuryCapId = await findVlpTreasuryCap(grpc, signerAddr);
  if (!vlpTreasuryCapId) {
    err(
      "No VLP TreasuryCap found in deployer wallet. Was the package just published? " +
        "The vlp::init() function should have transferred one to the publisher.",
    );
  }
  log(`  VLP TreasuryCap: ${vlpTreasuryCapId}`);
  log("Creating ProtocolVault<DBUSDC>...");
  const vaultDigest = await (async () => {
    const tx = new Transaction();
    tx.moveCall({
      target: `${packageId}::vault::create_vault`,
      typeArguments: [DUSDC_TYPE],
      arguments: [tx.object(vlpTreasuryCapId)],
    });
    const res = await executeTransaction(txClient, tx, signer);
    log(`  create_vault: ${res.digest}`);
    return res.digest;
  })();
  const protocolVaultId = await getSharedObjectIdFromTx(
    grpc,
    vaultDigest,
    "::vault::ProtocolVault<",
  );
  log(`ProtocolVault:  ${protocolVaultId}`);

  // 7c) Create an AgentPolicy so the agent hot wallet can act with a
  //     capped budget. Use AGENT_MAX_BUDGET_USDC * 10^6 (DUSDC has 6
  //     decimals) and a 1-year expiry.
  const policyBudget =
    BigInt(process.env.AGENT_MAX_BUDGET_USDC ?? "500") * 1_000_000n;
  const policyExpiryMs = Date.now() + 365 * 86_400_000;
  log(
    `Creating AgentPolicy (budget=${policyBudget} base, expires=${new Date(policyExpiryMs).toISOString()})...`,
  );
  const policyDigest = await (async () => {
    const tx = new Transaction();
    tx.moveCall({
      target: `${packageId}::agent_policy::create_policy`,
      arguments: [
        tx.pure.address(signerAddr),
        tx.pure.u64(policyBudget),
        tx.pure.u64(policyExpiryMs),
      ],
    });
    const res = await executeTransaction(txClient, tx, signer);
    log(`  create_policy: ${res.digest}`);
    return res.digest;
  })();
  const agentPolicyId = await getSharedObjectIdFromTx(
    grpc,
    policyDigest,
    "::agent_policy::AgentPolicy",
  );
  log(`AgentPolicy:    ${agentPolicyId}`);

  // 8) Write env updates
  const agentsUpdates: Record<string, string> = {
    AGENT_POLICY_PACKAGE_ID: packageId,
    MARKET_PACKAGE_ID: packageId,
    NEXT_PUBLIC_MARKET_PACKAGE_ID: packageId,
    STREAK_REGISTRY_ID: streakRegistryId,
    STREAK_ADMIN_ID: streakAdminId,
    PRIZE_POOL_ID: prizePoolId,
    PRIZE_ADMIN_ID: prizeAdminId,
    PRIZE_WEEKLY_AMOUNT: PRIZE_WEEKLY_AMOUNT.toString(),
    PRIZE_ADMIN_PUBKEY_B64: prizePubkeyB64,
    DUSDC_PACKAGE_ID: DUSDC_TYPE.split("::")[0],
    MARKET_REGISTRY_ID: marketRegistryId,
    VAULT_OBJECT_ID: protocolVaultId,
    FEE_VAULT_ID: feeVaultId,
    AGENT_POLICY_ID: agentPolicyId,
  };
  if (process.env.DUSDC_TREASURY_CAP_ID) {
    agentsUpdates.DUSDC_TREASURY_CAP_ID = process.env.DUSDC_TREASURY_CAP_ID;
  }
  if (isNew) {
    const secretB64 = Buffer.from(prizeKey.getSecretKey()).toString("base64");
    agentsUpdates.PRIZE_ADMIN_PRIVATE_KEY = secretB64;
  }
  updateEnv(AGENTS_ENV, agentsUpdates);
  updateEnv(WEB_ENV, {
    NEXT_PUBLIC_MARKET_PACKAGE_ID: packageId,
    NEXT_PUBLIC_STREAK_REGISTRY_ID: streakRegistryId,
    NEXT_PUBLIC_STREAK_ADMIN_ID: streakAdminId,
    NEXT_PUBLIC_PRIZE_POOL_ID: prizePoolId,
    NEXT_PUBLIC_VAULT_OBJECT_ID: protocolVaultId,
    NEXT_PUBLIC_AGENT_POLICY_ID: agentPolicyId,
  });

  log("\n=== Bootstrap complete ===");
  log(`Package:        ${packageId}`);
  log(`StreakAdmin:    ${streakAdminId}`);
  log(`StreakReg:      ${streakRegistryId}`);
  log(`PrizeAdmin:     ${prizeAdminId}`);
  log(`PrizePool:      ${prizePoolId}`);
  log(`FeeVault:       ${feeVaultId}`);
  log(`MarketRegistry: ${marketRegistryId}`);
  log(`ProtocolVault:  ${protocolVaultId}`);
  log(`AgentPolicy:    ${agentPolicyId}`);
  log(`PrizeKey:       ${prizeAddress}${isNew ? " (NEW — save PRIZE_ADMIN_PRIVATE_KEY above)" : ""}`);
  log(`Weekly amt:     ${PRIZE_WEEKLY_AMOUNT} base units (${Number(PRIZE_WEEKLY_AMOUNT) / 1_000_000} DUSDC)`);
  log(`\nEnv files updated:`);
  log(`  ${AGENTS_ENV}`);
  log(`  ${WEB_ENV}`);
}

main().catch((e) => err(e instanceof Error ? e.stack ?? e.message : String(e)));
