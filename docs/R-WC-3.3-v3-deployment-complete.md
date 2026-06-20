# R-WC-3.3 v3 — Deployment complete

**Date:** 2026-06-19
**Status:** ✅ v3 contract published, SDK + agents + web wired, **wc-creator verified end-to-end — 1 on-chain market created at 11:00 (Vietnam) with 0 failures**.

---

## v3 testnet deployment

| Object | ID |
|---|---|
| Package | `0xe98b0c9c215859ef937803ca9a2f4f94fd649c3a701fcb5b6850c115d9773dac` |
| UpgradeCap | `0xd70ad5ff99830484791832e79220ad970f9838d628e674abd0d93e6ef1ed2a1a` |
| ProtocolAdminCap | `0x0a524de93644a9e81f63403a35bcb3d5a0d916fd52b1e8b2d09f1fe33186ee53` |
| SharedTreasuryHolder\<DUSDC\> | `0x90a788b27d328728711567d220d16131a9ad83973a5a5748035b9f2b0df947e1` |

The `SharedTreasuryHolder<DUSDC>` was created via `init_yes_no_currencies<DUSDC>(admin_cap, coin_registry, ctx)` — a one-shot init that registered `Currency<YES<DUSDC>>` and `Currency<NO<DUSDC>>` in the Sui CoinRegistry exactly once per package. All subsequent `create_market<DUSDC>` calls borrow the caps from this shared holder, bypassing the CoinRegistry's one-Currency-per-type-per-package limit.

## Env vars

**Railway (agents service):**
- `AGENT_POLICY_PACKAGE_ID`, `MARKET_PACKAGE_ID`, `PREDICT_PACKAGE_ID` → v3 package
- `NEXT_PUBLIC_*` variants → v3 package
- `SHARED_TREASURY_HOLDER_ID` → `0x90a788b2...`
- `TURBO_FORCE` → `true` (busts stale Remote Build Cache; remove once stable)

**Vercel (web):**
- `AGENT_POLICY_PACKAGE_ID`, `MARKET_PACKAGE_ID`, `PREDICT_PACKAGE_ID` → v3 package
- `NEXT_PUBLIC_*` variants → v3 package
- `SHARED_TREASURY_HOLDER_ID`, `NEXT_PUBLIC_SHARED_TREASURY_HOLDER_ID` → `0x90a788b2...`

## SDK changes

- `SHARED_TREASURY_HOLDER_ID` constant added to `prediction-market-client.ts`, exported from barrel `index.ts`
- `buildCreateMarketTx` / `buildCreateMarketWithPoolTx`: arg 0 is now `tx.object(SHARED_TREASURY_HOLDER_ID)` (was `tx.object("0xc")`)
- `buildMintSharesTx` / `buildRedeemTx` / `buildRedeemNoTx` / `buildRedeemWithStreakTx` / `buildRedeemNoWithStreakTx`: take optional `sharedCapsId` (defaulting to `SHARED_TREASURY_HOLDER_ID`), inserted as the second PTB arg

## Contract design

`SharedTreasuryHolder<Q>` stores YES/Q + NO/Q TreasuryCaps as `dynamic_object_field` entries (Sui's standard pattern for `key + store` objects on a `key` struct). `PredictionMarket<Q>` no longer holds the caps inline — it records `shared_caps_id: ID`. `mint_shares` / `redeem` borrow the caps via `borrow_yes_cap_mut` / `borrow_no_cap_mut` (sequential borrows due to Move's borrow checker).

**130/130 Move tests pass** (updated to call `new_shared_caps_for_testing` + thread the shared caps through).

## Known follow-ups

1. **`TURBO_FORCE=true`** should be removed from Railway once the v3 deploy stabilizes (it forces a full rebuild on every deploy, which is slow).
2. **Force-committed SDK `dist/`** should be removed from git tracking once turbo's Remote Cache is cleared (run `turbo clean --force` locally, then a fresh deploy to warm the cache with v3).
3. **FeeVault\<DUSDC\>** needs to be initialized on the v3 package via `init_fee_vault_fallback<DUSDC>(ctx)` — the current `FEE_VAULT_ID` env points at the v1 FeeVault.
4. **MarketRegistry / AgentPolicy / StreakRegistry** are still stamped with v1 (`0xb1777f167c…`). The wc-creator will hit `AGENT_POLICY_PACKAGE_ID drift` until these are migrated. This is non-blocking for market creation (register_market is best-effort).

## Verification pending

The wc-creator runs every 15 min (`*/15 * * * *`). The next run after the v3 deploy will confirm whether `create_market<DUSDC>(shared_caps, deepbook_registry, ...)` succeeds on-chain. The direct local test confirmed arg 0 (shared caps) is accepted — the remaining question is whether the agent has DEEP coins for pool creation.

## Verification — DONE (commit 85541ba + be1941a)

The 11:00 (Vietnam) run of `world-cup-creator` against the v3 package succeeded end-to-end: **1 on-chain market created, 0 failures**. Logs:

```
[wc-creator] B3v4 success: digest=… shared_caps=0x90a788b2… deepbook=0xdee9…
[scheduler] WorldCupCreator → create_wc: WC: created 1 on-chain markets, 0 failed. Window: 25 matches in 7d, cap 4.
```

### SDK fix that made it work

`packages/sdk/src/predict-client.ts` — the `executeTransaction` retry loop
was extended to also rebuild the PTB on `Invalid withdraw reservation`
and `is less than requested` errors (not just `Transaction needs to be
rebuilt` and `is unavailable for consumption`). The root cause was
Sui's coin-accumulator reservation being scoped to a single gas coin
— when the agent's only gas coin (`0x8a541bc…`) was concurrently
consumed by a sibling agent's PTB, the wc-creator's `tx.setSender` /
implicit coin-reservation snapshot became stale and Sui rejected the
draw with a reservation error rather than the older "is unavailable
for consumption" message.

The fix has two halves:

1. **Rebuild + re-pin gas coin on the new errors** (`predict-client.ts:326`) — when the rejection is a reservation race, reconstruct the `Transaction` from a `txFactory` closure, list fresh gas coins via `listAllCoins()`, and `tx.setGasPayment([{ objectId, version, digest }])` so the rebuilt PTB pins the highest-balance coin at its current on-chain version+digest. The reservation then succeeds on the retry because no concurrent consumer can claim that exact (object, version) tuple in the same checkpoint.
2. **Decode the error string with `decodeURIComponent`** before the transient regex match — Sui gRPC sometimes returns percent-encoded error text, which previously slipped past `/Invalid\s+withdraw\s+reservation/i`.

The transient-regex is now:

```ts
/(429|TooManyRequests|408|502|503|504|fetch failed|ETIMEDOUT|ECONNRESET|ECONNREFUSED|socket hang up|Service Unavailable|Bad Gateway|Gateway Timeout|Request timeout|Too Many Requests)/i
/Transaction\s+needs\s+to\s+be\s+rebuilt/i
/is\s+unavailable\s+for\s+consumption/i
/Invalid\s+withdraw\s+reservation/i
/is\s+less\s+than\s+requested/i
```

`predict-client.ts:155-175` introduces `pinFreshGasCoin(tx)` and the
`txFactory` pattern that lets the retry loop re-execute the same
`client.signAndExecuteTransaction` against a brand-new `Transaction`
instance with a freshly-listed gas coin.

### Railway snapshot-cache gotcha

A non-obvious deployment pitfall bit us while landing the fix: `railway
redeploy --yes` redeploys the **last deployment's image** (cached),
NOT the latest commit's source tree. So a code change that was
correctly committed, pushed, and merged to `main` would still boot
the previous commit's bytecode on Railway — and the only symptom was
"the deployed code doesn't include my fix". The fix:

```bash
railway up --detach --yes -m "<commit msg>"
# OR
railway redeploy --from-source --yes
```

`railway up` always forces a fresh source build; `railway redeploy
--from-source` is the explicit flag. The plain `railway redeploy`
form is now considered broken for code changes (env-only is fine).

`railpack.json` was already correctly configured with `deploy.startCommand`
that re-runs `pnpm --filter @suipredict/sdk build && pnpm --filter
@suipredict/agents build` at container start, so the dist is always
fresh even when the image itself is reused.

## Known follow-ups (updated 2026-06-19)

1. **`TURBO_FORCE=true`** still set on Railway. Remove once the wc-creator has
   24h of clean runs (currently 1 confirmed success). Forces a full rebuild
   on every deploy — slow, but it bypasses turbo's stale Remote Cache.
2. **Force-committed SDK `dist/`** still tracked. Plan: once turbo's
   Remote Cache is cleared, stop tracking `packages/sdk/dist/` (it's
   gitignored by default with the trailing-slash rule). The
   `gitignore` exception that force-tracks the dist exists only
   because the Railway snapshot cache was previously serving stale
   dist files; now that we always `railway up --detach` and the
   startCommand rebuilds from src, this workaround can be removed.
3. **FeeVault\<DUSDC\>** still points at v1's `FeeVault` — needs
   `init_fee_vault_fallback<DUSDC>(ctx)` on the v3 package. The
   v3 package's `ProtocolAdminCap` is `0x0a524de9…` (see table at
   top of doc).
4. **MarketRegistry / AgentPolicy / StreakRegistry** still stamped
   with v1 (`0xb1777f167c…`). The wc-creator's `register_market` PTB
   surfaces a `AGENT_POLICY_PACKAGE_ID drift` warning on each tick
   but is best-effort (the v3 `MarketRegistry` is created lazily on
   first success). See [R-WC-3.3-v3-wc-creator-success.md](R-WC-3.3-v3-wc-creator-success.md)
   for the migration plan.
5. **Cleaned up diagnostic noise** (commit `be1941a`): reverted the
   temporary `[agents-load]` sentinel log in `apps/agents/src/index.ts`,
   the `ls`/`grep`/`echo` debug in `railpack.json`, and the per-regex
   boolean fields in `[executeTransaction:diag]`. The diag log is
   back to a single line per attempt.