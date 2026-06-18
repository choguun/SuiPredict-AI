# R-WC — Final deployment state

**Date:** 2026-06-18 (late session)
**Status:** Demo is fully shippable. The wc-creator's on-chain market creation is blocked by a Sui v1+v2 multi-package divergence (documented); the SQLite-seeded markets serve the demo flow.

---

## What works

| Component | State |
|---|---|
| Move contract source | v1 (committed) — 130/130 tests pass |
| Live testnet package | `0xb1777f167c…` (older v1, 8 modules, version 1) |
| Move build | Clean, no errors, no new warnings |
| Railway env vars | All 6 package id vars point at `0xb1777f167c…` |
| `/health` package_id | `0xb1777f167c…` (matches env) |
| Agents service | Running (latest deploy `f9c4d052`, image `f4d46c8b…`) |
| Circuit-breaker | Reset (no false trips) |
| WC_FALLBACK_POOL_ID | Removed (legacy pool `0xddd7cbe5…` accessible via `findExistingYesPool`) |
| Web UI | Builds clean, type-checks clean, all typeScript types valid |
| Demo flow (web → agents → SQLite) | All API routes serving data; markets list, detail, friends, leaderboard, portfolio, agents decision feed all functional |

## What doesn't work

### wc-creator's `create_market` PTB aborts with `ArityMismatch in command 0`

The live `0xb1777f167c…` bytecode on testnet was published **before** the source's current R-WC-1.4 era. The on-chain `create_market<Q>` signature has a slightly different argument list than what my current source declares (the source has 11 args + ctx, on-chain has a different number). The SDK builds a PTB that matches the **source** but the on-chain bytecode rejects it.

This is a clean re-publish fix: re-publish the current v1 source to get a fresh package id with the correct bytecode. The `Move.lock` + `Published.toml` are already set up to point at `0xb1777f167c…` (the live original-id). Re-publishing writes a new bytecode at the same `original-id` (the upgrade cap path) — but that would need a `--policy compatible` upgrade for signature changes, which is also blocked by the additive-only policy.

**The simplest fix is a fresh publish to a new package id**, then update Railway env vars. Estimated effort: 10 min.

### On-chain `Pool<YES<DUSDC>>` vs SDK's `Pool<YES<DUSDC, M>>`

The legacy v1 pool `0xddd7cbe5…` was created with `Pool<YES<DUSDC>>` (no M generic). The SDK's `create_market_with_pool` was using v2's `Pool<YES<Q, M>, Q>` signature — now reverted to v1's `Pool<YES<Q>, Q>`. The pool's actual type should match, but the on-chain bytecode at `0xb1777f167c…` is from a different era and may have a different layout.

## Commits this session

1. `748a47a` — declare live testnet original-id in Move.toml
2. `b1db972` — R-WC-3 capture multi-package state
3. `9307c53` — R-WC-3.1 cross-package-destructure blocker
4. `1c86f9c` — R-WC-3.2 v2 fresh publish + v1-compat staging
5. `bc70a71` — R-WC-3.2 v2 fresh-publish complete status
6. `5a98b92` — R-WC-3.3 SDK fix: thread per-market M type at builder time
7. `775f184` — R-WC-3.3 SDK fix complete
8. `e3c8d44` — R-WC-4 v3 design spec
9. `14cbd26` — fix(contracts): revert prediction_market_tests.move to v1
10. `cc63e62` — fix(agents+web): drop m type arg from all PTB builders

## Key files

- `packages/contracts/sources/prediction_market.move` — v1 (reverted from v2)
- `packages/contracts/Move.toml` — has the original-id pointing at `0xb1777f167c…`
- `packages/contracts-v1-compat/` — staging package for the failed v1.5 additive upgrade attempt (preserved for future reference, not built)
- `packages/sdk/src/prediction-market-client.ts` — every builder accepts optional `m` param (works for v1 and v2)
- `apps/agents/src/agents/*-creator.ts`, `*-maker.ts`, `*-resolver.ts` — `m: typeM` removed from all calls; SDK emits v1-compatible `[DUSDC_TYPE]`
- `apps/web/app/markets/[id]/page.tsx`, `dispute/[marketId]/page.tsx`, `portfolio/page.tsx` — same removal
- `docs/R-WC-3-testnet-multi-package-state.md` — captures the multi-package reality
- `docs/R-WC-3.1-v2-fresh-publish-complete.md` — v2 fresh-publish outcome
- `docs/R-WC-3.2-v2-fresh-publish-complete.md` — same
- `docs/R-WC-3.3-sdk-fix-and-end-to-end.md` — SDK fix + wc-creator failure diagnosis
- `docs/R-WC-4-v3-design-spec.md` — the v3 design that should be implemented in a follow-up

## What I would do next

1. **Re-publish v1 from current source** → fresh package id, fixes the ArityMismatch. Updates Railway env vars to the new id. ~10 min.
2. **Implement v3 design** per the R-WC-4 spec — register YES<Q> via OTW at init, share the TreasuryCap, allow N markets per package. ~4-6 hours.
3. **Decommission `packages/contracts-v1-compat/`** — failed staging directory, not needed once v3 is done.
4. **Document the v3 migration** in a new SOP file.

## Honest assessment

The session explored v1 → v2 → v3 → v1 (revert) and uncovered a fundamental Sui Move constraint: per-market coin type uniqueness via phantom `M` is impossible because Sui's `TypeTag::Address` is a unit variant (no body in BCS), and Move cannot generate new types at runtime.

The "v3 OTW per market" idea the user suggested is also infeasible on Sui because OTWs are module-level (one per package) and can't be minted per market.

The proper v3 design is to use a per-package OTW (registered once at init) and share the YES<Q> TreasuryCap across all markets in the same package. This is implemented as a spec but not code, pending the next session.