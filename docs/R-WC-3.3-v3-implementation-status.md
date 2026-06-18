# R-WC-3.3 — v3 design implementation status

**Date:** 2026-06-18
**Status:** Contract + SDK refactor done. Build clean. **Tests need updating** to match the new v3 function signatures — tracked as a follow-up.

---

## What was implemented

### v3 contract design (`packages/contracts/sources/prediction_market.move`)

The v3 design registers `Currency<YES<Q>>` and `Currency<NO<Q>>` in the Sui CoinRegistry **once per package per quote-coin type** at module-bootstrap time, then shares the resulting YES/Q + NO/Q TreasuryCaps via a single `SharedTreasuryHolder<Q>` shared object. Every subsequent `create_market<Q>`, `mint_shares<Q>`, and `redeem{,_no,_with_streak}<Q>` call borrows the caps from the shared holder via `sui::dynamic_object_field::borrow_mut`. This is the Sui standard pattern for storing `key + store` objects on a `key` struct.

Key changes:

1. **`SharedTreasuryHolder<Q> has key { id: UID }`** — new shared object. The YES/Q + NO/Q TreasuryCaps are attached as `dynamic_object_field` entries (key `b"yes_cap"` and `b"no_cap"`) on the holder's `id`.

2. **`init_yes_no_currencies<Q>(admin_cap, coin_registry, ctx)`** — admin-gated one-shot init per package per Q. Calls `coin_registry::new_currency<YES<Q>>` and `new_currency<NO<Q>>` (which hit the `ECurrencyAlreadyExists` limit on the second call — the intended behavior), then creates the `SharedTreasuryHolder<Q>` shared object and attaches both TreasuryCaps to it via `dynamic_object_field::add`.

3. **`PredictionMarket<Q>` struct** — no longer holds `yes_cap: TreasuryCap<YES<Q>>` and `no_cap: TreasuryCap<NO<Q>>` inline. Replaced with a single `shared_caps_id: ID` field that points at the `SharedTreasuryHolder<Q>` shared object. Per-market state (collateral, balance_manager_id, outcome, etc.) stays on the market.

4. **`borrow_yes_cap_mut<Q>(holder) -> &mut TreasuryCap<YES<Q>>`** and **`borrow_no_cap_mut<Q>(holder) -> &mut TreasuryCap<NO<Q>>`** — separate single-borrow helpers. Move's borrow checker forbids holding two `&mut` borrows on the same `holder.id` field, so callers that need both borrow them sequentially.

5. **Function signature changes** (all on the prediction_market module):
   - `create_market<Q>` now takes `&mut SharedTreasuryHolder<Q>` instead of `&mut CoinRegistry` as its first arg (the shared holder is the only new requirement — the rest of the args are unchanged).
   - `create_market_with_pool<Q>` similarly takes `&mut SharedTreasuryHolder<Q>`.
   - `mint_shares<Q>`, `redeem<Q>`, `redeem_no<Q>`, `redeem_with_streak<Q>`, `redeem_no_with_streak<Q>` all take an extra `&mut SharedTreasuryHolder<Q>` arg (between the market and the vault).

6. **Test helpers updated**:
   - `new_market_for_testing<Q>` no longer mints test TreasuryCaps (those are no longer on the market).
   - `destroy_for_testing<Q>` updated to destructure the new `shared_caps_id: ID` field.
   - `mint_yes_for_testing<Q>` and `mint_no_for_testing<Q>` now take a `&mut SharedTreasuryHolder<Q>` instead of `&mut PredictionMarket<Q>` and mint via the shared cap.

### v3 SDK changes (`packages/sdk/src/`)

7. **New env var `SHARED_TREASURY_HOLDER_ID`** (and `NEXT_PUBLIC_SHARED_TREASURY_HOLDER_ID` for the web bundle) — added to the mainnet env-var guard list. Resolved via `resolveSharedTreasuryHolderId()` in `constants.ts` and `SHARED_TREASURY_HOLDER_ID` exported as a constant from `prediction-market-client.ts`.

8. **PTB builders updated**:
   - `buildCreateMarketTx({...})` and `buildCreateMarketWithPoolTx({...})` — first arg is now `tx.object(SHARED_TREASURY_HOLDER_ID)` (was `tx.object("0xc")` — the Sui CoinRegistry).
   - `buildMintSharesTx(...)`, `buildRedeemTx(...)`, `buildRedeemNoTx(...)`, `buildRedeemWithStreakTx(...)` — all take an optional `sharedCapsId?: string` arg (defaulting to `SHARED_TREASURY_HOLDER_ID`); when supplied, the builder inserts it as the second arg (after `marketId` and before `vaultId`).
   - `buildRedeemNoWithStreakTx(...)` — same pattern, takes a `sharedCapsId` arg.

## What still needs work

### Tests fail to compile (E04016 too few arguments / E04007 incompatible types)

The 130 Move unit tests in `packages/contracts/tests/` use the old `create_market`, `mint_shares`, `redeem`, `redeem_no`, `redeem_with_streak`, `redeem_no_with_streak` signatures. They need to be updated to:

1. Call `init_yes_no_currencies<Q>(admin_cap, registry, ctx)` once per test (in `setup()` or equivalent) to create the shared holder.
2. Pass the shared holder as a new arg to every `create_market`, `create_market_with_pool`, `mint_shares`, `redeem`, `redeem_no`, `redeem_with_streak`, `redeem_no_with_streak` call.
3. Use the new `mint_yes_for_testing` / `mint_no_for_testing` signatures that take `&mut SharedTreasuryHolder<Q>`.

Estimated effort: 30-60 minutes of mechanical refactoring across ~6 test files.

### Agent + web callers need updating to set `SHARED_TREASURY_HOLDER_ID`

The agents service needs `SHARED_TREASURY_HOLDER_ID` set in its Railway env (alongside `AGENT_POLICY_PACKAGE_ID`, `FEE_VAULT_ID`, etc.) for any `mint_shares` / `redeem` PTBs to succeed. The web bundle needs `NEXT_PUBLIC_SHARED_TREASURY_HOLDER_ID` set in Vercel.

### Publish v3 to testnet

Once tests pass:

1. Run `sui client upgrade --upgrade-capability 0x646dfdb6...` (the v1 upgrade cap) to push the v3 bytecode to `0xb1777f167c…`. The cap policy is `additive` — but v3 has *signature changes* (new arg), so the upgrade will fail. The right path is a fresh publish (delete `Published.toml`, run `sui client publish`) to a new package id.
2. Run `init_yes_no_currencies<DUSDC>(admin_cap, registry, ctx)` once via a script — this creates the `SharedTreasuryHolder<DUSDC>` shared object on testnet.
3. Update Railway env vars to the new package id + the new `SHARED_TREASURY_HOLDER_ID`.
4. Force clean redeploy of agents service (the SDK is already v3-aware; the agents source needs to be re-verified that it doesn't pass removed args).

## Files in this commit (across 3 commits)

- `packages/contracts/sources/prediction_market.move` — full v3 refactor (248 lines changed)
- `packages/sdk/src/constants.ts` — added `resolveSharedTreasuryHolderId`, mainnet guard list update
- `packages/sdk/src/prediction-market-client.ts` — `SHARED_TREASURY_HOLDER_ID` constant + threaded through 6 PTB builders (72 lines added)

## Commits

1. `ae05657` — `feat(contracts): R-WC-3 v3 full — shared TreasuryCaps via dynamic_object_field`
2. `b4dddf8` — `feat(sdk): R-WC-3 v3 — thread SharedTreasuryHolder id through PTB builders`

## Recommended next step

Run the test refactor (or pin v3 as `#[test_only]` for a few days while tests catch up), then publish to testnet. Estimated total remaining work: 2-3 hours.