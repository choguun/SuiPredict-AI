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

### ⚠️ CRITICAL BLOCKER discovered during attempted migration (R-WC-3.1)

Move's type system enforces that **a function in package A cannot accept an
object typed against package B**, even if the struct shapes are byte-identical.
So a v2 `migrate.move` cannot write:

```move
public fun migrate_agent_policy(old: agent_policy::AgentPolicy_v1, ...) { ... }
```

and have it accept the on-chain `0xb1777f167c...::agent_policy::AgentPolicy`
object, because Move resolves `agent_policy::AgentPolicy_v1` to the v2 package
import, not the v1 package.

**Workarounds considered:**

1. **Mirror v1 struct shapes in `migrate.move`** — `public struct AgentPolicyV1 has key { ... }`.
   Move accepts this because the *struct shape* matches, but at the BCS / type-tag
   layer the runtime still rejects the PTB because the object's actual type tag
   (encoded in `objType`) is `0xb1777f167c...::agent_policy::AgentPolicy`, not
   `0xNEW...::migrate::AgentPolicyV1`. Confirmed by writing a draft `migrate.move`
   that fails the BCS check at PTB-build time.

2. **Add field-extractor methods to the v1 package itself** (e.g.
   `agent_policy::extract_all_fields(old): (address, address, u64, ...)`) then
   re-construct in v2. Requires upgrading the v1 package — but adding new
   methods is signature-additive, which the v1 cap's `additive` policy
   (`policy = 0.0`) actually permits. This works.

3. **Use Sui's framework-level `0x2::object` to read raw bytes** — not exposed
   in safe Move. Requires a custom sui CLI command or off-chain Sui RPC
   `sui_getObject` to read fields, then re-broadcast a creation tx. Doable but
   complex.

4. **Use the v1 package as a library at v2 publish time** — Move doesn't
   support cross-package destructuring of non-copy types.

**Recommended path: workaround #2** — write a v1.5 upgrade that adds
field-extractor entrypoints to the v1 package, then have v2's `migrate.move`
call them.

#### Step 1a: Upgrade v1 package (`0xb1777f167c...`) to add field extractors

Use the existing UpgradeCap `0x646dfdb6d287bb00210c060976ceb309d67456a9132cbe7d529c1f21b9b8181a`.
The upgrade must be a `compatible` upgrade (additive only — no signature changes
to existing functions). The new code adds:

```move
// in agent_policy.move
public fun extract_agent_policy(old: AgentPolicy): (
    address, address, u64, u64, u64, bool, bool, // owner, agent, max_budget, spent, expires_at, revoked, paused
) {
    (old.owner, old.agent, old.max_budget, old.spent, old.expires_at, old.revoked, old.paused)
}

// in registry.move
public fun extract_market_registry(old: MarketRegistry): (address, u64, vector<ID>) {
    let mut ids = vector[];
    let mut i = 0;
    while (i < old.market_count) {
        vector::push_back(&mut ids, *table::borrow(&old.markets, i));
        i = i + 1;
    };
    (old.admin, old.market_count, ids)
}

// in streak_system.move
public fun extract_streak_registry_keys(old: StreakRegistry): vector<address> { ... }
// + extract_user_streak_ids(...) returning vector<ID> for the values
```

This upgrade *can* succeed because it's purely additive (new public functions
that return copies of field values). Policy `additive` permits this.

#### Step 1b: Fresh-publish v2 with `migrate.move` that calls v1 extractors

The fresh-publish v2 package imports v1 (yes, v2 imports v1 — backward import
is allowed):

```move
// in v2 migrate.move
use suipredict_v1::agent_policy::{Self, AgentPolicyV1};  // the v1 package

public fun migrate_agent_policy(old: AgentPolicyV1, ctx: &mut TxContext) {
    let v1_id = object::id(&old);
    let (owner, agent, max_budget, spent, expires_at, revoked, paused) =
        agent_policy::extract_agent_policy(old);
    // v1 object is consumed by extract_agent_policy (move-by-value into the function)
    // construct v2-typed AgentPolicy
    let new = agent_policy::create_policy_with_state(
        agent, max_budget, expires_at, owner, spent, revoked, paused, ctx,
    );
    transfer::share_object(new);
}
```

This works because `extract_agent_policy` takes the v1 AgentPolicy by value
(consuming it), reads its fields (which are all primitives + bools — copy
types), and returns the field values. The caller then has the values and the
v1 object is gone. The caller constructs a v2 AgentPolicy with the same field
values and a fresh UID.

#### Step 2: Move tests

`tests/migrate_tests.move`:
- Test extract_agent_policy returns expected tuple
- Test migrate_agent_policy produces a v2 AgentPolicy with same field values
- Test MarketRegistry migration preserves all market IDs
- Test StreakRegistry migration preserves all streak IDs

#### Step 3: Agent-side migration script

`apps/agents/scripts/migrate-v2.ts`:
- Builds a PTB per shared object that calls the appropriate `migrate_*` function
- Signs with the deployer key (env: `AGENT_PRIVATE_KEY`)
- Executes against testnet sequentially
- Verifies each tx succeeded before moving to the next

For `FeeVault<Q>`: this is tricky because it holds `Balance<Q>`. The migration
needs to extract the balance amount, consume the v1 vault, and create a v2
vault with the same balance. Add an extractor that returns the balance value,
then re-constructs with `balance::create_for_testing` or by withdrawing from a
temp `Coin<Q>` that the v1 vault transfers to.

For `UserProfile`: per-user, owner-signed. Each user calls migrate_user_profile
themselves.

#### Step 4: Publish v2 to fresh package id

After v2 `migrate.move` is in place and tested:
```bash
rm packages/contracts/Published.toml
sui client publish --upgrade-capability 0x...  # fresh publish
```

This gets a new package id `0xNEW...` for v2.

#### Step 5: Update env vars + redeploy

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