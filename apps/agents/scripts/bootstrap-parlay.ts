/**
 * Bootstrap script for the parlay pool.
 *
 * Creates a shared `ParlayPool<DBUSDC>` on the published
 * `suipredict_agent_policy` package, optionally seeds it with a
 * starting balance, and writes the new pool ID to `.env` and
 * `apps/web/.env.local` so the web UI and the indexer worker can
 * pick it up.
 *
 * Usage:
 *   pnpm --filter @suipredict/agents bootstrap-parlay
 *
 * Required env (in `.env`):
 *   AGENT_PRIVATE_KEY     — base58 ed25519 secret; the deployer/signer.
 *   AGENT_POLICY_PACKAGE_ID — the published package id
 *                              (written by `bootstrap-gamification`).
 *   NEXT_PUBLIC_PARLAY_MAX_PAYOUT_BPS — cap for the per-parlay
 *                              multiplier (e.g. 50_000 = 5x).
 *                              Defaults to 50_000.
 *   PARLAY_SEED_AMOUNT     — optional. Base-units of dUSDC to seed
 *                              the pool with (1_000_000 = 1 DUSDC).
 *                              Defaults to 0 (no seed).
 *   SUI_NETWORK            — defaults to "testnet".
 *
 * Idempotency: if `PARLAY_POOL_ID` is already in `.env`, the script
 * re-uses it. The web/env `NEXT_PUBLIC_PARLAY_POOL_ID` is the
 * public-facing read of the same object.
 */
import { config as loadEnv } from "dotenv";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";
import { Transaction } from "@mysten/sui/transactions";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import {
  buildCreateParlayPoolTx,
  buildFundParlayPoolTx,
  buildSetMaxPayoutBpsTx,
  createClient,
  DUSDC_TYPE,
  executeTransaction,
  keypairFromPrivateKey,
  readParlayMaxPayoutBps,
} from "@suipredict/sdk";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../..");
const AGENTS_ENV = resolve(REPO_ROOT, ".env");
const WEB_ENV = resolve(REPO_ROOT, "apps/web/.env.local");

loadEnv({ path: AGENTS_ENV });

const NETWORK = (process.env.SUI_NETWORK ?? "testnet") as
  | "testnet"
  | "mainnet"
  | "devnet"
  | "localnet";
const RPC_URL = getJsonRpcFullnodeUrl(NETWORK);

const PKG = process.env.AGENT_POLICY_PACKAGE_ID ?? "";
const MAX_PAYOUT_BPS = BigInt(
  process.env.NEXT_PUBLIC_PARLAY_MAX_PAYOUT_BPS ?? "50000",
);
const SEED_AMOUNT = BigInt(process.env.PARLAY_SEED_AMOUNT ?? "0");
const EXISTING_POOL = process.env.PARLAY_POOL_ID ?? "";

function log(msg: string) {
  console.log(`[bootstrap-parlay] ${msg}`);
}
function err(msg: string): never {
  console.error(`[bootstrap-parlay] ERROR: ${msg}`);
  process.exit(1);
}

function updateEnv(path: string, updates: Record<string, string>) {
  let content = existsSync(path) ? readFileSync(path, "utf-8") : "";
  for (const [k, v] of Object.entries(updates)) {
    const re = new RegExp(`^${k}=.*$`, "m");
    if (re.test(content)) {
      content = content.replace(re, `${k}=${v}`);
    } else {
      content += `\n${k}=${v}\n`;
    }
  }
  writeFileSync(path, content);
}

async function findOwnedDusdcCoin(
  client: SuiJsonRpcClient,
  owner: string,
  minBalance: bigint,
): Promise<string | null> {
  const { objects } = await client.core.listCoins({
    owner,
    coinType: DUSDC_TYPE,
  });
  const sorted = objects.sort((a, b) =>
    BigInt(b.balance) > BigInt(a.balance) ? 1 : -1,
  );
  const hit = sorted.find((c) => BigInt(c.balance) >= minBalance);
  return hit?.objectId ?? null;
}

async function findSharedObjectId(
  client: SuiJsonRpcClient,
  digest: string,
  typeFragment: string,
): Promise<string | null> {
  // Wait briefly for the indexer to surface the shared object, then
  // walk the tx effects. Matches the existing bootstrap-gamification
  // pattern (see `getSharedObjectIdFromTx` there).
  for (let i = 0; i < 10; i++) {
    const res = await client.getTransactionBlock({
      digest,
      options: { showObjectChanges: true },
    });
    const changes = res.objectChanges ?? [];
    const found = changes.find(
      (c) =>
        c.type === "created" &&
        typeof c.objectType === "string" &&
        c.objectType.includes(typeFragment),
    );
    if (found?.objectId) return found.objectId;
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

async function main() {
  if (!PKG) {
    err(
      "AGENT_POLICY_PACKAGE_ID is not set in .env. Run `bootstrap-gamification` first.",
    );
  }
  const sk = process.env.AGENT_PRIVATE_KEY;
  if (!sk) {
    err("AGENT_PRIVATE_KEY is not set in .env. Cannot sign bootstrap tx.");
  }
  const signer: Ed25519Keypair = keypairFromPrivateKey(sk);
  const signerAddr = signer.getPublicKey().toSuiAddress();
  const client = new SuiJsonRpcClient({ url: RPC_URL, network: NETWORK });
  const txClient = createClient(RPC_URL);

  log(`Network:        ${NETWORK}`);
  log(`Package:        ${PKG}`);
  log(`Deployer:       ${signerAddr}`);
  log(`Max payout:     ${MAX_PAYOUT_BPS.toString()} bps`);
  log(`Seed amount:    ${SEED_AMOUNT.toString()}`);

  let poolId = EXISTING_POOL;
  if (poolId) {
    log(`PARLAY_POOL_ID already set: ${poolId} — re-using.`);
    // Sync the on-chain cap to the env's MAX_PAYOUT_BPS. Without this,
    // an operator who bumps `NEXT_PUBLIC_PARLAY_MAX_PAYOUT_BPS` in
    // `.env` would have the web UI honor the new value but the chain
    // keep the old cap, surfacing as EPayoutTooLarge on legitimate
    // picks. Reading-then-writing is cheap (one getObject + one PTB)
    // and idempotent. If the read fails (RPC outage, freshly
    // migrated chain) we log and skip — the operator can still drive
    // the update through the /admin "Set parlay max payout cap" card.
    try {
      const onChainCap = await readParlayMaxPayoutBps(txClient, poolId);
      if (onChainCap !== MAX_PAYOUT_BPS) {
        log(
          `On-chain cap is ${onChainCap.toString()} bps, env wants ` +
            `${MAX_PAYOUT_BPS.toString()} bps — syncing…`,
        );
        const tx = buildSetMaxPayoutBpsTx(
          poolId,
          MAX_PAYOUT_BPS,
          DUSDC_TYPE,
        );
        const res = await executeTransaction(txClient, tx, signer);
        log(`Cap updated: ${res.digest}`);
      } else {
        log(`On-chain cap already at ${onChainCap.toString()} bps.`);
      }
    } catch (e) {
      log(
        `WARN: could not read/sync max payout cap (${e instanceof Error ? e.message : String(e)}). ` +
          "Use the /admin 'Set parlay max payout cap' card to update manually.",
      );
    }
  } else {
    log("Creating ParlayPool<DBUSDC>…");
    const tx = buildCreateParlayPoolTx(MAX_PAYOUT_BPS, DUSDC_TYPE);
    const res = await executeTransaction(txClient, tx, signer);
    poolId = await findSharedObjectId(
      client,
      res.digest,
      "::parlay::ParlayPool<",
    );
    if (!poolId) {
      err(`Pool created (tx ${res.digest}) but ID not found in effects.`);
    }
    log(`Created:        ${res.digest}`);
    log(`Pool ID:        ${poolId}`);
  }

  // Optionally seed the pool. We pick the largest DUSDC coin the
  // signer owns that covers the amount — if the deployer has none
  // big enough, we log and continue (the operator can top up later
  // via the parlay-worker or a manual fund_pool call).
  if (SEED_AMOUNT > BigInt(0)) {
    const coinId = await findOwnedDusdcCoin(client, signerAddr, SEED_AMOUNT);
    if (!coinId) {
      log(
        `No single dUSDC coin >= ${SEED_AMOUNT.toString()} found in deployer ` +
          `wallet; skipping seed. Top up later with fund_pool.`,
      );
    } else {
      log(`Funding pool with ${SEED_AMOUNT.toString()} dUSDC…`);
      const tx = buildFundParlayPoolTx(poolId, coinId, DUSDC_TYPE);
      const res = await executeTransaction(txClient, tx, signer);
      log(`Funded:         ${res.digest}`);
    }
  }

  const agentsUpdates = {
    PARLAY_POOL_ID: poolId,
  };
  const webUpdates = {
    NEXT_PUBLIC_PARLAY_POOL_ID: poolId,
  };
  updateEnv(AGENTS_ENV, agentsUpdates);
  updateEnv(WEB_ENV, webUpdates);
  log(`Wrote ${AGENTS_ENV}`);
  log(`Wrote ${WEB_ENV}`);
  log("Done.");
}

main().catch((e) => {
  err(e instanceof Error ? e.stack ?? e.message : String(e));
});
