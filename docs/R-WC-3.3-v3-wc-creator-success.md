# R-WC-3.3 v3 — wc-creator end-to-end success

**Date:** 2026-06-19
**Status:** ✅ `world-cup-creator` successfully created 1 on-chain
`PredictionMarket` against the v3 fresh-publish package
(`0xe98b0c9c…`). The 11:00 (Vietnam) cron tick produced the success
log line:

```
[wc-creator] B3v4 success: digest=… shared_caps=0x90a788b2… deepbook=0xdee9…
[scheduler] WorldCupCreator → create_wc: WC: created 1 on-chain markets, 0 failed. Window: 25 matches in 7d, cap 4. Path: create_market (first run after v3 fresh-publish).
```

This is the first end-to-end success of the v3 SharedTreasuryHolder
design on testnet. The previous round (R-WC-3.3 v2) had the wc-creator
failing every tick with `VMVerificationOrDeserializationError in
command 0` because the SDK's `withMarketType` mutated a clone of
`tx.getData()`; v3 resolves that with the `m` type-arg threading and
adds the `SHARED_TREASURY_HOLDER_ID` as arg 0 to `create_market`.

---

## What this commit fixed

### `predict-client.ts:executeTransaction` rebuild path

The retry loop in `executeTransaction` (`packages/sdk/src/predict-client.ts:230-360`)
now treats two new error classes as transient and rebuilds the
PTB on a fresh gas coin:

| Error string | Meaning | Action |
|---|---|---|
| `Transaction needs to be rebuilt` | Gas coin version race | already handled pre-fix |
| `is unavailable for consumption` | Object version stale | already handled pre-fix |
| **`Invalid withdraw reservation`** | **Coin-accumulator reservation race against sibling agents** | **NEW** — rebuild + re-pin gas coin |
| **`is less than requested`** | **Reservation referenced a coin that no longer has the requested balance** | **NEW** — rebuild + re-pin gas coin |

The rebuild path uses a `txFactory: () => Promise<Transaction>` closure
that the caller (e.g. `signAndExecuteTransaction` in
`apps/agents/src/agents/world-cup-creator.ts`) provides. On a
recognized transient error, the loop:

1. Calls `txFactory()` to produce a fresh `Transaction` instance.
2. Calls `pinFreshGasCoin(tx)` to list the agent's SUI coins via
   `listAllCoins(owner, "0x2::sui::SUI", { pageSize: 5 })`, sort by
   balance descending, and `tx.setGasPayment([{ objectId, version, digest }])`
   on the highest-balance coin.
3. Re-invokes `client.signAndExecuteTransaction({ transaction: tx, ... })`.

The fresh `(objectId, version, digest)` triple is the Sui reservation
key — re-pinning it bypasses the stale reservation left by the
previous attempt's failed PTB.

### `decodeURIComponent` for Sui gRPC error strings

Sui's gRPC error responses sometimes percent-encode the error text
(e.g. `Invalid%20withdraw%20reservation`). The pre-fix regex
`/Invalid\s+withdraw\s+reservation/i` would silently miss these.
The error string is now `decodeURIComponent`-normalized before the
regex match, so the transient classification works regardless of
encoding.

### Exponential backoff preserved

The 4s/8s backoff schedule for version races and 1s/2s for transient
network errors was preserved. The two new error classes inherit the
4s/8s version-race backoff because they're effectively the same
underlying race.

---

## What was NOT changed

- **Contract (`packages/contracts/sources/prediction_market.move`)** —
  no new code paths, no new test coverage needed. v3 is unchanged
  from the `R-WC-3.3-v3-deployment-complete.md` snapshot.
- **Agents (`apps/agents/src/agents/*`)** — no caller changes. The
  rebuild path is fully internal to the SDK.
- **Web (`apps/web/app/markets/[id]/page.tsx`)** — unchanged.

This is a pure-SDK fix, which is why the rollout was `railway up
--detach` only (no Move recompile, no contract republish).

---

## Verification checklist

| Check | Result |
|---|---|
| `pnpm --filter @suipredict/sdk build` | ✅ 0 errors, dist rebuilt |
| `pnpm --filter @suipredict/agents build` | ✅ 0 errors, dist rebuilt |
| `pnpm contracts:test` | ✅ 130/130 still pass (no contract changes) |
| `pnpm --filter @suipredict/sdk test` | ✅ 28/28 still pass |
| `pnpm --filter @suipredict/agents test` | ✅ 38/38 still pass |
| `pnpm build` (full) | ✅ 0 errors |
| Railway deploy | ✅ commit `be1941a` is the active deployment |
| `GET /health` on agents service | ✅ returns `package_id: 0xe98b0c9c…` |
| wc-creator 11:00 cron tick | ✅ 1 market on-chain, 0 failures |

---

## Migration plan for the remaining v1 stamped shared objects

The wc-creator's `register_market` PTB (best-effort, called after
`create_market` succeeds) currently surfaces a warning because the
v1 `MarketRegistry` is at `0xb1777f167c…` but the agent policy env
points at the v3 package `0xe98b0c9c…`. The wc-creator still
creates markets; it just can't register them in the v1 registry
(which is fine — the v1 registry is no longer the source of truth).

The next round (R-WC-3.3 follow-up) will:

1. Call `init_registry<DUSDC>(admin_cap, ctx)` on the v3 package
   using `ProtocolAdminCap = 0x0a524de9…` to create a v3
   `MarketRegistry`.
2. Call `init_agent_policy<DUSDC>(admin_cap, ctx)` for a v3
   `AgentPolicy`.
3. Call `init_streak_registry<DUSDC>(admin_cap, ctx)` for a v3
   `StreakRegistry`.
4. Update `AGENT_POLICY_PACKAGE_ID`, `MARKET_REGISTRY_ID`,
   `STREAK_REGISTRY_ID` env vars on Railway + Vercel.
5. Re-bootstrap the prize pool and fee vault (they're package-scoped
   to the v3 package — see `R-WC-3.3-v3-deployment-complete.md`
   follow-up #3).

This is non-blocking for the wc-creator's primary `create_market`
path, which is the main WC agent in the demo flow.

---

## Operator notes

- **`railway up --detach --yes`** is the canonical "ship a code change
  to agents" command. The plain `railway redeploy --yes` form
  redeploys the cached image and is broken for code changes (see
  `R-WC-3.3-v3-deployment-complete.md` § "Railway snapshot-cache
  gotcha"). The exception is env-only changes — `railway redeploy
  --yes` works fine for those because env vars are merged into the
  cached image at boot.
- **The SDK `dist/` is no longer tracked** (commit `93cc00c`,
  2026-06-19). The `pnpm install` `prepare: tsc` hook +
  `railpack.json`'s startCommand both rebuild the dist from src,
  so consumers never see a stale dist. Don't `git add -f` it back.
- **The `TURBO_FORCE=true` Railway env var should be removed** once
  the wc-creator has 24h of clean runs. It forces a full rebuild on
  every deploy, which is slow but bypasses any stale entries in
  turbo's Remote Cache.
