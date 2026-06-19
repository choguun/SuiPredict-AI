# R-WC-3.3 v3 — Deployment complete

**Date:** 2026-06-19
**Status:** v3 contract published + live. SDK + agents + web wired to v3. wc-creator verification pending.

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