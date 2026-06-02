#!/usr/bin/env tsx
/**
 * Resume bootstrap: assume the package is already published (its
 * `Published.toml` reflects the current chain state) and finish the
 * remaining bootstrap steps:
 *
 *   1. init_fee_vault<DBUSDC>(admin_cap, vault_admin)  → shared FeeVault
 *   2. set PrizeAdmin pubkey on-chain
 *   3. create_pool<DBUSDC>(seed, week)               → shared PrizePool
 *   4. create_registry                                 → shared MarketRegistry
 *   5. create_vault<DBUSDC>(vlp_cap)                   → shared ProtocolVault
 *   6. create_policy(agent, budget, expiry)           → shared AgentPolicy
 *   7. write all new IDs back to .env / apps/web/.env.local
 *
 * Use this after a manual `sui client publish` if you don't want to
 * pay the publish gas twice. The full bootstrap is `bootstrap-gamification.ts`.
 *
 * Idempotency: each step checks the relevant env var first and
 * skips itself if the object already exists on-chain (or is
 * recorded locally). Re-runs are safe.
 *
 * `--only <step>` runs a single step (or a comma-separated set):
 *   fee_vault, prize_pubkey, prize_pool, registry, vault, policy
 * Useful for recovering from a partial run without re-doing everything.
 */
import { config as loadEnv } from "dotenv";
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
const PUBLISHED_TOML = join(PKG_DIR, "Published.toml");

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

// --only flag: comma-separated step list. Empty = run all.
const ONLY_FLAG = (() => {
  const arg = process.argv.find((a) => a.startsWith("--only="));
  if (!arg) return new Set<string>();
  return new Set(arg.slice("--only=".length).split(",").map((s) => s.trim()).filter(Boolean));
})();
function shouldRun(step: string): boolean {
  return ONLY_FLAG.size === 0 || ONLY_FLAG.has(step);
}

function log(msg: string) {
  console.log(`[resume] ${msg}`);
}
function err(msg: string): never {
  console.error(`[resume] ERROR: ${msg}`);
  process.exit(1);
}

function readPackageIdFromPublishedToml(): string {
  if (!existsSync(PUBLISHED_TOML)) {
    err(`No Published.toml at ${PUBLISHED_TOML}. Run sui client publish first.`);
  }
  const content = readFileSync(PUBLISHED_TOML, "utf-8");
  const match = content.match(/published-at\s*=\s*"(0x[a-f0-9]+)"/);
  if (!match) {
    err(`Could not find published-at in ${PUBLISHED_TOML}.`);
  }
  return match[1];
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

async function getSharedObjectIdFromTx(
  client: SuiGrpcClient,
  digest: string,
  typeMatch: string,
): Promise<string> {
  const r = await client.getTransaction({
    digest,
    include: { effects: true, objectTypes: true },
  });
  if (r.$kind !== "Transaction") err(`Transaction failed: ${digest}`);
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

async function main() {
  if (!process.env.AGENT_PRIVATE_KEY) {
    err("AGENT_PRIVATE_KEY is required (the deployer signer).");
  }
  const signer = keypairFromPrivateKey(process.env.AGENT_PRIVATE_KEY);
  const signerAddr = signer.getPublicKey().toSuiAddress();
  log(`Deployer: ${signerAddr}`);

  const packageId = readPackageIdFromPublishedToml();
  log(`Package ID (from Published.toml): ${packageId}`);

  const grpc = new SuiGrpcClient({ network: NETWORK as "testnet", baseUrl: RPC_URL });
  const txClient = createClient();

  // 1) init_fee_vault<DBUSDC> (idempotent: skip if FEE_VAULT_ID already set)
  let feeVaultId = process.env.FEE_VAULT_ID ?? "";
  if (shouldRun("fee_vault")) {
    if (feeVaultId) {
      log(`FeeVault already configured (${feeVaultId}); skipping init_fee_vault.`);
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
      log(`  ProtocolAdminCap: ${protocolAdminCapId}`);
      const initVaultDigest = await (async () => {
        const tx = new Transaction();
        tx.moveCall({
          target: `${packageId}::prediction_market::init_fee_vault`,
          typeArguments: [DUSDC_TYPE],
          arguments: [tx.object(protocolAdminCapId), tx.pure.address(signerAddr)],
        });
        const res = await executeTransaction(txClient, tx, signer);
        return res.digest;
      })();
      log(`  init_fee_vault: ${initVaultDigest}`);
      feeVaultId = await getSharedObjectIdFromTx(
        grpc,
        initVaultDigest,
        "::prediction_market::FeeVault<",
      );
      log(`FeeVault:       ${feeVaultId}`);
    }
  }

  // 2) Find StreakAdmin, StreakRegistry, PrizeAdmin from the publisher's
  //    owned + initial shared objects. They're created at publish time
  //    and shared, so we look them up by walking the recent shared
  //    objects the deployer can read. Simpler: re-list owned + find
  //    via the package's `published-as-of` epoch.
  log("Locating StreakAdmin / StreakRegistry / PrizeAdmin from publish effects...");
  // These are shared and won't be in owned objects. Easiest is to
  // grab the publish transaction digest from Published.toml history.
  // For this script we expect the user to have run bootstrap once
  // already, or to set the env vars below manually if they're known.
  //
  // Read each value lazily — `--only=prize_pool` doesn't need the
  // streak/prize-admin IDs at all, and the previous version of this
  // block hard-exited on any missing var, which made partial-resume
  // flows impossible. Each consumer below now guards its own use.
  const streakAdminId = process.env.STREAK_ADMIN_ID ?? "";
  const streakRegistryId = process.env.STREAK_REGISTRY_ID ?? "";
  const prizeAdminId = process.env.PRIZE_ADMIN_ID ?? "";
  log(`  StreakAdmin:    ${streakAdminId || "(unset — needed only for prize_pubkey / env writes)"}`);
  log(`  StreakRegistry: ${streakRegistryId || "(unset — needed only for env writes)"}`);
  log(`  PrizeAdmin:     ${prizeAdminId || "(unset — needed only for prize_pubkey)"}`);

  // 3) Set PrizeAdmin pubkey (idempotent — re-rotate if you rotate
  //    keys, but normally skip).
  let isNewPrizeKey = false;
  let prizePubkeyB64 = process.env.PRIZE_ADMIN_PUBKEY_B64 ?? "";
  if (shouldRun("prize_pubkey")) {
    if (!prizeAdminId) {
      err(
        "prize_pubkey step requires PRIZE_ADMIN_ID in .env. " +
          "Look up the shared PrizeAdmin object id from the package's publish effects and add it before re-running.",
      );
    }
    const existingKeyB64 = process.env.PRIZE_ADMIN_PRIVATE_KEY;
    const prizeKey = existingKeyB64
      ? Ed25519Keypair.fromSecretKey(existingKeyB64)
      : new Ed25519Keypair();
    isNewPrizeKey = !existingKeyB64;
    const prizePubkey = Array.from(prizeKey.getPublicKey().toRawBytes());
    prizePubkeyB64 = Buffer.from(prizePubkey).toString("base64");
    log(
      `Prize admin: ${prizeKey.getPublicKey().toSuiAddress()} (${isNewPrizeKey ? "NEW keypair generated" : "loaded from env"})`,
    );
    if (isNewPrizeKey) {
      const secretB64 = Buffer.from(prizeKey.getSecretKey()).toString("base64");
      log(`  SAVE THIS — PRIZE_ADMIN_PRIVATE_KEY (base64): ${secretB64}`);
    }
    log("Setting PrizeAdmin pubkey on-chain...");
    {
      const tx = new Transaction();
      tx.moveCall({
        target: `${packageId}::prize_pool::rotate_pubkey`,
        arguments: [tx.object(prizeAdminId), tx.pure.vector("u8", prizePubkey)],
      });
      const res = await executeTransaction(txClient, tx, signer);
      log(`  rotate_pubkey: ${res.digest}`);
    }
  } else {
    log("Skipping prize_pubkey (--only).");
  }

  // 4) Find DUSDC seed coin (idempotent — only mints if no coin exists)
  let seedCoinId: string | null = null;
  let prizePoolId = process.env.PRIZE_POOL_ID ?? "";
  if (shouldRun("prize_pool")) {
    if (prizePoolId) {
      log(`PrizePool already configured (${prizePoolId}); skipping create_pool.`);
    } else {
      log(`Looking for DUSDC coin >= ${PRIZE_WEEKLY_AMOUNT}...`);
      seedCoinId = await findDusdcCoin(grpc, signerAddr, PRIZE_WEEKLY_AMOUNT);
      if (!seedCoinId) {
        const treasuryCapId = process.env.DUSDC_TREASURY_CAP_ID;
        if (!treasuryCapId) {
          err(
            `No DUSDC coin >= ${PRIZE_WEEKLY_AMOUNT} in deployer wallet and DUSDC_TREASURY_CAP_ID is unset. ` +
              `Either fund the deployer with DUSDC or set DUSDC_TREASURY_CAP_ID and re-run.`,
          );
        }
        log(`  No seed coin — minting from TreasuryCap ${treasuryCapId}...`);
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
        if (!seedCoinId) err("Mint succeeded but no DUSDC coin appeared.");
      }
      log(`  seed coin: ${seedCoinId}`);

      // 5) Create PrizePool
      log("Creating PrizePool<DBUSDC>...");
      const createPoolDigest = await (async () => {
        const tx = new Transaction();
        tx.moveCall({
          target: `${packageId}::prize_pool::create_pool`,
          typeArguments: [DUSDC_TYPE],
          arguments: [tx.object(seedCoinId), tx.pure.u64(INITIAL_WEEK)],
        });
        const res = await executeTransaction(txClient, tx, signer);
        return res.digest;
      })();
      log(`  create_pool: ${createPoolDigest}`);
      prizePoolId = await getSharedObjectIdFromTx(
        grpc,
        createPoolDigest,
        "::prize_pool::PrizePool<",
      );
      log(`PrizePool:      ${prizePoolId}`);
    }
  } else {
    log("Skipping prize_pool (--only).");
  }

  // 6) Create MarketRegistry (idempotent)
  let marketRegistryId = process.env.MARKET_REGISTRY_ID ?? "";
  if (shouldRun("registry")) {
    if (marketRegistryId) {
      log(`MarketRegistry already configured (${marketRegistryId}); skipping.`);
    } else {
      log("Creating MarketRegistry...");
      const registryDigest = await (async () => {
        const tx = new Transaction();
        tx.moveCall({
          target: `${packageId}::registry::create_registry`,
          arguments: [],
        });
        const res = await executeTransaction(txClient, tx, signer);
        return res.digest;
      })();
      marketRegistryId = await getSharedObjectIdFromTx(
        grpc,
        registryDigest,
        "::registry::MarketRegistry",
      );
      log(`MarketRegistry: ${marketRegistryId}`);
    }
  } else {
    log("Skipping registry (--only).");
  }

  // 7) Create ProtocolVault<DBUSDC> (idempotent)
  let protocolVaultId = process.env.VAULT_OBJECT_ID ?? "";
  if (shouldRun("vault")) {
    if (protocolVaultId) {
      log(`ProtocolVault already configured (${protocolVaultId}); skipping.`);
    } else {
      log("Looking for VLP TreasuryCap in deployer wallet...");
      let vlpTreasuryCapId = process.env.VLP_TREASURY_CAP_ID ?? "";
      if (!vlpTreasuryCapId) {
        vlpTreasuryCapId = (await findOwnedObject(
          grpc,
          signerAddr,
          "::vlp::TreasuryCap",
        )) ?? "";
      }
      if (!vlpTreasuryCapId) {
        err(
          "No VLP TreasuryCap in deployer wallet (and VLP_TREASURY_CAP_ID not set). " +
            "Set VLP_TREASURY_CAP_ID in .env to skip the auto-lookup. " +
            "The vlp::init should have created one at publish.",
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
        return res.digest;
      })();
      protocolVaultId = await getSharedObjectIdFromTx(
        grpc,
        vaultDigest,
        "::vault::ProtocolVault<",
      );
      log(`ProtocolVault:  ${protocolVaultId}`);
    }
  } else {
    log("Skipping vault (--only).");
  }

  // 8) Create AgentPolicy (idempotent)
  let agentPolicyId = process.env.AGENT_POLICY_ID ?? "";
  if (shouldRun("policy")) {
    if (agentPolicyId) {
      log(`AgentPolicy already configured (${agentPolicyId}); skipping.`);
    } else {
      const policyBudget = BigInt(process.env.AGENT_MAX_BUDGET_USDC ?? "500") * 1_000_000n;
      const policyExpiryMs = Date.now() + 365 * 86_400_000;
      log(`Creating AgentPolicy (budget=${policyBudget}, expires=${new Date(policyExpiryMs).toISOString()})...`);
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
        return res.digest;
      })();
      agentPolicyId = await getSharedObjectIdFromTx(
        grpc,
        policyDigest,
        "::agent_policy::AgentPolicy",
      );
      log(`AgentPolicy:    ${agentPolicyId}`);
    }
  } else {
    log("Skipping policy (--only).");
  }

  // 9) Write env updates — surface matches bootstrap-gamification.ts
  //    so a re-run via either script produces the same .env keys.
  //
  // Only include shared-object-id keys when the value is non-empty,
  // so a partial resume (e.g. `--only=prize_pool` from a fresh config)
  // doesn't clobber good values in .env with empty strings. Steps that
  // actually wrote a new id (fee_vault, prize_pool, registry, vault,
  // policy) are always present in their respective `let` bindings.
  const agentsUpdates: Record<string, string> = {
    AGENT_POLICY_PACKAGE_ID: packageId,
    MARKET_PACKAGE_ID: packageId,
    NEXT_PUBLIC_MARKET_PACKAGE_ID: packageId,
    PRIZE_WEEKLY_AMOUNT: PRIZE_WEEKLY_AMOUNT.toString(),
    PRIZE_ADMIN_PUBKEY_B64: prizePubkeyB64,
    DUSDC_PACKAGE_ID: DUSDC_TYPE.split("::")[0],
  };
  if (streakRegistryId) agentsUpdates.STREAK_REGISTRY_ID = streakRegistryId;
  if (streakAdminId) agentsUpdates.STREAK_ADMIN_ID = streakAdminId;
  if (prizeAdminId) agentsUpdates.PRIZE_ADMIN_ID = prizeAdminId;
  if (prizePoolId) agentsUpdates.PRIZE_POOL_ID = prizePoolId;
  if (marketRegistryId) agentsUpdates.MARKET_REGISTRY_ID = marketRegistryId;
  if (protocolVaultId) agentsUpdates.VAULT_OBJECT_ID = protocolVaultId;
  if (feeVaultId) agentsUpdates.FEE_VAULT_ID = feeVaultId;
  if (agentPolicyId) agentsUpdates.AGENT_POLICY_ID = agentPolicyId;
  if (process.env.DUSDC_TREASURY_CAP_ID) {
    agentsUpdates.DUSDC_TREASURY_CAP_ID = process.env.DUSDC_TREASURY_CAP_ID;
  }
  if (isNewPrizeKey) {
    // `getSecretKey()` returns the bech32 "suiprivkey1…" string in
    // Mysten SDK 2.x. The SDK's `Ed25519Keypair.fromSecretKey` accepts
    // that form directly, so write it as-is to the env.
    const secretStr = prizeKey.getSecretKey() as unknown as string;
    agentsUpdates.PRIZE_ADMIN_PRIVATE_KEY = secretStr;
    log(`  Prize admin secret (suiprivkey1…): ${secretStr}`);
  }
  // REFERRAL_TREASURY_ADDRESS — same default as bootstrap-gamification.
  // The web frontend reads NEXT_PUBLIC_REFERRAL_TREASURY_ADDRESS for
  // sweep destinations; if it's missing the SDK falls back to the
  // zero address and sweeps are routed nowhere.
  agentsUpdates.REFERRAL_TREASURY_ADDRESS = process.env.REFERRAL_TREASURY_ADDRESS ?? signerAddr;
  updateEnv(AGENTS_ENV, agentsUpdates);
  // Web env surface — must mirror bootstrap-gamification.ts so a
  // re-run via either script leaves a consistent apps/web/.env.local.
  // Per-market pool id is set by the market-creator agent on first
  // market creation; we write a placeholder here that the agent
  // overwrites. As with the agentsUpdates above, shared-object ids
  // are only written when truthy so partial resumes don't clobber.
  const webUpdates: Record<string, string> = {
    NEXT_PUBLIC_MARKET_PACKAGE_ID: packageId,
    NEXT_PUBLIC_AGENT_POLICY_PACKAGE_ID: packageId,
    NEXT_PUBLIC_PRIZE_WEEKLY_AMOUNT: PRIZE_WEEKLY_AMOUNT.toString(),
    NEXT_PUBLIC_DUSDC_PACKAGE_ID: DUSDC_TYPE.split("::")[0],
    NEXT_PUBLIC_ADMIN_ADDRESS: signerAddr,
    NEXT_PUBLIC_DEEPBOOK_POOL_KEY: "PREDICT_YES_DUSDC",
    NEXT_PUBLIC_DEEPBOOK_YES_COIN_TYPE: `${packageId}::prediction_market::YES`,
    NEXT_PUBLIC_DEEPBOOK_QUOTE_COIN_TYPE: DUSDC_TYPE,
    NEXT_PUBLIC_DEEPBOOK_YES_COIN_SCALAR: "1000000",
    NEXT_PUBLIC_DEEPBOOK_QUOTE_COIN_SCALAR: "1000000",
    NEXT_PUBLIC_DEEP_TYPE:
      process.env.NEXT_PUBLIC_DEEP_TYPE ?? process.env.DEEP_TYPE ?? "",
    NEXT_PUBLIC_REFERRAL_TREASURY_ADDRESS:
      process.env.NEXT_PUBLIC_REFERRAL_TREASURY_ADDRESS ??
      process.env.REFERRAL_TREASURY_ADDRESS ??
      signerAddr,
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
  updateEnv(WEB_ENV, webUpdates);

  log("\n=== Resume complete ===");
  log(`Package:        ${packageId}`);
  log(`FeeVault:       ${feeVaultId}`);
  log(`PrizePool:      ${prizePoolId}`);
  log(`MarketRegistry: ${marketRegistryId}`);
  log(`ProtocolVault:  ${protocolVaultId}`);
  log(`AgentPolicy:    ${agentPolicyId}`);
  log(`Weekly amt:     ${PRIZE_WEEKLY_AMOUNT} (${Number(PRIZE_WEEKLY_AMOUNT) / 1_000_000} DUSDC)`);
}

main().catch((e) => err(e instanceof Error ? e.stack ?? e.message : String(e)));
