// Compare web .env.local NEXT_PUBLIC_* values to the agents runtime
// /health payload field-by-field. Mirrors apps/web/app/agents/page.tsx
// driftLinesFor().

import { readFileSync } from 'node:fs';
import { config } from 'dotenv';
config({ path: 'apps/web/.env.local' });

const ENV_IDS = [
  { env: "NEXT_PUBLIC_AGENT_POLICY_PACKAGE_ID", label: "AGENT_POLICY_PACKAGE_ID", runtimeKey: "package_id" },
  { env: "NEXT_PUBLIC_DEEPBOOK_REGISTRY_ID", label: "DEEPBOOK_REGISTRY_ID", runtimeKey: "deepbook_registry_id" },
  { env: "NEXT_PUBLIC_VAULT_OBJECT_ID", label: "VAULT_OBJECT_ID", runtimeKey: "vault_id" },
  { env: "NEXT_PUBLIC_PRIZE_POOL_ID", label: "PRIZE_POOL_ID", runtimeKey: "prize_pool_id" },
  { env: "NEXT_PUBLIC_PARLAY_POOL_ID", label: "PARLAY_POOL_ID", runtimeKey: "parlay_pool_id" },
  { env: "NEXT_PUBLIC_STREAK_REGISTRY_ID", label: "STREAK_REGISTRY_ID", runtimeKey: "streak_registry_id" },
  { env: "NEXT_PUBLIC_FEE_VAULT_ID", label: "FEE_VAULT_ID", runtimeKey: "fee_vault_id" },
  { env: "NEXT_PUBLIC_REFERRAL_TREASURY_ADDRESS", label: "REFERRAL_TREASURY_ADDRESS", runtimeKey: "referral_treasury_address" },
  { env: "NEXT_PUBLIC_PRIZE_ADMIN_ID", label: "PRIZE_ADMIN_ID", runtimeKey: "prize_admin_id" },
  { env: "NEXT_PUBLIC_PROFILE_REGISTRY_ID", label: "PROFILE_REGISTRY_ID", runtimeKey: "profile_registry_id" },
  { env: "NEXT_PUBLIC_ADMIN_ADDRESS", label: "ADMIN_ADDRESS", runtimeKey: "admin_address" },
  { env: "NEXT_PUBLIC_PARLAY_ADMIN_ID", label: "PARLAY_ADMIN_ID", runtimeKey: "parlay_admin_id" },
  { env: "NEXT_PUBLIC_DEEPBOOK_POOL_ID", label: "DEEPBOOK_POOL_ID", runtimeKey: "deepbook_pool_id" },
  { env: "NEXT_PUBLIC_DEEPBOOK_POOL_KEY", label: "DEEPBOOK_POOL_KEY", runtimeKey: "deepbook_pool_key" },
];

const r = await fetch('http://localhost:3001/health');
const runtime = await r.json();
const drifts = [];
for (const { env, label, runtimeKey } of ENV_IDS) {
  const localVal = process.env[env] ?? "";
  const runtimeVal = String(runtime[runtimeKey] ?? "");
  if (!runtimeVal) {
    drifts.push(`${label}: runtime value missing from /health`);
    continue;
  }
  if (!localVal) {
    drifts.push(`${label}: web bundle has no ${env} set`);
    continue;
  }
  if (runtimeVal.toLowerCase() !== localVal.toLowerCase()) {
    drifts.push(`${label}: web=${localVal.slice(0, 10)}… runtime=${runtimeVal.slice(0, 10)}…`);
  }
}
console.log('Total drifts:', drifts.length);
for (const d of drifts) console.log(' ', d);
