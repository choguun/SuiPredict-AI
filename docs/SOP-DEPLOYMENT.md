# Deployment Standard Operating Procedure

This document is the runbook for taking SuiPredict-AI from a fresh clone to a live, on-chain deployment. It covers first-time deployment, redeploy, key rotation, and rollback.

> **Audience:** the operator (you). Read the whole document before your first deploy; the sections are self-contained for the more common operations.

## Table of contents

1. [Topology](#topology)
2. [Pre-flight checklist](#pre-flight-checklist)
3. [First-time deploy (testnet)](#first-time-deploy-testnet)
4. [First-time deploy (mainnet)](#first-time-deploy-mainnet)
5. [Redeploy (no contract change)](#redeploy-no-contract-change)
6. [Redeploy (Move package change)](#redeploy-move-package-change)
7. [Key rotation](#key-rotation)
8. [Frontend deploy (Vercel)](#frontend-deploy-vercel)
9. [Agents service deploy](#agents-service-deploy)
10. [Verify after deploy](#verify-after-deploy)
11. [Rollback](#rollback)
12. [Common failure modes](#common-failure-modes)
13. [Operational runbook](#operational-runbook)

---

## Topology

```
┌────────────────────────────────────────────────────────────────┐
│  Vercel (apps/web)                                             │
│    - Next.js 15 standalone                                     │
│    - public env: NEXT_PUBLIC_* + AGENT URL + public object IDs │
└─────────────────────┬──────────────────────────────────────────┘
                      │ reads /markets, /decisions, /leaderboard
                      ▼
┌────────────────────────────────────────────────────────────────┐
│  Agents host (apps/agents)                                     │
│    - Node 20 LTS, persistent disk (./data/*.db)                │
│    - private env: AGENT_PRIVATE_KEY, PRIZE_ADMIN_PRIVATE_KEY,  │
│      OPENAI_API_KEY, internal RPC/GRPC URLs                    │
│    - exposes :3001 (or $PORT)                                  │
└─────────────────────┬──────────────────────────────────────────┘
                      │ gRPC / REST
                      ▼
┌────────────────────────────────────────────────────────────────┐
│  Sui network (testnet / mainnet)                               │
│    - Move package (1 publish)                                  │
│    - Shared objects: FeeVault, PrizePool, StreakAdmin,         │
│      StreakRegistry, MarketRegistry, ProtocolVault,            │
│      ParlayPool, ProfileRegistry                               │
│    - 1+ DeepBook V3 pool per market                            │
└────────────────────────────────────────────────────────────────┘
```

**Two write-authority keys:**

| Key | Env var | Powers |
|-----|---------|--------|
| Agent hot wallet | `AGENT_PRIVATE_KEY` | Market create / resolve, MM orders, parlay submit, vault allocate, referral sweep, prize pool ops |
| Prize admin | `PRIZE_ADMIN_PRIVATE_KEY` | Signs `claim_prize` payloads (no on-chain write, just an off-chain signature) |

Both are ed25519. The agent key is the one that holds SUI for gas; the prize admin key never needs SUI.

---

## Pre-flight checklist

Run these in order. Anything that fails must be fixed before the next step.

```bash
# 1. Tooling
node --version          # must be 20.x
pnpm --version          # must be 9.x
sui --version           # any recent CLI

# 2. Clean build
pnpm install
pnpm build              # MUST exit 0 — never deploy a non-clean tree

# 3. Active Sui address has gas
sui client active-address
sui client gas
# First-time deploy: ~5 SUI. Redeploy: ~2 SUI. Bootstrap-parlay: ~0.5 SUI.

# 4. Correct network
echo $SUI_NETWORK       # must match the wallet's network

# 5. .env exists and is populated
ls -la .env
```

**Never deploy from a branch.** Always tag a commit and deploy the tag.

```bash
git checkout main
git pull --rebase
git tag -a v0.x.y -m "deploy YYYY-MM-DD"
git push origin v0.x.y
```

---

## First-time deploy (testnet)

### Step 1 — Fund the agent wallet

```bash
# A fresh ed25519 key for the agent
sui client new-address ed25519 suipredict-agents

# Capture the address
export AGENT_ADDRESS=$(sui client active-address)

# Fund from the testnet faucet
# https://docs.sui.io/guides/developer/getting-started/connect#devnet-faucet
# Or use the Discord faucet: /faucet $AGENT_ADDRESS

# Wait for the faucet tx to finalize
sui client gas --address $AGENT_ADDRESS
```

Save the secret for `AGENT_PRIVATE_KEY`:

```bash
sui keytool export ed25519:<address>  # the first line is the bech32 secret
# → AGENT_PRIVATE_KEY="suiprivkey1..."
echo "AGENT_PRIVATE_KEY=$SECRET" >> .env
```

### Step 2 — Publish the Move package

```bash
cd packages/contracts

# (Optional) verify it compiles first
sui move build

# Publish. The --json output is what the bootstrap script parses.
sui client publish --gas-budget 500_000_000 --json \
  | tee /tmp/publish-$(date +%s).json

# Extract the new package ID
PKG_ID=$(jq -r '.objectChanges[]
  | select(.type=="published")
  | .packageId' /tmp/publish-$(date +%s).json | head -1)

echo "Published package: $PKG_ID"
echo "AGENT_POLICY_PACKAGE_ID=$PKG_ID" >> ../../.env
```

**Capture the UpgradeCap.** The published-tx response contains an `UpgradeCap` object ID you'll need for any future upgrades. Save it in `1Password` / vault:

```bash
UPGRADE_CAP=$(jq -r '.objectChanges[]
  | select(.objectType | endswith("package::UpgradeCap"))
  | .objectId' /tmp/publish-*.json | head -1)
echo "UpgradeCap: $UPGRADE_CAP" | tee -a .env.deploy-state
```

### Step 3 — Bootstrap the shared objects

This single script does **all** of:

- `init_fee_vault<DBUSDC>(admin_cap, agent)`
- Generate (or accept) the prize admin ed25519 keypair
- `rotate_pubkey` on the new `PrizeAdmin`
- `create_pool<DBUSDC>(seed, week)` → shared `PrizePool`
- `create_registry` → shared `MarketRegistry`
- `create_vault<DBUSDC>(vlp_cap)` → shared `ProtocolVault`
- `create_policy(agent, budget, expiry)` → shared `AgentPolicy`

```bash
cd ../..
pnpm --filter @suipredict/agents bootstrap
```

Each step is **idempotent**: if the env var is already set, the step prints `skip` and exits. The script writes the new IDs to `.env` (agents) and `apps/web/.env.local` (web).

**Save the prize admin key.** The script prints a base64 ed25519 secret on first run; copy it into your secrets manager before re-running:

```bash
echo "PRIZE_ADMIN_PRIVATE_KEY=<base64>" >> .env
```

If you lose this key, weekly prize claims will fail for every winner. See [Key rotation](#key-rotation).

### Step 4 — Bootstrap the parlay pool

```bash
pnpm --filter @suipredict/agents bootstrap-parlay
```

This creates the `ParlayPool<DBUSDC>` and seeds it with `PARLAY_SEED_AMOUNT` DUSDC (set to 0 in `.env` if you want to fund later via `fund_pool`).

### Step 5 — Verify

```bash
pnpm --filter @suipredict/agents verify-config
```

Expected output: every shared-object ID resolves on-chain and matches its expected type. Any `MISSING` line is a hard stop — go back to the relevant bootstrap step and re-run.

```bash
# Quick smoke test (signs and submits a tiny CLOB order; costs ~0.1 SUI)
pnpm --filter @suipredict/agents smoke-test
```

### Step 6 — Launch the agents service

```bash
pnpm dev:agents
# or in prod:
pnpm --filter @suipredict/agents build
PORT=3001 node apps/agents/dist/index.js
```

Tail `/health` for 60s. Every agent should report `lastRun` within the last `AGENT_POLL_INTERVAL_MS` (default 5s). If `lastRun` is stale, see [Common failure modes](#common-failure-modes).

### Step 7 — Deploy the web app

See [Frontend deploy (Vercel)](#frontend-deploy-vercel).

### Step 8 — Smoke test from the browser

1. Open `https://<your-web-domain>/markets` — should render the live book
2. Open `/agents` — should show green ticks for all 11 workers
3. Connect a wallet (zkLogin via Enoki), deposit 10 DUSDC, place a 1-YES limit order at 0.50 DUSDC
4. Withdraw settled — should close the position and refund DUSDC

---

## First-time deploy (mainnet)

Everything above, plus:

1. **Use a hardware-backed key for the agent.** A `sui keytool`-exported bech32 secret on disk is acceptable for testnet only. For mainnet:
   - Generate the key on a dedicated machine, never on the deploy host
   - Load the key into a KMS (AWS KMS, GCP Secret Manager, Vault) at runtime
   - Rotate every 90 days — see [Key rotation](#key-rotation)
2. **Audit the Move package.** Run `sui move build` and verify the bytecode hash matches a known-good build. Don't trust the testnet package as the mainnet one.
3. **Cap the agent budget.** Set `AGENT_MAX_BUDGET_USDC=10` and `RESOLVER_CONFIDENCE=90`. Both can be raised once you have weeks of clean telemetry.
4. **Disable `PRIZE_AUTO_CLAIM`** in `.env`. Custodial auto-claim means a leaked agent key can drain every user's prize.
5. **Deploy to multiple regions.** Vercel handles this for the web. For the agents, run two instances behind a load balancer and use a shared SQLite volume (Litestream → S3) so a single host failure doesn't lose state.
6. **Subscribe to Sui Status.** Add the [status.sui.io](https://status.sui.io) RSS to your incident channel.
7. **Tighten `RISK_PAUSE_UTILIZATION=0.50`.** Mainnet should pause MM well before TVL is at risk.

---

## Redeploy (no contract change)

The Move package doesn't change; the agents service is being redeployed (e.g. new env, restart, host migration).

```bash
# 1. Build
pnpm build

# 2. Stop the running service
#    (systemd: sudo systemctl stop suipredict-agents
#     or just: kill <PID>; the agents have a SIGTERM handler that drains in-flight work)

# 3. Copy the new build
rsync -avz --delete \
  --exclude='.env' --exclude='data/' \
  apps/agents/dist/  deploy@agents-host:/opt/suipredict/agents/

# 4. Start
ssh deploy@agents-host "systemctl start suipredict-agents"
```

The new process opens fresh gRPC channels; the prior one's SIGTERM handler closes them and resets the JSON-RPC singleton (R58).

---

## Redeploy (Move package change)

If you changed any `.move` file, you must republish. Two strategies:

### Strategy A: additive change (no module removals)

Use `sui client upgrade` with the `UpgradeCap` from the first publish. Package ID stays the same — no env changes needed.

```bash
cd packages/contracts
sui move build
sui client upgrade --gas-budget 500_000_000 \
  --upgrade-cap $UPGRADE_CAP
```

### Strategy B: breaking change

Publish a new package. **All shared objects created by the old package are still bound to the old package ID.** You have two options:

1. **Migrate each shared object** to the new package via the per-object `init_migration` admin function. This is what `prize_pool`, `parlay`, and `streak_system` support; check the source.
2. **Fresh deploy.** If migration is impractical, treat this as a first-time deploy: publish → bootstrap → bootstrap-parlay → verify. The old package's shared objects become orphans (they can be reclaimed by the `UpgradeCap` holder via `make_immutable` and explicit destroy).

For a hackathon demo, strategy B is simpler. For a production migration, write a script that calls the `init_migration` for each shared object in order, and verify with `verify-config` between steps.

---

## Key rotation

### Rotate the agent hot wallet

```bash
# 1. Generate a new key
sui client new-address ed25519 suipredict-agents-v2
NEW=$(sui client active-address)

# 2. Fund the new key from the old one
sui client transfer --to $NEW --sui-coin-object-id <COIN_ID> --gas-budget 5_000_000

# 3. Update the agent_policy on-chain so the new key inherits the policy
sui client ptb \
  --move-call "$PKG::agent_policy::rotate_agent" \
    @$AGENT_POLICY_ID $NEW

# 4. Update .env
NEW_KEY=$(sui keytool export ed25519:<new-address>)
sed -i.bak "s/^AGENT_PRIVATE_KEY=.*/AGENT_PRIVATE_KEY=$NEW_KEY/" .env

# 5. Restart the agents service
sudo systemctl restart suipredict-agents

# 6. Revoke the old key's on-chain authority (optional but recommended)
sui client ptb \
  --move-call "$PKG::agent_policy::revoke_agent" \
    @$AGENT_POLICY_ID $OLD_ADDRESS
```

### Rotate the prize admin key

The prize admin key is **not** a chain key — it just signs off-chain claim payloads. Rotation is simpler:

```bash
# 1. Generate a fresh ed25519 (any tool — OpenSSL, sui keytool, etc.)
NEW=$(openssl genp 32 | base64)

# 2. Update the on-chain pubkey so claims verify against the new key
pnpm --filter @suipredict/agents rotate-prize-pubkey --new $NEW
# (this script calls buildRotatePubkeyTx and writes the tx digest to .env)

# 3. Update .env
sed -i.bak "s/^PRIZE_ADMIN_PRIVATE_KEY=.*/PRIZE_ADMIN_PRIVATE_KEY=$NEW/" .env

# 4. Restart the agents service
sudo systemctl restart suipredict-agents

# 5. Burn the old key (it can no longer sign valid claims)
shred -u /tmp/old-prize-admin.key
```

There is a one-week grace window during which the new key can't sign new claims, but old claims (signed with the old key, submitted before the rotation tx finalized) still verify. Plan your rotation for the start of a new week.

### Rotate the agent policy budget / expiry

```bash
pnpm --filter @suipredict/agents tsx scripts/set-policy-budget.ts \
  --policy $AGENT_POLICY_ID \
  --budget 100_000_000 \
  --expiry-days 365
```

The `set-policy-budget` script is a thin wrapper around `buildSetBudgetTx` and `buildSetExpiryTx`. Pause via `pausePolicyTx` if you need a hard stop.

---

## Frontend deploy (Vercel)

The web app is a standard Next.js 15 standalone app. `apps/web/vercel.json` configures the build:

```json
{
  "buildCommand": "cd ../.. && pnpm install && pnpm --filter @suipredict/sdk build && pnpm --filter @suipredict/web build",
  "outputDirectory": ".next",
  "framework": "nextjs",
  "installCommand": "pnpm install"
}
```

**Required env (Project Settings → Environment Variables):**

| Variable | Scope | Notes |
|----------|-------|-------|
| `NEXT_PUBLIC_AGENTS_URL` | Production + Preview | Public URL of the agents service, e.g. `https://agents.suipredict.ai` |
| `NEXT_PUBLIC_NETWORK` | Production + Preview | `testnet` or `mainnet` |
| `NEXT_PUBLIC_MARKET_PACKAGE_ID` | Production + Preview | From `AGENT_POLICY_PACKAGE_ID` |
| `NEXT_PUBLIC_PARLAY_POOL_ID` | Production + Preview | From `PARLAY_POOL_ID` |
| `NEXT_PUBLIC_PROFILE_REGISTRY_ID` | Production + Preview | From `bootstrap` |
| `NEXT_PUBLIC_PARLAY_MAX_PAYOUT_BPS` | Production + Preview | 50000 for 5× |
| `NEXT_PUBLIC_VAULT_OBJECT_ID` | Production + Preview | From `bootstrap` |
| `ENOKI_API_KEY` | Production + Preview | zkLogin provider; testnet vs mainnet differ |
| `ENOKI_PUBLIC_KEY` | Production + Preview | zkLogin provider |
| `NEXT_PUBLIC_RECAPTCHA_SITE_KEY` | Production + Preview | zkLogin bot guard |

**Deployment steps:**

1. Connect the GitHub repo to a Vercel project
2. Set the root directory to `apps/web`
3. Configure env vars
4. First deploy is automatic on push to `main`; subsequent deploys use the same build command

**Smoke test after deploy:**

1. `curl -sI https://<your-domain>/ | head -1` → expect `200`
2. `curl -s https://<your-domain>/markets | grep -c 'Market'` → expect `>0`
3. Open in browser, connect wallet, place a test order

---

## Agents service deploy

**Recommended host:** a small VPS (2 vCPU, 4 GB RAM, 20 GB disk) running Ubuntu 22.04 LTS.

```bash
# 1. Create a non-root deploy user
sudo adduser --disabled-password --gecos "" suipredict
sudo -u suipredict mkdir -p /opt/suipredict/{agents,data}

# 2. Clone the repo as the deploy user
sudo -u suipredict git clone https://github.com/choguun/SuiPredict-AI.git /opt/suipredict/src
cd /opt/suipredict/src
sudo -u suipredict git checkout v0.x.y

# 3. Install + build
sudo -u suipredict pnpm install --frozen-lockfile
sudo -u suipredict pnpm --filter @suipredict/agents build

# 4. Copy the build artifacts
sudo -u suipredict cp -r apps/agents/dist /opt/suipredict/agents/
sudo -u suipredict cp -r apps/agents/scripts /opt/suipredict/agents/
sudo -u suipredict cp -r apps/agents/src /opt/suipredict/agents/
sudo -u suipredict cp -r apps/agents/node_modules /opt/suipredict/agents/
sudo -u suipredict cp -r packages/sdk/dist /opt/suipredict/agents/sdk-dist/
sudo -u suipredict cp -r packages/sdk/node_modules /opt/suipredict/agents/sdk-node_modules/
sudo -u suipredict cp -r packages/contracts /opt/suipredict/agents/contracts/

# 5. Copy .env (NOT .env.example)
sudo -u suipredict cp /tmp/secrets/.env /opt/suipredict/agents/.env
sudo chmod 600 /opt/suipredict/agents/.env

# 6. systemd unit
cat > /etc/systemd/system/suipredict-agents.service <<'EOF'
[Unit]
Description=SuiPredict AI agents
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=suipredict
WorkingDirectory=/opt/suipredict/agents
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=10
EnvironmentFile=/opt/suipredict/agents/.env
StandardOutput=journal
StandardError=journal
SyslogIdentifier=suipredict-agents
# Hardening
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/suipredict/agents/data
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now suipredict-agents
sudo systemctl status suipredict-agents
```

**Persistent disk:** the SQLite DBs (`./data/markets.db`, `./data/decisions.db`, `./data/gamification.db`) live on the host's disk. Back them up nightly to off-host storage:

```bash
cat > /etc/cron.daily/suipredict-backup <<'EOF'
#!/bin/bash
set -euo pipefail
ts=$(date -u +%Y%m%dT%H%M%SZ)
tar -czf /var/backups/suipredict-$ts.tar.gz /opt/suipredict/agents/data/
# Keep 14 days
find /var/backups -name 'suipredict-*.tar.gz' -mtime +14 -delete
EOF
chmod +x /etc/cron.daily/suipredict-backup
```

For mainnet, also run **Litestream** to replicate the SQLite files to S3/GCS in real time:

```bash
litestream replicate /opt/suipredict/agents/data/markets.db s3://suipredict-backup/mainnet/markets.db
```

---

## Verify after deploy

```bash
# 1. Health
curl -sf http://agents-host:3001/health | jq .

# 2. Config
pnpm --filter @suipredict/agents verify-config

# 3. Smoke
pnpm --filter @suipredict/agents smoke-test

# 4. Web
curl -sf https://<web-domain>/ | head -1
curl -sf https://<web-domain>/markets | grep -c 'Market'
```

**If `verify-config` reports a mismatch,** check:

- Did you write the new ID to BOTH `.env` (agents) and `apps/web/.env.local` (web)? `bootstrap` does this; manual edits don't.
- Did you redeploy the agents after editing `.env`? Most env reads happen at process start; a `systemctl restart suipredict-agents` is required.
- Is the network correct? `SUI_NETWORK` and the wallet's active network must match.

---

## Rollback

The agents service is stateless across restarts (all state is in SQLite or on-chain). Rollback is:

```bash
git checkout v0.x.y
pnpm install --frozen-lockfile
pnpm --filter @suipredict/agents build
sudo systemctl restart suipredict-agents
```

The SQLite files survive a redeploy — they're on a separate `ReadWritePaths`-protected directory. **Do not delete `/opt/suipredict/agents/data/*.db` during a rollback** unless you intend to re-bootstrap.

For a Move package rollback (strategy B above), the path is:

1. Stop the agents service
2. Republish the previous package (a different package ID)
3. Call `init_migration` for each shared object on the new package, or accept that the old objects are orphaned and start fresh

**There is no on-chain rollback.** Sui has no revert. Plan deploys to be either additive (upgrade) or in a separate package (migration).

---

## Common failure modes

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `bootstrap` step `prize_pool::create_pool` aborts with `EInsufficientBalance` | Agent wallet doesn't have `DUSDC_PACKAGE_ID`'s DUSDC | Mint via `sui client ptb`; check `DUSDC_TREASURY_CAP_ID` |
| `market-creator` logs `Move abort (code 1002)` | `MAX_ACTIVE_MARKETS` reached, or `risk-monitor` paused the agent | Check `/decisions` for the `RiskMonitor` row; raise `MAX_ACTIVE_MARKETS` or wait |
| `/markets/:id/book` returns empty | DeepBook pool exists but no orders placed | Check `market-maker` is running; check `BALANCE_MANAGER_ID` is set |
| Prize claim signature `INVALID_SIGNATURE` | `PRIZE_ADMIN_PRIVATE_KEY` doesn't match the on-chain pubkey (rotated, but the new key isn't loaded) | `rotate-prize-pubkey` again, then restart agents |
| `position-indexer` cursor stuck | A poison event in the page that always throws | Read the `[position-indexer] apply failed for event` log; manually advance cursor via SQL |
| `pnpm build` fails on `contracts` | Move syntax error or missing dependency | `cd packages/contracts && sui move build` for the precise error |
| `verify-config` says `package not found` | Wrong network: the `AGENT_POLICY_PACKAGE_ID` was published to testnet but the agent is on mainnet | Fix `SUI_NETWORK` and restart |
| `submitAndWait` times out | RPC node is lagging or down | Switch `SUI_RPC_URL` to a backup; the agents have a single env-var hot-swap path |

---

## Operational runbook

### Daily

- Tail `/agents` decision feed. Any `noop` row for 24h means an agent is stuck.
- Check `/health`. Every agent's `lastRun` should be within `AGENT_POLL_INTERVAL_MS`.
- Glance at the SQLite file size: `du -sh /opt/suipredict/agents/data/`. The `pruneOldDecisions` sweep (R58) caps the decisions table at 30 days.

### Weekly

- `pnpm --filter @suipredict/agents smoke-test` — exercises the full mint→order path
- Review `/leaderboard/weekly` for the prior week's top-N
- Check the prize-admin signature queue: `GET /prize/signature?week=N&rank=R` should serve each winner exactly once

### Monthly

- `sui client object <shared-object-id>` for each shared object — confirm none have been paused by a stale tx
- `sui client gas <agent-address>` — top up if below 5 SUI
- Verify the Sui network's `protocol_version` matches the agents' `SUI_NETWORK` (the SDK pins to a specific protocol)

### Quarterly

- Rotate the agent hot wallet (see [Key rotation](#key-rotation))
- Review the Move package for any newly-released critical fixes
- Run a load test: have 10 markets × 100 users each place 10 orders, measure the position-indexer's lag

### Yearly

- Major-version upgrade: republish the Move package (strategy A above)
- Audit: have an external reviewer walk through `packages/contracts/sources/` for any move-call authorization gaps

---

## Appendix: file map

| Path | Purpose |
|------|---------|
| `scripts/deploy/deploy-deepbook.sh` | One-shot DeepBook testnet deployer (test fixture) |
| `scripts/deploy/deploy-self-hosted.sh` | Self-hosted DeepBook V3 stack deployer (test fixture) |
| `apps/agents/scripts/bootstrap-gamification.ts` | The `bootstrap` script — publish + init shared objects |
| `apps/agents/scripts/bootstrap-parlay.ts` | The `bootstrap-parlay` script — ParlayPool creation |
| `apps/agents/scripts/resume-bootstrap.ts` | Resumes a partial bootstrap; `--only <step>` for surgical recovery |
| `apps/agents/scripts/verify-config.ts` | Post-deploy verification |
| `apps/agents/scripts/smoke-test.ts` | End-to-end smoke (mint → order) |
| `apps/agents/scripts/rotate-prize-pubkey.ts` | Prize admin pubkey rotation |
| `apps/agents/scripts/rotate-prize-admin-address.ts` | Prize admin address rotation |
| `apps/web/vercel.json` | Vercel build config |
| `.env.example` | Full env reference |
