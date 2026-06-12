# Local Run & Test Guide

This is the end-to-end recipe for taking SuiPredict-AI from a fresh clone to a working, verifiable demo on your laptop. The default mode is **demo (dry-run)**: no wallet, no on-chain txs, no gas, no testnet SUI needed. You can still verify the full UI, all 14 agents (with the WC trio highlighted), and the gamification flow.

If you have an `AGENT_PRIVATE_KEY` and want to see real on-chain state, see the **On-chain mode** section at the bottom.

## 0. Prerequisites

| Tool | Version | Why |
|------|---------|-----|
| Node.js | ≥ 20.10 | `apps/agents` uses `node:test` and `tsx` |
| pnpm | ≥ 9.15 | monorepo workspace |
| Sui CLI | optional | only for on-chain mode |
| Git | any | — |

Optional:
- An `OPENAI_API_KEY` if you want LLM-driven market proposals (otherwise the WC creator + generic creator fall back to deterministic mock markets)

## 1. First-time setup (~2 min)

```bash
git clone https://github.com/choguun/SuiPredict-AI.git
cd SuiPredict-AI
pnpm install                # ~30s, builds all 4 packages
cp .env.example .env        # safe to use as-is for demo mode
```

> **If `pnpm install` doesn't compile the `better-sqlite3` native binding** (a known issue on fresh macOS/ARM64 dev boxes), the agents service will boot but the World Cup demo seed will fail. Fix with:
>
> ```bash
> pnpm rebuild better-sqlite3
> # or, more targeted:
> pnpm --filter @suipredict/agents rebuild better-sqlite3
> ```
>
> A `postinstall` script in `apps/agents/package.json` warns at install time if the binding is missing.

> **No env edits required** for demo mode. The `.env.example` defaults point to the public Mysten testnet gRPC/REST endpoints, and the World Cup env vars all have sensible defaults baked into the code.

## 2. Build everything (one-shot, ~1 min)

```bash
pnpm build
```

Expected output:
```
 Tasks:    4 successful, 4 total
 Time:     ~10s
```

This runs (in dependency order):
1. `packages/contracts` — `sui move build`
2. `packages/sdk` — `tsc`
3. `apps/agents` — `tsc` (compiles all 14 workers + REST routes)
4. `apps/web` — `next build`

If anything fails, see [Common issues](#common-issues) at the bottom.

## 3. Run the test suites (≤ 30s)

```bash
# Smart-contract unit tests (122 tests, requires Sui CLI)
cd packages/contracts && sui move test && cd ../..

# TypeScript unit tests for the World Cup fetcher + Elo model
pnpm --filter @suipredict/agents test:wc
```

Expected: 122/122 Move tests pass, 8/8 WC tests pass.

## 4. Start the agents service (~5s)

```bash
pnpm dev:agents
```

The first time you start, you should see:

```
[wc-fetcher] Wikipedia returned 0 groups; using hardcoded draw
[agents] Seeded 8 World Cup demo markets (skipped 0).
[agents] Agent address: 0x…
[agents] Scheduler online (POLL_MS=15000)
```

> **Demo mode is automatic.** The agents service detects that `AGENT_PRIVATE_KEY` isn't a funded signer and runs the WC demo seed at boot, populating 8 upcoming-match markets in SQLite so the home page is alive.

### Quick health checks (in another terminal)

```bash
# Liveness
curl -s http://localhost:3001/health | jq .

# All 14 agents registered with the scheduler
curl -s http://localhost:3001/agents/manifest | jq '.[] | {name, cron}'

# World Cup data
curl -s http://localhost:3001/wc/groups | jq '.groups | length'   # 12
curl -s http://localhost:3001/wc/schedule | jq '.matches | length'  # 72
curl -s http://localhost:3001/wc/upcoming | jq '.upcoming | length'

# Markets mirror (should include 8+ WC markets)
curl -s http://localhost:3001/markets | jq 'length'

# Last 5 agent decisions
curl -s http://localhost:3001/decisions | jq '.[0:5]'
```

Expected:
- `/wc/groups` → 12
- `/wc/schedule` → 72
- `/markets` → 8+ (8 WC demo + any others from the generic creator)
- `/decisions` shows entries from `WorldCupCreator` (action: `create_demo`) and `WorldCupMaker` (action: `quote_demo`)

## 5. Start the web app (~3s)

In a **second terminal** (keep the agents service running):

```bash
pnpm dev:web
```

Open <http://localhost:3000>. You should see:

- A green "World Cup 2026 prediction markets" banner at the top
- A live ⚽ ticker on the home page with next 5 group matches
- The 12-group grid below
- The bottom nav: Home / ⚽ World Cup / Markets / 👥 Friends / You
- The streak profile on the left, the Daily WC card on the right

### What to click through (E2E happy path)

| Step | Route | What you should see |
|------|-------|---------------------|
| 1 | `/worldcup` | 12-group grid, next-match teaser (countdown), MD1 list of 24 matches |
| 2 | `/worldcup/group/A` | Mexico 🇲🇽, South Africa 🇿🇦, South Korea 🇰🇷, Czechia 🇨🇿, 6 fixtures by matchday |
| 3 | `/worldcup/group/Z` | "Group not found" card with "See all groups" CTA (validates the 404) |
| 4 | `/markets?category=worldcup` | Filtered to just WC markets |
| 5 | `/markets` → any WC market | Order book, Friends widget (if you have friends), Share to X |
| 6 | `/friends` | Empty state → add a Sui address (0x…64 hex) → see their open positions |
| 7 | `/leaderboard` | "Friends only" checkbox (if you have friends) |
| 8 | `/agents` | Live decision feed — filter by `WorldCupCreator` / `WorldCupMaker` |

### Smoke test (optional, but recommended)

```bash
pnpm smoke-test
```

This runs the on-chain E2E:
1. `sui client publish` to deploy the Move package
2. `create_market` on-chain
3. `mint_shares` to mint 1 YES + 1 NO bundle
4. `place_limit_order` on the DeepBook pool

Requires `AGENT_PRIVATE_KEY` in `.env` and a few SUI of gas. The script exits non-zero on any hard failure; soft failures (e.g. no testnet oracle) print a `WARN:` and continue.

## 6. Verify each production-grade invariant

| What | How | Expected |
|------|-----|----------|
| Move contracts build | `pnpm contracts:build` | 0 errors, 14 linter warnings (all pre-existing `unused_use` / `implicit_const_copy`) |
| Move unit tests | `pnpm contracts:test` | `Test result: OK. Total tests: 122; passed: 122; failed: 0` |
| WC fetcher + Elo | `pnpm --filter @suipredict/agents test:wc` | 8/8 pass |
| All packages build | `pnpm build` | 4 successful, 4 total |
| Agents service up | `curl -sf http://localhost:3001/health` | 200 + JSON with `network`, `grpc_url`, `ts_ms` |
| All 14 agents in manifest | `curl -s http://localhost:3001/agents/manifest \| jq length` | 14 |
| 12 WC groups | `curl -s http://localhost:3001/wc/groups \| jq '.groups \| length'` | 12 |
| 72 WC matches | `curl -s http://localhost:3001/wc/schedule \| jq '.matches \| length'` | 72 |
| At least 8 demo WC markets | `curl -s http://localhost:3001/markets \| jq 'map(select(.category=="worldcup")) \| length'` | ≥ 8 |
| Friend widget works | add a friend in `/friends`, then visit any market detail | widget shows the friend's position (or "no position") |
| 404 for invalid WC group | visit `/worldcup/group/Z` | "Group not found" card |
| Markets category filter | `/markets?category=worldcup` | only WC markets |
| Friends-only leaderboard | `/leaderboard` after adding a friend | "Friends only" checkbox appears |

## 7. On-chain mode (optional, real txs)

This is for if you want to see the actual `create_market` → `mint_shares` → `place_limit_order` flow on testnet. The user has already deployed their self-hosted DeepBook (per the project notes) — make sure `DEEPBOOK_PACKAGE_ID` and `DEEPBOOK_REGISTRY_ID` in `.env` point to that.

### What you need

1. `sui` CLI installed and configured: `sui client new --alias testnet --rpc https://fullnode.testnet.sui.io:443`
2. Funded testnet wallet: `sui client faucet` (or use the Mysten faucet web UI)
3. Export the private key: `sui keytool export --key-identity <your-address>` — paste it as `AGENT_PRIVATE_KEY=...` in `.env`

### Bootstrap (one-time per fresh deploy)

```bash
# 1. Publish the Move package
cd packages/contracts
sui client publish --gas-budget 500_000_000 --json \
  | jq -r '.objectChanges[] | select(.type=="published").packageId' \
    > ../../.AGENT_POLICY_PACKAGE_ID
echo "AGENT_POLICY_PACKAGE_ID=$(cat ../../.AGENT_POLICY_PACKAGE_ID)" >> ../../.env
cd ../..

# 2. Bootstrap the shared objects (FeeVault, PrizePool, StreakRegistry, etc.)
pnpm --filter @suipredict/agents bootstrap

# 3. (Optional) Bootstrap the parlay pool
pnpm --filter @suipredict/agents bootstrap-parlay

# 4. Verify every shared-object ID matches the on-chain state
pnpm --filter @suipredict/agents verify-config
```

### Run the agents service in on-chain mode

```bash
# Stop the demo-mode agents service first (Ctrl+C)
pnpm dev:agents
```

This time the boot log should show:
```
[wc-creator] no DEEP for X1v3; falling back to demo row   # for the first run only
[wc-creator] ... tx <digest>                              # subsequent runs
[wc-resolver] X1v3 → YES (3-1, tx <digest>…)              # after a match finishes
```

Verify on Suiscan: `https://suiscan.xyz/testnet/object/<market_id>`.

## 8. Common issues

| Symptom | Cause | Fix |
|---------|-------|-----|
| `pnpm build` fails on `tsx` | stale `dist/` | `rm -rf apps/agents/dist && pnpm build` |
| `[agents] World Cup demo seed failed: Could not locate the bindings file` | `better-sqlite3` native module not built | `pnpm rebuild better-sqlite3` |
| `curl http://localhost:3001/wc/upcoming` returns `[]` | demo seed crashed (often the better-sqlite3 issue above) | check `/tmp/agents.log`, rebuild native binding, restart agents |
| `pnpm test:wc` SyntaxError on `predictYesProbability` | wrong import path | import from `world-cup-maker.js`, not `world-cup-fetcher.js` |
| `curl http://localhost:3001/wc/groups` returns empty array | rate-limited Wikipedia | the fetcher falls back to the hardcoded draw automatically; this is logged at boot |
| Home page shows no WC markets | agents service not started yet | start `pnpm dev:agents` in another terminal; the seed runs at boot |
| `/worldcup/group/Z` shows "Group Z" forever | the validator was missing in older code | pull the latest `main` — there's an explicit A–L allowlist now |
| `sui move test` complains about testnet SUI | needed only for on-chain smoke | skip for demo mode |
| `pnpm dev:web` port 3000 in use | another service on 3000 | `PORT=3005 pnpm dev:web` |
| Friend widget shows "Unreachable" | agents service down | `pnpm dev:agents` and refresh |

## 9. Tear down

```bash
# Stop both processes
pkill -f "tsx watch src/index.ts"
pkill -f "next dev"

# (Optional) wipe the SQLite mirror to start fresh
rm -rf apps/agents/data/*.db
```

You're back to a clean state. The agents service will re-seed the 8 demo WC markets on next boot.

## 10. What's NOT covered by this guide

- **Mainnet deploy** — see `docs/SOP-DEPLOYMENT.md` §4
- **Key rotation** — see `docs/SOP-DEPLOYMENT.md` §7
- **Vercel deploy of the web app** — see `docs/SOP-DEPLOYMENT.md` §8
- **Agent key custody / production secrets** — see `docs/SOP-DEPLOYMENT.md` §9
