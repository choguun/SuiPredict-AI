# SECURITY — rotate agent + prize-admin keys (2026-06-20)

**Status:** CRITICAL — **both `AGENT_PRIVATE_KEY` and `PRIZE_ADMIN_PRIVATE_KEY` were committed in `.env.bak2`–`.env.bak14` and `.env.deployed-self-hosted`** (commit `dc4219e`, 2026-06-06, still in `origin/main` history at the time of this writing).

Both keys must be considered compromised the moment they were pushed to a public mirror. This doc covers:

1. **The leak**: what was committed, when, and where it is now.
2. **Immediate mitigation**: untrack the files, scrub git history, force-push.
3. **Key rotation procedure**: generate fresh keypairs, update the on-chain
   policy object + prize-admin, update Railway + Vercel env, redeploy.
4. **Hardening**: pre-commit hook + a `.env.bak*` gitignore + a CI secret scanner.

---

## 1. The leak

| File | Committed in | What it contained |
|---|---|---|
| `.env.bak2` | `dc4219e` (2026-06-06) | `AGENT_PRIVATE_KEY`, `PRIZE_ADMIN_PRIVATE_KEY`, `PRIZE_ADMIN_PUBKEY_B64`, plus all non-secret env |
| `.env.bak3`–`.env.bak14` | various post-`dc4219e` rotations of `.env.bak2` | same secrets, sometimes with updated values |
| `.env.deployed-self-hosted` | `9b696cf` | same secrets, post DeepBook self-hosted deploy |

All 13 `.env.bak*` files and the `.env.deployed-self-hosted` file were tracked in git and remained so until commit `93cc00c` (untracked the SDK dist) and the fix in this commit.

The active `.env` (the one currently in use on the dev machine) is *not* tracked — `.gitignore:4` correctly excludes it. The leaks were only in the .bak files and the .deployed-self-hosted file.

## 2. Immediate mitigation (done in this commit)

- `git rm --cached .env.bak2 .env.bak3 ... .env.bak14 .env.deployed-self-hosted` —
  removed all 14 files from the git index, preserved on-disk (then wiped).
- Added `.env.bak*`, `.env.backup`, `*.env.local.bak`, `*.env.bkp` to
  `.gitignore` so any future backups are also excluded.
- Wiped the local copies (`rm .env.bak* .env.deployed-self-hosted`).
- Working tree clean; all 14 files now show as `D` in `git status`.

### Still TODO (operator action required, NOT in this commit)

- **Scrub history**: run `git filter-repo --invert-paths --path-glob '.env.bak*' --path .env.deployed-self-hosted` (or BFG) on a fresh clone, then `git push --force`. Without this, the secrets are still in every clone of `origin/main` that exists.
- **Rotate the keys** (see §3).
- **Audit the secrets' on-chain impact**: any prior deploy of the agents service that used these keys gave the holder on-chain write authority. Until the keys are rotated, anyone with read access to `origin/main` history can sign transactions as the agent or as the prize-admin.

## 3. Key rotation procedure

The two keypairs to rotate:

| Env var | What it controls | On-chain object |
|---|---|---|
| `AGENT_PRIVATE_KEY` | The agents service's signer for all PTBs (`create_market`, `mint_shares`, `place_order`, `resolve_market`, `referral_keeper`, etc.) | `AGENT_POLICY_ID` (the v3 `AgentPolicy` object, stamped with this address as the authorized operator) |
| `PRIZE_ADMIN_PRIVATE_KEY` | The weekly prize claim payload signer (the prize-distributor agent calls `signClaimPayload` and the user submits the signed payload to `claim_prize` on-chain) | `PRIZE_ADMIN_ID` (the v3 `PrizeAdmin` cap; the bcs-encoded ed25519 public key is also stored in `PrizePool` so the on-chain verifier knows the expected signer) |

### Step 1 — generate a fresh agent keypair

```bash
# On a machine with the Sui CLI
sui client new-address ed25519 "agent-v2-2026-06-20"
# Take the printed secret key (suiprivkey1...) → AGENT_PRIVATE_KEY
# Take the printed address (0x...) → AGENT_PUBLIC_ADDRESS
# Take the printed public key base64 → not needed for AGENT_PRIVATE_KEY
```

Or with the SDK:

```bash
cd apps/agents
npx tsx -e 'import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"; const kp = Ed25519Keypair.generate(); console.log("address:", kp.getPublicKey().toSuiAddress()); console.log("privkey:", kp.getSecretKey());'
```

### Step 2 — bootstrap a fresh `AgentPolicy` v3

```bash
cd apps/agents
set -a; source ../../.env; set +a
npx tsx scripts/create-fresh-policy.ts
# → prints new policy id + writes apps/agents/data/agent-policy-id.txt
```

Update env on **Railway** + **Vercel**:

```
AGENT_PRIVATE_KEY=<new suiprivkey1...>
AGENT_POLICY_ID=<new policy id from script>
NEXT_PUBLIC_AGENT_POLICY_ID=<new policy id>
```

### Step 3 — generate a fresh prize-admin keypair

```bash
sui client new-address ed25519 "prize-admin-v2-2026-06-20"
# Take the printed secret key (base58) → PRIZE_ADMIN_PRIVATE_KEY
# Take the printed public key base64 → PRIZE_ADMIN_PUBKEY_B64 (required by on-chain verifier)
```

### Step 4 — rotate the on-chain prize-admin

```bash
cd apps/agents
set -a; source ../../.env; set +a
# PRIZE_ADMIN_PRIVATE_KEY must point at the NEW keypair for this to work
npx tsx scripts/rotate-prize-admin-address.ts \
  --new-pubkey-b64 "<new PRIZE_ADMIN_PUBKEY_B64>"
# → on-chain tx; print new PRIZE_ADMIN_ID
```

Update env on **Railway** + **Vercel**:

```
PRIZE_ADMIN_PRIVATE_KEY=<new base58 privkey>
PRIZE_ADMIN_PUBKEY_B64=<new pubkey b64>
PRIZE_ADMIN_ID=<new admin cap id from script>
NEXT_PUBLIC_PRIZE_ADMIN_ID=<new admin cap id>
```

### Step 5 — redeploy the agents service

```bash
# The new env vars trigger an automatic redeploy, but the dist needs
# to pick them up too, so force a from-source deploy:
railway up --detach --yes -m "rotate: fresh agent + prize-admin keys"
```

### Step 6 — verify

```bash
curl https://agents-production-11fd.up.railway.app/health
# → should show the NEW agent_address (not the old one)
# → should show the NEW prize_admin_id (not the old one)

# Trigger a wc-creator tick (or wait for the next 15-min boundary)
# → check the decision feed: /decisions should show create_market
#   success with a digest, NOT "invalid signer" errors
```

## 4. Hardening

Once the keys are rotated and history is scrubbed, add these belt-and-suspenders measures:

- **Pre-commit secret scanner** (`.githooks/pre-commit`):
  ```bash
  #!/usr/bin/env bash
  set -e
  # Block any commit that adds a .env.bak* / .env.deployed* file.
  if git diff --cached --name-only | grep -E '\.env\.bak|\.env\.deployed|.*\.env\.local\.bak'; then
    echo "ERROR: refusing to commit .env.bak* / .env.deployed* files"
    echo "Move secrets out of the repo (1Password, .env in repo root only)."
    exit 1
  fi
  # Block any commit whose diff introduces a suiprivkey1... or ed25519 base64.
  if git diff --cached | grep -E '^\+.*suiprivkey1[0-9a-z]{20,}|^\+.*PRIVATE_KEY=[A-Za-z0-9+/=]{40,}'; then
    echo "ERROR: refusing to commit a private key"
    exit 1
  fi
  ```
  Then `git config core.hooksPath .githooks`.

- **CI secret scanner** (`.github/workflows/secret-scan.yml`): run
  `gitleaks detect --source . --no-banner` (or `trufflehog filesystem .`)
  on every PR. Block on `severity >= medium`.

- **`.env.example` discipline**: every secret in the local `.env` should
  have a placeholder in `.env.example` (the value `""` or a redacted
  string like `AGENT_PRIVATE_KEY=""`). The diff between `.env` and
  `.env.example` should *only* show values, never keys.

- **Operator SOP update**: add a "Never commit `.env.bak*`" note to
  `docs/SOP-DEPLOYMENT.md` near the "rotate keys" section.
