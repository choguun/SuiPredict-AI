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
  DEEP_TYPE,
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

/**
 * Read `Published.toml` and return the `published-at` package id, or
 * `""` if the file is missing or has no published entry. Used to make
 * the bootstrap idempotent — if the package is already published we
 * skip `sui client publish` and reuse the existing object IDs that
 * step-1a..7 re-discover from the chain.
 */
function readPublishedAt(): string {
  const publishedToml = join(PKG_DIR, "Published.toml");
  if (!existsSync(publishedToml)) return "";
  const text = readFileSync(publishedToml, "utf-8");
  const m = text.match(/^\s*published-at\s*=\s*"([^"]+)"/m);
  return m?.[1] ?? "";
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

async function findOwnedObject(
  client: SuiGrpcClient,
  owner: string,
  typeSuffix: string,
): Promise<string | null> {
  let cursor: string | null | undefined = undefined;
  do {
    const page = await client.listOwnedObjects({
      owner,
      cursor: cursor ?? null,
      limit: 50,
    });
    for (const obj of page.objects) {
      if (obj.type?.includes(typeSuffix) && obj.objectId) {
        return obj.objectId;
      }
    }
    cursor = page.cursor ?? null;
  } while (cursor);
  return null;
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

  // 1) Publish — but only if the package hasn't been published yet. If
  // `Published.toml` already has a `published-at`, reuse it and skip
  // the publish step. Otherwise we'd silently create a second package
  // on every re-run, with duplicate StreakAdmin / PrizePool / FeeVault
  // shared objects that nothing on the client knows which to trust.
  const existingPkgId = readPublishedAt();
  let packageId: string;
  let objects: CreatedObject[];
  if (existingPkgId) {
    log(`Reusing existing package at ${existingPkgId} (Published.toml).`);
    packageId = existingPkgId;
    // No fresh object list from a publish; the step-1a..7 code paths
    // re-discover shared objects by querying the chain.
    objects = [];
  } else {
    const out = runPublish();
    packageId = out.packageId;
    objects = out.objects;
    log(`Package ID: ${packageId}`);
  }

  // Initialize gRPC + tx clients up front (used by step 1a + 4 + 5...).
  const grpc = new SuiGrpcClient({ network: NETWORK as "testnet", baseUrl: RPC_URL });
  const txClient = createClient();

  // 1a) init_fee_vault<DBUSDC>: prediction_market::init transfers the
  //     ProtocolAdminCap to the publisher but does not share a
  //     FeeVault<Q> (the type Q is unknown at init). We need to call
  //     `init_fee_vault<DBUSDC>(admin_cap, vault_admin)` once post-publish
  //     to create and share the vault. The vault_admin is the same
  //     signer — it is the address authorized to call withdraw_fees
  //     later.
  //
  //     Idempotency: if `FEE_VAULT_ID` is already in .env, the
  //     previous bootstrap left a valid shared object and a re-run
  //     would mint a SECOND FeeVault, splitting the protocol fees
  //     between two vaults (only the one in .env can be withdrawn
  //     from). The deployer would never see the funds in the
  //     abandoned vault. Refuse to create a duplicate.
  let feeVaultId = process.env.FEE_VAULT_ID ?? "";
  if (feeVaultId) {
    log(`FEE_VAULT_ID already set: ${feeVaultId} — re-using (skip init_fee_vault).`);
  } else {
    log("Creating FeeVault<DBUSDC> via init_fee_vault...");
    const protocolAdminCapId = await findOwnedObject(
      grpc,
      signerAddr,
      "::prediction_market::ProtocolAdminCap",
    );
    if (!protocolAdminCapId) {
      err(
        "No ProtocolAdminCap found in deployer wallet. Was the package just published? " +
          "prediction_market::init() should have transferred one to the publisher.",
      );
    }
    let initVaultDigest = "";
    {
      const tx = new Transaction();
      tx.moveCall({
        target: `${packageId}::prediction_market::init_fee_vault`,
        typeArguments: [DUSDC_TYPE],
        arguments: [tx.object(protocolAdminCapId), tx.pure.address(signerAddr)],
      });
      const res = await executeTransaction(txClient, tx, signer);
      initVaultDigest = res.digest;
      log(`  init_fee_vault: ${initVaultDigest}`);
    }
    feeVaultId = await getSharedObjectIdFromTx(
      grpc,
      initVaultDigest,
      "::prediction_market::FeeVault<",
    );
    log(`FeeVault:       ${feeVaultId}`);
  }

  // 2) Extract shared objects created at init
  const streakAdminId = findSharedObject(objects, "::streak_system::StreakAdmin");
  const streakRegistryId = findSharedObject(
    objects,
    "::streak_system::StreakRegistry",
  );
  const prizeAdminId = findSharedObject(objects, "::prize_pool::PrizeAdmin");
  // ProfileRegistry is shared by `user_profile::init` at module publish
  // time (no quote-coin type parameter, unlike FeeVault which needs a
  // post-publish init call). The web `/settings` page reads
  // `NEXT_PUBLIC_PROFILE_REGISTRY_ID` to build `create_profile` PTBs;
  // without this write the user has no way to mint a UserProfile.
  const profileRegistryId = findSharedObject(
    objects,
    "::user_profile::ProfileRegistry",
  );
  // prediction_market::init does NOT share a FeeVault<Q> at publish
  // time — the quote-coin type Q is unknown until the deployer picks
  // one. We must call `init_fee_vault<DBUSDC>(admin_cap, vault_admin)`
  // after publish to create and share the vault. The ProtocolAdminCap
  // is transferred to the publisher, so we look it up by walking the
  // publisher's owned objects.
  log(`StreakAdmin:    ${streakAdminId}`);
  log(`StreakRegistry: ${streakRegistryId}`);
  log(`PrizeAdmin:     ${prizeAdminId}`);
  log(`ProfileReg:     ${profileRegistryId}`);

  // 3) Prize admin keypair
  //
  // SAFETY: bootstrap is supposed to run once per package, but in
  // practice operators re-run it from a fresh machine after a
  // disaster. If PRIZE_ADMIN_PUBKEY_B64 is in .env (an earlier run
  // succeeded and wrote the value) but PRIZE_ADMIN_PRIVATE_KEY is
  // missing (the new machine doesn't have the secret), a naive
  // `loadOrCreatePrizeKeypair` would generate a fresh key, and the
  // unconditional rotate_pubkey on the next step would overwrite the
  // on-chain pubkey. The original signing server — still holding the
  // old secret — would produce signatures that fail on-chain
  // verification, breaking every future claim. The guards below
  // refuse to rotate when:
  //   (a) PRIZE_ADMIN_PUBKEY_B64 is set in .env (prior run recorded it)
  //   (b) PRIZE_ADMIN_PRIVATE_KEY is missing on the new machine
  //   (c) the operator has not explicitly opted in via --rotate-prize-pubkey
  // and bail with a clear error. We also bail if the loaded/new
  // keypair's pubkey doesn't match the recorded one, so a stale .env
  // entry can't silently drive a rotation.
  const ROTATE_PRIZE_PUBKEY = process.argv.includes("--rotate-prize-pubkey");
  const existingKeyB64 = process.env.PRIZE_ADMIN_PRIVATE_KEY;
  const existingPubkeyB64 = process.env.PRIZE_ADMIN_PUBKEY_B64 ?? "";
  if (!existingKeyB64 && existingPubkeyB64 && !ROTATE_PRIZE_PUBKEY) {
    err(
      "Refusing to rotate prize admin pubkey: PRIZE_ADMIN_PUBKEY_B64 is set in .env " +
        `(${existingPubkeyB64.slice(0, 16)}…) but PRIZE_ADMIN_PRIVATE_KEY is missing. ` +
        "Generating a new keypair would clobber the on-chain pubkey and invalidate " +
        "the signing key on the original server. Either:\n" +
        "  • restore PRIZE_ADMIN_PRIVATE_KEY in .env and re-run, OR\n" +
        "  • pass --rotate-prize-pubkey to forcibly generate a new key and rotate on-chain " +
        "(only when you have intentionally lost access to the previous key).",
    );
  }
  const { keypair: prizeKey, isNew } = loadOrCreatePrizeKeypair();
  const prizePubkey = Array.from(prizeKey.getPublicKey().toRawBytes());
  const newPubkeyB64 = Buffer.from(prizePubkey).toString("base64");
  if (existingPubkeyB64 && newPubkeyB64 !== existingPubkeyB64) {
    err(
      `Prize admin pubkey mismatch: the loaded/generated key produces a different pubkey ` +
        `(${newPubkeyB64.slice(0, 16)}…) than the one recorded in PRIZE_ADMIN_PUBKEY_B64 ` +
        `(${existingPubkeyB64.slice(0, 16)}…). Continuing would silently overwrite the on-chain ` +
        "pubkey with a key the original signing server doesn't have. " +
        "Either fix PRIZE_ADMIN_PRIVATE_KEY, or pass --rotate-prize-pubkey to accept the new key.",
    );
  }
  const prizePubkeyB64 = newPubkeyB64;
  const prizeAddress = prizeKey.getPublicKey().toSuiAddress();
  log(
    `Prize admin: ${prizeAddress} (${isNew ? "NEW keypair generated" : "loaded from env"})`,
  );
  if (isNew) {
    // Mysten SDK 2.x: getSecretKey() returns the bech32
    // "suiprivkey1…" string, which Ed25519Keypair.fromSecretKey
    // accepts directly. Save that form, not its base64.
    const secretStr = prizeKey.getSecretKey() as unknown as string;
    log(`  SAVE THIS — PRIZE_ADMIN_PRIVATE_KEY: ${secretStr}`);
  }

  // 4) Set pubkey on-chain. Skipped when the on-chain pubkey already
  // matches the env's recorded value — re-running `rotate_pubkey`
  // costs gas and produces the same bytes. The guards above ensure
  // we never get here with a stale secret.
  if (existingPubkeyB64 === prizePubkeyB64) {
    log("On-chain PrizeAdmin pubkey already matches env; skipping rotate_pubkey.");
  } else {
    log("Setting PrizeAdmin pubkey on-chain...");
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

  // 6) Create the prize pool.
  //
  //    Idempotency: if `PRIZE_POOL_ID` is already in .env, the prior
  //    bootstrap left a valid shared pool. A re-run would mint a
  //    SECOND prize pool and seed it with a fresh `seedCoinId`,
  //    stranding the seed coin in an abandoned pool that no claim
  //    flow can ever pay out. Skip the creation step entirely.
  let prizePoolId = process.env.PRIZE_POOL_ID ?? "";
  if (prizePoolId) {
    log(
      `PRIZE_POOL_ID already set: ${prizePoolId} — re-using (skip create_pool).`,
    );
  } else {
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

    // Find the new shared pool from the create_pool transaction's
    // effects (the pool is shared via `transfer::share_object`, so it
    // is not owned by the deployer and won't appear in
    // `listOwnedObjects`).
    log("Fetching PrizePool object ID from create_pool effects...");
    prizePoolId = await getSharedObjectIdFromTx(
      grpc,
      createPoolDigest,
      "::prize_pool::PrizePool<",
    );
    log(`PrizePool:      ${prizePoolId}`);
  }

  // 7a) Create the MarketRegistry (not auto-created on publish).
  //     Idempotency: skip if `MARKET_REGISTRY_ID` is in .env.
  let marketRegistryId = process.env.MARKET_REGISTRY_ID ?? "";
  if (marketRegistryId) {
    log(
      `MARKET_REGISTRY_ID already set: ${marketRegistryId} — re-using (skip create_registry).`,
    );
  } else {
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
    marketRegistryId = await getSharedObjectIdFromTx(
      grpc,
      registryDigest,
      "::registry::MarketRegistry",
    );
    log(`MarketRegistry: ${marketRegistryId}`);
  }

  // 7b) Create the ProtocolVault<DBUSDC> from the deployer's VLP TreasuryCap.
  //     Idempotency: skip if `VAULT_OBJECT_ID` is in .env. The
  //     TreasuryCap is consumed by `create_vault`, so a re-run
  //     without this guard would also strand the VLP mint authority
  //     in an abandoned vault.
  let protocolVaultId = process.env.VAULT_OBJECT_ID ?? "";
  if (protocolVaultId) {
    log(
      `VAULT_OBJECT_ID already set: ${protocolVaultId} — re-using (skip create_vault).`,
    );
  } else {
    log("Looking for VLP TreasuryCap in deployer wallet...");
    let vlpTreasuryCapId = process.env.VLP_TREASURY_CAP_ID ?? "";
    if (!vlpTreasuryCapId) {
      vlpTreasuryCapId = (await findVlpTreasuryCap(grpc, signerAddr)) ?? "";
    }
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
    protocolVaultId = await getSharedObjectIdFromTx(
      grpc,
      vaultDigest,
      "::vault::ProtocolVault<",
    );
    log(`ProtocolVault:  ${protocolVaultId}`);
  }

  // 7c) Create an AgentPolicy so the agent hot wallet can act with a
  //     capped budget. Use AGENT_MAX_BUDGET_USDC * 10^6 (DUSDC has 6
  //     decimals) and a 1-year expiry.
  //     Idempotency: skip if `AGENT_POLICY_ID` is in .env. The policy
  //     is created at a fresh expiry on every `create_policy` call,
  //     so a re-run would reset the budget window and split the
  //     operator's audit trail between two policies.
  let agentPolicyId = process.env.AGENT_POLICY_ID ?? "";
  if (agentPolicyId) {
    log(
      `AGENT_POLICY_ID already set: ${agentPolicyId} — re-using (skip create_policy).`,
    );
  } else {
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
    agentPolicyId = await getSharedObjectIdFromTx(
      grpc,
      policyDigest,
      "::agent_policy::AgentPolicy",
    );
    log(`AgentPolicy:    ${agentPolicyId}`);
  }

  // 7b) Create a DeepBook V3 BalanceManager for the agent signer so
  // the market-maker can trade without a one-off setup step. The
  // BalanceManager is shared (so the agent key can deposit / place
  // orders) and the ID is written to .env. We use a placeholder
  // prediction-market config — the BalanceManager itself is
  // pool-agnostic, and the prediction pool key is set at
  // market-create time, not here.
  //
  // `AGENT_MANAGER_ID` (a separate on-chain manager for the
  // RiskMonitor) does not exist as a contract object in the
  // current published package — only `AgentPolicy` is on-chain.
  // We deliberately leave it unset; the validator marks it
  // `required: false`, and the RiskMonitor degrades to
  // log-only when the env is empty.
  let balanceManagerId = process.env.BALANCE_MANAGER_ID ?? "";
  if (!balanceManagerId) {
    try {
      log("Creating DeepBook V3 BalanceManager for agent...");
      const {
        buildDeepBookCreateBalanceManagerTx,
        createPredictionDeepBookClient,
      } = await import("@suipredict/sdk");
      const { SuiGrpcClient } = await import("@mysten/sui/grpc");
      const deepbookClient = new SuiGrpcClient({
        url: process.env.SUI_GRPC_URL ?? "https://fullnode.testnet.sui.io:443",
        network: "testnet",
      });
      const dbClient = createPredictionDeepBookClient({
        client: deepbookClient,
        address: signerAddr,
        market: {
          poolKey: "PREDICT_YES_DUSDC",
          poolId: "0x0",
          baseCoinType:
            `${packageId}::prediction_market::YES` as `${string}::${string}::${string}`,
          quoteCoinType: DUSDC_TYPE,
          baseScalar: 1_000_000,
          quoteScalar: 1_000_000,
        },
      });
      const tx = buildDeepBookCreateBalanceManagerTx(dbClient, signerAddr);
      const res = await executeTransaction(txClient, tx, signer);
      const id = await getSharedObjectIdFromTx(
        grpc,
        res.digest,
        "balance_manager::BalanceManager",
      );
      if (id) {
        balanceManagerId = id;
        log(`  BalanceManager: ${balanceManagerId}`);
      }
    } catch (err) {
      console.warn(
        `[bootstrap] BalanceManager creation failed: ${err instanceof Error ? err.message : String(err)}. ` +
          "Market-maker will retry on first tick and write BALANCE_MANAGER_ID_FILE.",
      );
    }
  }

  // 8) Write env updates
  //
  // Only include shared-object-id keys when the value is non-empty,
  // so a partial bootstrap (e.g. a step that gas-exhausted and left
  // the ID blank) doesn't clobber a good value in .env with an empty
  // string. Same conditional-write pattern as the round-7 fix in
  // resume-bootstrap.ts:241-251.
  const agentsUpdates: Record<string, string> = {
    AGENT_POLICY_PACKAGE_ID: packageId,
    MARKET_PACKAGE_ID: packageId,
    NEXT_PUBLIC_MARKET_PACKAGE_ID: packageId,
    PRIZE_WEEKLY_AMOUNT: PRIZE_WEEKLY_AMOUNT.toString(),
    DUSDC_PACKAGE_ID: DUSDC_TYPE.split("::")[0],
  };
  // Conditional write: only set PRIZE_ADMIN_PUBKEY_B64 when we have
  // a non-empty value. If the pubkey step was skipped (matching
  // on-chain already, or a guard bailed), there's nothing to record.
  if (prizePubkeyB64) {
    agentsUpdates.PRIZE_ADMIN_PUBKEY_B64 = prizePubkeyB64;
  }
  if (streakRegistryId) agentsUpdates.STREAK_REGISTRY_ID = streakRegistryId;
  if (streakAdminId) agentsUpdates.STREAK_ADMIN_ID = streakAdminId;
  if (prizePoolId) agentsUpdates.PRIZE_POOL_ID = prizePoolId;
  if (prizeAdminId) agentsUpdates.PRIZE_ADMIN_ID = prizeAdminId;
  if (marketRegistryId) agentsUpdates.MARKET_REGISTRY_ID = marketRegistryId;
  if (protocolVaultId) agentsUpdates.VAULT_OBJECT_ID = protocolVaultId;
  // ProfileRegistry is shared by `user_profile::init` — write both
  // the agents-side and the public web-side vars so the user_profile
  // PTB builders (create_profile, set_country_code, set_forecaster_kind)
  // can resolve the registry from any process.
  if (profileRegistryId) agentsUpdates.NEXT_PUBLIC_PROFILE_REGISTRY_ID = profileRegistryId;
  if (feeVaultId) agentsUpdates.FEE_VAULT_ID = feeVaultId;
  if (agentPolicyId) agentsUpdates.AGENT_POLICY_ID = agentPolicyId;
  if (balanceManagerId) {
    agentsUpdates.BALANCE_MANAGER_ID = balanceManagerId;
  }
  // REFERRAL_TREASURY_ADDRESS — destination for DeepBook referral
  // sweeps and protocol fees. The SDK reads it from
  // REFERRAL_TREASURY_ADDRESS (agents) or
  // NEXT_PUBLIC_REFERRAL_TREASURY_ADDRESS (web). Default to the
  // deployer signer — they're the protocol owner. Operators can
  // override this in .env if their treasury is a multisig.
  agentsUpdates.REFERRAL_TREASURY_ADDRESS = signerAddr;
  if (process.env.DUSDC_TREASURY_CAP_ID) {
    agentsUpdates.DUSDC_TREASURY_CAP_ID = process.env.DUSDC_TREASURY_CAP_ID;
  }
  if (isNew) {
    const secretStr = prizeKey.getSecretKey() as unknown as string;
    agentsUpdates.PRIZE_ADMIN_PRIVATE_KEY = secretStr;
  }
  updateEnv(AGENTS_ENV, agentsUpdates);
  // Web env writes — same conditional pattern. Per-market pool id is
  // set by the market-creator agent on first market creation; we write
  // a placeholder here that the agent overwrites.
  const webUpdates: Record<string, string> = {
    NEXT_PUBLIC_MARKET_PACKAGE_ID: packageId,
    NEXT_PUBLIC_AGENT_POLICY_PACKAGE_ID: packageId,
    NEXT_PUBLIC_PRIZE_WEEKLY_AMOUNT: PRIZE_WEEKLY_AMOUNT.toString(),
    NEXT_PUBLIC_DUSDC_PACKAGE_ID: DUSDC_TYPE.split("::")[0],
    NEXT_PUBLIC_ADMIN_ADDRESS: signerAddr,
    // DeepBook defaults — POOL_KEY and the YES/QUOTE coin-type strings
    // are protocol-wide constants (see packages/sdk/src/deepbook/client.ts).
    // They are written here so the markets page can use them as the
    // pre-market-pool fallback. Per-market POOL_IDs are still written
    // by the market-creator agent when it spins up a new DeepBook pool.
    NEXT_PUBLIC_DEEPBOOK_POOL_KEY: "PREDICT_YES_DUSDC",
    NEXT_PUBLIC_DEEPBOOK_YES_COIN_TYPE: `${packageId}::prediction_market::YES`,
    NEXT_PUBLIC_DEEPBOOK_QUOTE_COIN_TYPE: DUSDC_TYPE,
    NEXT_PUBLIC_DEEPBOOK_YES_COIN_SCALAR: "1000000",
    NEXT_PUBLIC_DEEPBOOK_QUOTE_COIN_SCALAR: "1000000",
    NEXT_PUBLIC_DEEP_TYPE: process.env.DEEP_TYPE ?? DEEP_TYPE,
    // AGENTS_URL is a deploy-time hint; production should set it to the
    // public agents URL (the local default is the dev fallback).
    NEXT_PUBLIC_AGENTS_URL:
      process.env.NEXT_PUBLIC_AGENTS_URL ?? "http://localhost:3001",
  };
  if (streakRegistryId) webUpdates.NEXT_PUBLIC_STREAK_REGISTRY_ID = streakRegistryId;
  if (streakAdminId) webUpdates.NEXT_PUBLIC_STREAK_ADMIN_ID = streakAdminId;
  if (prizePoolId) webUpdates.NEXT_PUBLIC_PRIZE_POOL_ID = prizePoolId;
  if (prizeAdminId) webUpdates.NEXT_PUBLIC_PRIZE_ADMIN_ID = prizeAdminId;
  if (feeVaultId) webUpdates.NEXT_PUBLIC_FEE_VAULT_ID = feeVaultId;
  if (protocolVaultId) webUpdates.NEXT_PUBLIC_VAULT_OBJECT_ID = protocolVaultId;
  if (agentPolicyId) webUpdates.NEXT_PUBLIC_AGENT_POLICY_ID = agentPolicyId;
  if (profileRegistryId) {
    webUpdates.NEXT_PUBLIC_PROFILE_REGISTRY_ID = profileRegistryId;
  }
  // Treasury address — must match the agents REFERRAL_TREASURY_ADDRESS
  // so the web frontend's REFERRAL_TREASURY_ADDRESS SDK constant
  // resolves to the same on-chain destination. Honor an existing env
  // override if the operator pre-configured a multisig treasury.
  webUpdates.NEXT_PUBLIC_REFERRAL_TREASURY_ADDRESS =
    process.env.NEXT_PUBLIC_REFERRAL_TREASURY_ADDRESS ??
    process.env.REFERRAL_TREASURY_ADDRESS ??
    signerAddr;
  updateEnv(WEB_ENV, webUpdates);

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
  log(`ProfileReg:     ${profileRegistryId}`);
  log(`PrizeKey:       ${prizeAddress}${isNew ? " (NEW — save PRIZE_ADMIN_PRIVATE_KEY above)" : ""}`);
  log(`Weekly amt:     ${PRIZE_WEEKLY_AMOUNT} base units (${Number(PRIZE_WEEKLY_AMOUNT) / 1_000_000} DUSDC)`);
  log(`\nEnv files updated:`);
  log(`  ${AGENTS_ENV}`);
  log(`  ${WEB_ENV}`);
}

main().catch((e) => err(e instanceof Error ? e.stack ?? e.message : String(e)));
