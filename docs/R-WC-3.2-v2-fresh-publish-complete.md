# R-WC-3.2 — v2 fresh-publish complete

**Date:** 2026-06-18
**Status:** v2 bytecode live on testnet at new package id; agents service deployed; drift warning active; migration not done.

---

## What's live now

| Component | id | Notes |
|---|---|---|
| v2 fresh-publish package | `0x2ea40c796ccacfc345bad5f92c1138ace461fd1720ad507577e51c116e43f1e0` | 11 modules, version=1 |
| v2 UpgradeCap | `0xc6d1c2a8e8a72fed3ca1b931b74add32be304ea264badb1dbd1fce1aaed8afda` | Owned by deployer |
| Legacy v1 package (still live) | `0xb1777f167c29dbf1d0bf6e014157b3afd377608703d4935106989a0bb2be3ebf` | Owns the on-chain AgentPolicy + MarketRegistry shared objects |
| Legacy v1 UpgradeCap | `0x646dfdb6d287bb00210c060976ceb309d67456a9132cbe7d529c1f21b9b8181a` | Owned by deployer |
| Live AgentPolicy shared object | `0xb624f2fc78e78747e0d432160002a10bc685290e29846709ffaf9842d55a4570` | objType stamped with v1 package id |
| Railway env (6 vars) | All point at v2 fresh id | `AGENT_POLICY_PACKAGE_ID` etc. |
| Agents service deployment | `32d79418...` (SUCCESS) | image digest `sha256:2742ef2a120ed...` |
| `/health` package_id response | `0x2ea40c796...` | v2 fresh — confirms env propagated |

## What works now

- **Move source v2 is live.** Any new market created via `sui::client` PTBs that pass
  `<Q, M>` as type args to the v2 package's `create_market<Q, M>` will succeed
  with a unique `YES<Q, M>` coin type — CoinRegistry limit bypassed.
- **SDK helpers wired.** `yesCoinType(m)`, `withMarketType(tx, m)`, `marketTypeSeed(s)`,
  `addressOf(id)` all build correct type tags for the new package id.
- **Agents service running v2.** Scheduler online, all 13 workers registered,
  position-indexer tailing Sui events.

## What's still broken

- **`AGENT_POLICY_PACKAGE_ID drift`** — runtime expects v2; on-chain AgentPolicy
  shared object is stamped with v1. The agents service logs this warning at boot:
  ```
  [agents] AGENT_POLICY_PACKAGE_ID drift detected!
            env:     0x2ea40c796...
            on-chain:0xb1777f167c... (from 0xb624f2fc78...)
            The RiskMonitor's pause tx will fail with
            CommandArgumentError. Update your .env to:
              AGENT_POLICY_PACKAGE_ID=0xb1777f167c...
  ```
  RiskMonitor's auto-pause logic will fail (but it doesn't pause in normal operation).
- **`MarketMaker` skipping existing pools.** The legacy wc26 pool (`0xb36a0da3...`)
  was created against v1 — its YES coin type is `YES<DUSDC, v1_marker>`. The v2
  runtime expects `YES<DUSDC, v2_marker>`. The maker skips these pools.
- **`position-indexer` cursor mismatch spam.** Every tick re-bootstraps the cursor
  because the runtime package id changed. Not a hard error, just noisy logs.
- **wc-creator can create new markets** against v2 (different per-market M = different
  coin type), but the **on-chain MarketRegistry** is still v1-typed, so register_market
  calls will fail.

## What needs to happen next (post-demo)

To get the v2 fresh-publish fully wired, the on-chain shared objects need migration:

1. **Migrate AgentPolicy** from `0xb1777f167c...::agent_policy::AgentPolicy` →
   `0x2ea40c796...::agent_policy::AgentPolicy`. Field-by-field copy via PTB.
   Preserves: owner, agent, max_budget, spent, expires_at, revoked, paused.
   Same UID is replaced with a fresh UID (acceptable — the existing `AGENT_POLICY_ID`
   env var would need updating to the new object id).

2. **Migrate MarketRegistry** the same way. Market count and table entries preserved.

3. **Migrate FeeVault<DUSDC>**. Field-by-field. Balance transferred.

4. **Migrate StreakRegistry**. Table entries preserved.

5. **Migrate ProfileRegistry** + per-user **UserProfile** (each user migrates their own).

6. **Bootstrap a new wc26 market** against v2 (per-market M = marketTypeSeed(dedupeKey)).
   Existing legacy wc26-A1v4 stays at v1 package; new markets go through v2.

7. **Update env vars** `AGENT_POLICY_ID`, `MARKET_REGISTRY_ID`, `FEE_VAULT_ID`,
   `STREAK_REGISTRY_ID`, `NEXT_PUBLIC_PROFILE_REGISTRY_ID` to the new (migrated)
   shared object ids.

8. **Force a clean rebuild** of the agents service to pick up the new shared
   object ids (image digest changes).

Estimated 2-3 hours of focused work for steps 1-5 (Move migration functions +
PTB scripts), 30 min for steps 6-8.

## Why this is OK for the demo

The demo doesn't need the on-chain wc-creator to be functional. It needs:
- ✅ The web UI to show seeded markets (uses SQLite data, not on-chain)
- ✅ The market detail page to render (uses SQLite + cached Sui state)
- ✅ The leaderboard + friends + portfolio pages (all SQLite-backed)
- ✅ The agent decision feed (`/agents`) — uses API routes
- ✅ The `/health` endpoint to confirm agents service is online
- ✅ The Vercel web bundle to build (already does — `apps/web` compiles)

What the demo **does** need is:
- Agents service alive and returning data — ✓ (deploy 32d79418 SUCCESS, scheduler online)
- A working markets list — ✓ (SQLite seeded)
- Vercel web up — should be, but not verified this session

The drift warning + MarketMaker skip are *operational* issues, not demo-blockers.
The viewer sees a working predictions market UI backed by 13 autonomous agents.

## Files in this commit

- `packages/contracts/Move.toml` — reverted the [published.testnet] block added in 748a47a
- `packages/contracts-v1-compat/` (new) — v1 source + R-WC-3.1 field-extractor entrypoints,
  used during the (failed) v1.5 additive upgrade attempt. Preserved for future work.
- `packages/contracts/Published.toml` — auto-regenerated by `sui client publish`,
  gitignored so not committed.

## Operational notes for the next session

- The v2 UpgradeCap (`0xc6d1c2a8...`) controls future upgrades of the v2 package.
  Policy is `additive` (0.0) by default. To upgrade, run:
  ```
  cd packages/contracts && sui client upgrade --upgrade-capability 0xc6d1c2a8...
  ```
- The v1 UpgradeCap (`0x646dfdb6...`) is now **useless** — the live AgentPolicy
  shared object is the only consumer of v1's bytecode, and once it's migrated,
  v1 has no more on-chain references. The v1 cap can be left untouched.
- If the migration never happens, env vars should be reverted to v1 (`0xb1777f167c...`)
  to match the on-chain AgentPolicy stamp and clear the drift warning.