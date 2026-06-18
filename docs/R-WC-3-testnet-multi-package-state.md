# R-WC-3 — Testnet Multi-Package State & Migration Plan

**Date:** 2026-06-18
**Status:** Code in main is v2; live deployment is on three v1 packages; migration NOT done.

---

## TL;DR

The Sui testnet has **three parallel `suipredict_agent_policy` packages** live, all
owned by deployer `0x0cdc0f4df0...`. Each has its own UpgradeCap. The code in
`main` is v2 (with `YES<Q, M>` + `parlay<M>` generics) and the Move build passes
130/130 unit tests, but **none of the live packages can be `sui client upgrade`-ed
to v2** because v2's source adds a phantom `M` type parameter to existing public
functions, and a `compatible` (or `additive` policy 0.0) upgrade forbids signature
changes. The `R-WC-2` design that adds `<M>` to `PredictionMarket<Q>` →
`PredictionMarket<Q, M>` is incompatible with the bytecode that's actually deployed.

The wc-creator + pool-provisioner are still on the SQLite `demo-*` fallback; the
new `YES<Q, M>` design is not reachable in production until migration completes.

---

## What got built in R-WC-2 (working, on `main`)

| Commit | What |
|---|---|
| `408a846` | Move: `prediction_market.move` upgraded to `YES<Q, M>` + `parlay<M>` |
| `aac7dbb` / `d63158a` | SDK: `yesCoinType`, `addressOf`, `withMarketType`, `marketTypeSeed` helpers |
| `440aacf` | Generic agents (market-creator/maker/resolver) wired with `withMarketType` |
| `bd76b14` | Web PTBs wired with `withMarketType` |

130/130 Move unit tests pass. SDK typechecks. Agents typecheck. Web builds.

## What got published (partially) on testnet

| Action | Result |
|---|---|
| `sui client upgrade --upgrade-capability 0xa887b56e...` | **Succeeded** → v2 bytecode at `0x4c12d028692dfad72e25309be080cbc3fbeaf8f5b9adc8379771b66218828ece`, version=2 |
| Live AgentPolicy package upgrade | **Failed** (`PackageIDDoesNotMatch` and `Compatibility E01005`) |

The successful upgrade was on `0x0279d1ec...` → `0x4c12d028...`, which is a
**parallel testnet deployment that is NOT referenced by Railway**. No code on
Railway ever pointed at `0x0279d1ec...` or `0x4c12d028...`.

The v2 bytecode at `0x4c12d028...` is currently orphaned.

## Live testnet state (as of 2026-06-18 ~10:00 UTC)

### Deployer
`0x0cdc0f4df0284828adde270ab50db083341135562866c26404ec945597d49716`

### Three live `suipredict_agent_policy` packages, all version=1

| Env var | Package id | Modules | UpgradeCap |
|---|---|---|---|
| `AGENT_POLICY_PACKAGE_ID` | `0xb1777f167c29dbf1d0bf6e014157b3afd377608703d4935106989a0bb2be3ebf` | 8 (no `parlay`, no `badge_nft`, no `user_profile`) | `0x646dfdb6d287bb00210c060976ceb309d67456a9132cbe7d529c1f21b9b8181a` |
| `MARKET_PACKAGE_ID` | `0xed3e3613a12cced2531d46849553b0fcc70a65fc243c5ebc71377ab0d03c20d1` | 11 (full) | `0x1a28be1f885310ff8cede54b839cac0df7c35691418109b1b8a8124efb080e78` |
| `PREDICT_PACKAGE_ID` | `0x86da679b460586b8494e8e9351bfe8ed541033e4189ac98cad91ae38b4a06b0e` | 11 (full) | `0xb2c61b41e14731b35a0e66c39725d2f14da77de9194cdb111223bcaf83289343` |

### Live shared objects (stamped with `0xb1777f167c...::agent_policy::*`)

| Object | id |
|---|---|
| `AgentPolicy` | `0xb624f2fc78e78747e0d432160002a10bc685290e29846709ffaf9842d55a4570` |
| `MarketRegistry` | `0xdcd4798ac2043e10adb49e3f0f64ca102d47b0cca9e3060095309fb670be286a` |
| `FeeVault` | `0xb8618f66652a958e748088bb502fa47fabbbc6434fe042f2b95bc1c9d204e28f` |
| `StreakRegistry` | `0x271737248b255a...` |

(StreakRegistry id is truncated — read full id from Railway env: `STREAK_REGISTRY_ID`.)

### Why the env points at `0xb1777f167c...` for all three

`apps/agents/src/index.ts` (the boot sequence) treats `AGENT_POLICY_PACKAGE_ID` as
canonical and `MARKET_PACKAGE_ID` / `PREDICT_PACKAGE_ID` as legacy aliases. When
they disagree, it logs a one-time warning and uses `AGENT_POLICY_PACKAGE_ID`. All
agent calls route through that one package.

### Drift check

`apps/agents/src/index.ts` reads the on-chain `AgentPolicy.objType` at boot and
compares it against `AGENT_POLICY_PACKAGE_ID`. Currently:
- `AgentPolicy.objType` = `0xb1777f167c...::agent_policy::AgentPolicy`
- `AGENT_POLICY_PACKAGE_ID` (env) = `0xb1777f167c...`

Match → no drift warning. Drift was triggered and cleared during this session.

---

## Why `sui client upgrade` won't work

The `0xb1777f167c...` package has `PredictionMarket<Q>` (1 type param). The v2
source has `PredictionMarket<Q, M>` (2 type params). Adding a phantom type
parameter to a public function signature is a signature change, which:
- `policy = 0.0` (additive) — forbidden
- `policy = 1.0` (compatible) — forbidden
- `policy = 2.0` (dependency-only) — forbidden

So **no upgrade can bridge v1 → v2**. A fresh publish + object migration is the
only path.

---

## Migration path (next session)

### Step 1: Write `migrate.move`

For each shared object type, write a function that takes the v1 object as input,
reads every field, and constructs a new shared object of the same v1 shape but
typed against the new v2 package. The new objects must preserve field values:

```move
module suipredict_agent_policy::migration;

public fun migrate_agent_policy(
    old: AgentPolicy_v1,  // from 0xb1777f167c...
    ctx: &mut TxContext,
): AgentPolicy_v2 {
    let AgentPolicy_v1 { id, agent, expires_at, max_budget, owner, paused, revoked, spent } = old;
    object::delete(id);
    let new = AgentPolicy_v2 { id: object::new(ctx), agent, expires_at, max_budget, owner, paused, revoked, spent };
    transfer::share_object(new);
    ...
}
```

Affected objects:
1. `AgentPolicy` (8 fields)
2. `MarketRegistry` (read fields)
3. `FeeVault` (read `fee_balance: Balance<Q>`, transfer to new vault)
4. `StreakRegistry` (read `streaks: Table`)
5. (Optional) `UserProfileRegistry`

For each, decide: is the v1 and v2 layout identical (just different package id
in the type tag)? If yes, migration is purely a typed re-share — same fields,
same shape. If v2 added a field, supply a default.

For v2 specifically: did any of `agent_policy.move`, `registry.move`, `vault.move`,
`streak_system.move`, `user_profile.move` change shape between the v1 and v2
sources? Check `git log --oneline packages/contracts/sources/` for module-specific
commits. **If they're byte-identical**, migration is trivial (just re-type and
re-share). If they differ, supply defaults.

### Step 2: Move tests

`migrate_tests.move` for each migration function:
- Create v1 object with known fields
- Call migration
- Assert new object has same fields
- Assert new object is shared

### Step 3: Agent-side migration script

`apps/agents/scripts/migrate-v2.ts`:
- Builds a PTB that calls each `migrate_*` function in sequence
- Signs with the deployer key (env: `AGENT_PRIVATE_KEY`)
- Executes against testnet
- Verifies each tx succeeded

### Step 4: Publish v2 to fresh package id

After migration Move is in place:
```bash
rm packages/contracts/Published.toml  # remove the old (incorrect) original-id
sui client publish --upgrade-capability 0x...  # any upgrade-cap; this is a fresh publish
```

This gets a new package id `0xNEW...` for v2.

### Step 5: Update env vars + redeploy

```bash
AGENT_POLICY_PACKAGE_ID=0xNEW...  # the fresh-publish id
MARKET_PACKAGE_ID=0xNEW...
PREDICT_PACKAGE_ID=0xNEW...
NEXT_PUBLIC_AGENT_POLICY_PACKAGE_ID=0xNEW...
NEXT_PUBLIC_MARKET_PACKAGE_ID=0xNEW...
NEXT_PUBLIC_PREDICT_PACKAGE_ID=0xNEW...
```

(All three should point at the same fresh-publish id, per CLAUDE.md.)

### Step 6: Verify

- `pnpm contracts:test` still passes (130 tests)
- Agents boot, no drift warning, RiskMonitor pause tx succeeds
- wc-creator + pool-provisioner run end-to-end against the new v2 code

---

## Current Railway env state (committed, working)

All 6 package id env vars point at the **live v1 package** `0xb1777f167c...`:

| Var | Value |
|---|---|
| `AGENT_POLICY_PACKAGE_ID` | `0xb1777f167c29dbf1d0bf6e014157b3afd377608703d4935106989a0bb2be3ebf` |
| `MARKET_PACKAGE_ID` | same |
| `PREDICT_PACKAGE_ID` | same |
| `NEXT_PUBLIC_AGENT_POLICY_PACKAGE_ID` | same |
| `NEXT_PUBLIC_MARKET_PACKAGE_ID` | same |
| `NEXT_PUBLIC_PREDICT_PACKAGE_ID` | same |

Latest agents deployment: `07e49afd...` (2026-06-18 10:01 UTC), status SUCCESS.

---

## Files changed in this session

- `packages/contracts/Move.toml` — added `[published.testnet] original-id =
  0xb1777f167c...` (commit `748a47a`) so future Move builds declare the live
  testnet package id as the upgrade target. This does NOT enable the upgrade
  (signature compatibility is still the blocker); it just makes the build output
  consistent with the live deployment.

No other files modified.

---

## Estimate

- Write `migrate.move` + 5 migration functions + tests: 2-3 hours
- Write agent-side migration script: 30 min
- Fresh publish: 5 min
- Env var updates + redeploy + smoke test: 30 min
- **Total: 3-4 hours of focused work**, ideally in a fresh session