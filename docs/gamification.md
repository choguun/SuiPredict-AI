# Gamification Architecture

Daily prediction rounds, yield-boosting streaks, on-chain badges, off-chain
leaderboard, and an on-chain prize pool. The on-chain side is small and
trust-minimized; the off-chain side handles the leaderboard and
leaderboard-derived prize distribution to keep the contract surface
narrow.

## Stack

| Layer | Module / File | Purpose |
|-------|---------------|---------|
| Move | `suipredict_agent_policy::streak_system` | Per-user streak state, multiplier, badge flags |
| Move | `suipredict_agent_policy::prize_pool` | On-chain escrow + ed25519-signed claim |
| Move | `prediction_market` (additions) | `redeem_with_streak`, `dispute_market`, `resolve_dispute` |
| SDK | `packages/sdk/src/streak-client.ts` | `getStreakInfo`, `buildCreateStreakTx`, `buildRedeemWithStreakTx` |
| SDK | `packages/sdk/src/prize-client.ts` | `buildClaimPrizeTx`, `signClaimPayload`, `expectedAmountForRank` |
| Agents | `apps/agents/src/agents/streak-sweeper.ts` | 00:02 UTC daily: batch `record_participation` |
| Agents | `apps/agents/src/agents/leaderboard-worker.ts` | 00:05 UTC Mon: rollup prior week → `weekly_archive` |
| Agents | `apps/agents/src/agents/prize-distributor.ts` | 00:15 UTC Mon: sign top-10 prizes |
| REST | `apps/agents/src/gamification/routes.ts` | `/leaderboard/week`, `/leaderboard/user/:addr`, `/prize/signature` |
| SQLite | `apps/agents/data/gamification.db` | `daily_scores`, `weekly_archive`, `prize_claims` |
| Web | `apps/web/components/StreakProfile.tsx` | Real streak display (no more mock data) |
| Web | `apps/web/app/leaderboard/page.tsx` | Off-chain weekly ranking |
| Web | `apps/web/app/dispute/[marketId]/page.tsx` | 1-hour dispute window UI |

## Streak state machine

Each day the backend (1) resolves the daily markets, (2) reads the
`MintedEvent` user set for that day, (3) computes an outcome per user,
(4) batches `record_participation` calls.

| Outcome | Definition | Effect |
|---------|------------|--------|
| `AllCorrect` (1) | User submitted predictions for all 5 daily markets and all resolved correctly | `current_streak += 1`, emits `StreakUpdated` |
| `SomeWrong` (2) | User submitted ≥1 but not all resolved correctly | `current_streak = 0`, emits `StreakBroken` |
| `NotSubmitted` (0) | User submitted 0 predictions that day | `current_streak = 0`, no participation credit |
| Replay | Backend calls `record_participation` twice for the same `(user, day_index)` | aborts `EAlreadyRecordedToday` |

The on-chain `has_participated: bool` flag disambiguates "first day
ever" from `day_index == 0`. Replay is checked before the
"consecutive day" assertion so a same-day retry reports as a replay,
not a gap break.

## Multiplier tiers

PRD §4.2 is authoritative (plan-4 had a conflicting 1.5x/2.0x pair).
Multipliers live as a `vector<u64>` bps in `streak_system`; index 0 =
tier 1.

| Days | Tier | Multiplier | `get_multiplier_bps` |
|------|------|------------|----------------------|
| 0-2  | none | 1.0x | 10_000 |
| 3-6  | bronze | 1.1x | 11_000 |
| 7-13 | silver | 1.3x | 13_000 |
| 14-29| gold | 1.7x | 17_000 |
| 30-99| platinum | 2.5x | 25_000 |
| 100+ | diamond | 3.0x | 30_000 |

`prediction_market::redeem_with_streak` multiplies the collateral
returned by `get_multiplier_bps(streak) / 10_000`. The
non-streak `redeem` path is unchanged for users who pass no streak.

## Badge flag list (MVP)

`UserStreak.claimed_tiers: vector<bool>` indexed by tier-1 (length 5).
No NFT, no Kiosk. `claim_badge(streak, tier)` is idempotent
(`EBadgeAlreadyClaimed` on double-call). v2 migration: add a
`badge_nft.move` that mints a `StreakBadge` and `place`-s it in a
per-user Kiosk; the flag list remains the source of truth.

## Prize pool

```
WeeklyPrizePool {
  balance: Balance<DBUSDC>,
  distribution_bps: vector<u64>,  // [5000, 3000, 1500, 500, 1000×6]
  current_week: u64,
  settled: Table<u64, bool>,      // week_index → settled?
  claimed: Table<u64, Table<address, bool>>,  // week → user
}
PrizeAdmin { admin: address, pubkey: vector<u8> }
```

Default distribution (`DEFAULT_DISTRIBUTION_BPS`):
```
[5000, 3000, 1500, 500, 1000, 1000, 1000, 1000, 1000, 1000]   // 10_000
```

`claim_prize` requires the sender to own the `UserStreak`, an ed25519
signature from `PrizeAdmin.pubkey` over the canonical message
`(pool_id, week_index, user, rank, amount)`, and `rank <= 100`. The
on-chain `keccak_256` over the message bytes is reconstructed and the
signature is verified against the stored pubkey. Idempotency is
per-`(week, user)` via the `claimed` table.

## Cron schedule (UTC)

| Job | Frequency | Module |
|-----|-----------|--------|
| Daily markets created | 00:00 | `market-creator.ts` |
| Resolution data fetched | 23:55 | (resolver prep) |
| `resolve_market` PTB | 23:58 | `market-resolver.ts` |
| **Streak sweep** | **00:02** | `streak-sweeper.ts` |
| **Weekly leaderboard rollup** | **00:05 Mon** | `leaderboard-worker.ts` |
| `PoolSettled` for prior week | 00:10 Mon | (admin tx) |
| **Prize distributor** | **00:15 Mon** | `prize-distributor.ts` |

Bolded jobs are the new ones added in plan-4. The others existed and
are listed for context.

## REST surface

`apps/agents` exposes (all `GET`):

| Route | Returns |
|-------|---------|
| `/leaderboard/week?index=N&limit=M&category=K` | `{ week_index, rows[] }` from `weekly_archive` (live rollup if no archive) |
| `/leaderboard/user/:addr?week=N` | `{ rank, score, correct_days, longest_streak }` |
| `/prize/signature?week=N&rank=R&user=:addr&amount=:a` | `{ payload, signatureB64, expectedAmount }` |
| `/prize/claims?week=N` | All `prize_claims` rows (for transparency) |

The signature endpoint re-runs `signClaimPayload` so the user can call
`buildClaimPrizeTx` and submit the on-chain tx from their own wallet
without holding the prize admin key.

## Data flow

```
                            ┌──────────────────────┐
                            │  Daily markets (5)   │
                            │  created 00:00 UTC   │
                            └──────────┬───────────┘
                                       │ user mints YES/NO
                                       ▼
                            ┌──────────────────────┐
                            │ prediction_market    │
                            │ MintedEvent,         │
                            │ RedeemedEvent,       │
                            │ MarketResolvedEvent, │
                            │ MarketDisputedEvent  │
                            └──────────┬───────────┘
                                       │
              ┌────────────────────────┼─────────────────────────┐
              ▼                        ▼                         ▼
   ┌──────────────────┐   ┌────────────────────┐   ┌────────────────────┐
   │ streak-sweeper   │   │ leaderboard-worker │   │ prize-distributor  │
   │ 00:02 UTC        │   │ 00:05 UTC Mon      │   │ 00:15 UTC Mon      │
   │                  │   │                    │   │                    │
   │ record_particip- │   │ daily_scores →     │   │ read top-10 →      │
   │ ation PTB batch  │   │ weekly_archive     │   │ signClaimPayload   │
   │ (20 per PTB)     │   │ (PRIMARY_KEY)      │   │ (prize_claims)     │
   └────────┬─────────┘   └────────┬───────────┘   └────────┬───────────┘
            │ StreakUpdated        │ live rollup        │ signed claim
            ▼                      ▼                     ▼
   ┌──────────────────┐   ┌────────────────────┐   ┌────────────────────┐
   │ UserStreak on-   │   │ /leaderboard/week  │   │ User submits       │
   │ chain + daily_   │   │ REST response      │   │ claim_prize tx     │
   │ scores rows      │   │ (frontend)         │   │ (frontend)         │
   └──────────────────┘   └────────────────────┘   └────────────────────┘
```

## Anti-fraud

1. **Streak** — `record_participation` is gated by `StreakAdmin.admin`
   (a shared capability, deployer-set to the backend hot wallet). The
   SDK exposes only `buildCreateStreakTx` and `buildRedeemWithStreakTx`
   for users; the backend keeps the `record_participation` builder
   internal.
2. **Prize** — `claim_prize` verifies an ed25519 signature from
   `PrizeAdmin.pubkey` over a canonical message that includes
   `pool_id`. A user who somehow acquired a different `PrizePool`
   cannot reuse the signature.
3. **Dispute** — `dispute_market` is open to anyone but only freezes
   the market. `resolve_dispute` is gated by `ctx.sender() == creator`.
4. **Replay** — `EAlreadyRecordedToday` on `record_participation` and
   per-`(week, user)` `claimed` table on `claim_prize` make all writes
   idempotent.

## Migration / bootstrap

Existing wallets have no `UserStreak`. The lazy-create path (backend
calls `create_streak` + `record_participation` in one PTB) is enabled
in `streak-sweeper`. The on-chain `EStreakExists` abort means a
double-create is safe.

## Acceptance criteria

### `streak_system.move`
- [x] Build passes (`sui move build` with 0 errors).
- [x] All 5 streak outcomes covered by 11 unit tests in
      `tests/streak_system_tests.move` (AllCorrect, SomeWrong,
      NotSubmitted, replay, gap-break, non-admin rejection,
      multiplier tier boundaries, badge claim, double-claim,
      double-create, invalid outcome).
- [x] `StreakAdmin` is shared at module init; only its `admin` can
      call `record_participation`.
- [x] Multipliers match the table above (verified by unit test).

### `prize_pool.move`
- [x] `PrizeAdmin` capability verifies ed25519 signature before
      `claim_prize` succeeds.
- [x] `claim_prize` aborts on rank > 100, double-claim, or unsigned
      claim.
- [x] `distribution_bps` default is the table above.
- [x] `PoolSettled` event emitted when `settled[week_index] = true`.

### SDK
- [x] `packages/sdk` compiles (`tsc`).
- [x] `streak-client.ts` re-exports: `buildCreateStreakTx`,
      `buildRecordParticipationTx`, `buildRedeemWithStreakTx`,
      `buildRedeemNoWithStreakTx`, `getStreakInfo`, `streakIdForUser`,
      `computeMultiplierBps`, `currentDayIndex`, `OUTCOME`.
- [x] `prize-client.ts` re-exports: `buildFundPoolTx`, `buildClaimPrizeTx`,
      `buildSettleWeekTx`, `buildRotateWeekTx`, `buildRotatePubkeyTx`,
      `buildSetDistributionTx`, `signClaimPayload`,
      `expectedAmountForRank`, `DEFAULT_DISTRIBUTION_BPS`.
- [x] `prediction-market-client.ts` adds `buildDisputeMarketTx`,
      `buildResolveDisputeTx`.

### Agents
- [x] `apps/agents` compiles (`tsc`).
- [x] `streak-sweeper`, `leaderboard-worker`, `prize-distributor`
      registered in `runCycle` (`index.ts`).
- [x] New REST routes mounted (`handleGamificationRoute`).
- [x] `gamification.db` is auto-created with `daily_scores`,
      `weekly_archive`, `prize_claims` tables.

### Frontend
- [x] `StreakProfile` reads from real `UserStreak` (no hard-coded
      values); shows "Start your streak" CTA when missing.
- [x] `/leaderboard` hits `/leaderboard/week` and renders weekly
      rankings (with graceful error when agents are down).
- [x] `/dispute/[marketId]` page exists and submits `dispute_market`
      tx.

## Out of scope (filed for plan-5)

- **Parlays** — multi-leg parlay module + UI.
- **Kiosk / TransferPolicy for badges** — replace flag list with
  `StreakBadge` NFT.
- **National / AI-forecaster category leaderboards** — requires
  `UserProfile.country_code` and category filtering, both skipped for
  MVP.
- **On-chain `AdminOracle` enforcement** — currently the backend
  enforces the multisig off-chain before calling `resolve_market`.
  v2 makes the oracle a required parameter.
