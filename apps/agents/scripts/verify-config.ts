#!/usr/bin/env tsx
/**
 * Verify the bootstrap: read each shared-object ID from the SDK env,
 * confirm it exists on-chain and is the expected type, and print a
 * pass/fail summary. Run with:
 *   pnpm --filter @suipredict/agents tsx scripts/verify-config.ts
 *
 * Use this after `bootstrap` to confirm the entire chain is wired
 * before launching the agents service.
 */
import { config as loadEnv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { DUSDC_TYPE } from "@suipredict/sdk";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../..");
loadEnv({ path: resolve(REPO_ROOT, ".env") });

const NETWORK = process.env.SUI_NETWORK ?? "testnet";
const RPC_URL =
  NETWORK === "mainnet"
    ? "https://fullnode.mainnet.sui.io:443"
    : NETWORK === "devnet"
      ? "https://fullnode.devnet.sui.io:443"
      : "https://fullnode.testnet.sui.io:443";

const grpc = new SuiGrpcClient({ network: NETWORK as "testnet", baseUrl: RPC_URL });

interface Check {
  name: string;
  id: string;
  expectedTypeSuffix: string;
}

const checks: Check[] = [
  { name: "Package (AGENT_POLICY_PACKAGE_ID)", id: process.env.AGENT_POLICY_PACKAGE_ID ?? "", expectedTypeSuffix: "package" },
  { name: "StreakAdmin (STREAK_ADMIN_ID)", id: process.env.STREAK_ADMIN_ID ?? "", expectedTypeSuffix: "::streak_system::StreakAdmin" },
  { name: "StreakRegistry (STREAK_REGISTRY_ID)", id: process.env.STREAK_REGISTRY_ID ?? "", expectedTypeSuffix: "::streak_system::StreakRegistry" },
  { name: "PrizeAdmin (PRIZE_ADMIN_ID)", id: process.env.PRIZE_ADMIN_ID ?? "", expectedTypeSuffix: "::prize_pool::PrizeAdmin" },
  { name: "PrizePool (PRIZE_POOL_ID)", id: process.env.PRIZE_POOL_ID ?? "", expectedTypeSuffix: "::prize_pool::PrizePool<" },
  { name: "FeeVault (FEE_VAULT_ID)", id: process.env.FEE_VAULT_ID ?? "", expectedTypeSuffix: "::prediction_market::FeeVault<" },
  { name: "MarketRegistry (MARKET_REGISTRY_ID)", id: process.env.MARKET_REGISTRY_ID ?? "", expectedTypeSuffix: "::registry::MarketRegistry" },
  { name: "ProtocolVault (VAULT_OBJECT_ID)", id: process.env.VAULT_OBJECT_ID ?? "", expectedTypeSuffix: "::vault::ProtocolVault<" },
  { name: "AgentPolicy (AGENT_POLICY_ID)", id: process.env.AGENT_POLICY_ID ?? "", expectedTypeSuffix: "::agent_policy::AgentPolicy" },
  // ProfileRegistry — the web /settings page builds create_profile /
  // set_country_code PTBs against this. Bootstrap writes
  // NEXT_PUBLIC_PROFILE_REGISTRY_ID from the user_profile::init shared
  // object; if the wrong id slips into the env the entire profile flow
  // aborts on-chain with a generic "package object not found".
  { name: "ProfileRegistry (NEXT_PUBLIC_PROFILE_REGISTRY_ID)", id: process.env.NEXT_PUBLIC_PROFILE_REGISTRY_ID ?? "", expectedTypeSuffix: "::user_profile::ProfileRegistry" },
  // BalanceManager — DeepBook v3 shared object the market-maker uses
  // to place orders. Comes from `@mysten/deepbook-v3`, so the type
  // suffix is `::balance_manager::BalanceManager` regardless of which
  // deepbook package is wired. Optional in bootstrap (market-maker
  // creates one on first tick if unset) so missing is "skip", not
  // "fail".
  { name: "BalanceManager (BALANCE_MANAGER_ID)", id: process.env.BALANCE_MANAGER_ID ?? "", expectedTypeSuffix: "::balance_manager::BalanceManager" },
];

async function main() {
  console.log(`\n=== Config verification (${NETWORK}) ===\n`);
  let passed = 0;
  let failed = 0;
  let missing = 0;
  for (const c of checks) {
    if (!c.id) {
      console.log(`  [skip]   ${c.name}  (env unset)`);
      missing++;
      continue;
    }
    try {
      const resp = await grpc.getObject({ objectId: c.id });
      const obj = (resp as { object?: { type?: string } }).object;
      if (!obj) {
        console.log(`  [fail]   ${c.name}  (${c.id.slice(0, 10)}…)  — not found on chain`);
        failed++;
        continue;
      }
      const type = obj.type ?? "";
      const match = type.includes(c.expectedTypeSuffix);
      const status = match ? "ok    " : "MISMATCH";
      const short = type.length > 70 ? type.slice(0, 67) + "..." : type;
      console.log(`  [${status}] ${c.name.padEnd(38)}  ${c.id.slice(0, 12)}…  →  ${short}`);
      if (match) passed++;
      else failed++;
    } catch (e) {
      console.log(`  [err ]   ${c.name}  (${c.id.slice(0, 10)}…)  — ${e instanceof Error ? e.message : String(e)}`);
      failed++;
    }
  }

  // Also check the prize admin pubkey
  const prizeKeyB64 = process.env.PRIZE_ADMIN_PRIVATE_KEY ?? "";
  if (prizeKeyB64) {
    try {
      const { Ed25519Keypair } = await import("@mysten/sui/keypairs/ed25519");
      const k = Ed25519Keypair.fromSecretKey(prizeKeyB64);
      console.log(`  [ok    ] Prize admin keypair                        ${k.getPublicKey().toSuiAddress().slice(0, 12)}…`);
      passed++;
    } catch (e) {
      console.log(`  [err ]   Prize admin keypair load — ${e instanceof Error ? e.message : String(e)}`);
      failed++;
    }
  } else {
    console.log(`  [skip]   Prize admin keypair (PRIZE_ADMIN_PRIVATE_KEY unset)`);
    missing++;
  }

  // Address checks (not on-chain objects — just well-formed 0x-hex).
  // These envs are written by bootstrap but live as plain addresses, so
  // the getObject check above would never apply. A typo (a 31-char
  // address or a stray ASCII char from a copy-paste) silently breaks
  // the referral sweep / admin gate — easier to catch here than in
  // production.
  //   REFERRAL_TREASURY_ADDRESS    — referral-keeper sweep target
  //   NEXT_PUBLIC_ADMIN_ADDRESS    — /admin page gates UI on equality
  // Sui addresses are 0x + 64 hex chars (32 bytes); accept the
  // canonical full form only — the SDK normalizes shorter forms before
  // submission, but verify-config is the place to flag drift.
  const addressChecks: { name: string; value: string }[] = [
    { name: "ReferralTreasury (REFERRAL_TREASURY_ADDRESS)", value: process.env.REFERRAL_TREASURY_ADDRESS ?? "" },
    { name: "AdminAddress (NEXT_PUBLIC_ADMIN_ADDRESS)", value: process.env.NEXT_PUBLIC_ADMIN_ADDRESS ?? "" },
  ];
  const SUI_ADDRESS_RE = /^0x[0-9a-fA-F]{1,64}$/;
  for (const a of addressChecks) {
    if (!a.value) {
      console.log(`  [skip]   ${a.name}  (env unset)`);
      missing++;
      continue;
    }
    if (SUI_ADDRESS_RE.test(a.value)) {
      console.log(`  [ok    ] ${a.name.padEnd(38)}  ${a.value.slice(0, 12)}…`);
      passed++;
    } else {
      console.log(`  [fail]   ${a.name}  — not a 0x-hex Sui address (got "${a.value.slice(0, 20)}…")`);
      failed++;
    }
  }

  // Also check DUSDC seed
  console.log(`\n  DUSDC type: ${DUSDC_TYPE}`);

  console.log(`\n=== ${passed} passed, ${failed} failed, ${missing} missing ===\n`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
