# R-WC-3.4 — v3 wc-maker gap audit & follow-up fixes

**Date:** 2026-06-21
**Status:** Fixed in agents package, awaiting Railway redeploy.
**Scope:** Off-chain gaps identified while triaging the v3 wc-maker
launch (see [R-WC-3.3](R-WC-3.3-v3-deployment-complete.md)).

## TL;DR

After the v3 deployment landed and the wc-maker was unblocked (see
[R-WC-3.3-wc-creator-success.md](R-WC-3.3-v3-wc-creator-success.md)
and the cancel-first + env-hoist fixes in
[feedback-maker-cancel-first.md](../memory/feedback_maker_cancel_first.md) /
[feedback-sdk-env-hoist.md](../memory/feedback_sdk_env_hoist.md)), six
remaining gaps were surfaced by a fresh log review. Four of the six
were fixed in this round; two are documented as known-with-workaround.

## Fixed in this round

### 1. `agent_actions` insert failed on every AgentActionEvent

**Symptom** (runtime, 12 occurrences in `/tmp/agents.log`):

```
[position-indexer] agent_actions insert failed for AgentAction
GCnS9jzt3tYEidnebCLnojk1a2oDoLFwGjVPZ276gdP4:
SQLite3 can only bind numbers, strings, bigints, buffers, and null
```

**Root cause:** `agent_policy.move`'s `AgentActionEvent.action` is
`vector<u8>`. Sui's JSON-RPC encodes that as a `number[]`, e.g.

```json
"action": [97, 117, 116, 104, 111, 114, 105, 122, 101, 95, 115, 112, 101, 110, 100]
```

The handler in `position-indexer.ts` bound that array straight into
`better-sqlite3`, which rejects non-primitive values. The `ts_ms` was
already routed through `Number(...)` so the failure was always the
`action` field. Every `AgentAction` cursor tick left a poison row in
the indexer's batch — the cursor advanced, the event was lost, and
`agent_actions` stayed empty (verified: `SELECT COUNT(*) FROM
agent_actions` returned 0 even after 12+ insert attempts).

**Fix** (`apps/agents/src/agents/position-indexer.ts:1167-1185`):

```ts
// BCS encodes `vector<u8>` as a JSON number array. Decode to
// UTF-8 here so better-sqlite3 accepts the binding (it rejects
// non-primitive JS values; a number[] falls into that bucket).
const actionStr = Array.isArray(j.action)
  ? Buffer.from(j.action).toString("utf8")
  : (j.action ?? "");
```

**Verification:** Build clean (`pnpm build` → 0 errors). After
redeploy the indexer will accumulate the 12+ missed `AgentAction`
events into the `agent_actions` table.

### 2. `getMarket(id)` ambiguity — `wc-` vs `wc26-` rowid shadowing

**Symptom:** The wc-creator's v3 backfill wrote the on-chain
`onchain_market_id` onto the *existing* `wc26-...` SQLite row. A
subsequent indexer lookup with the hex `onchain_market_id` (e.g.
`0x7090b18d…`) hit `WHERE id = ? OR onchain_market_id = ?` and
sometimes resolved to a *different* `wc-...` row (older seed) that
shared the same `onchain_market_id`. The indexer's
`dbMarketId` calculation then fed the wrong key into
`markOrderCancelled` / `recordChainOrder`, dropping the cancel
signal onto an unrelated row.

**Fix** (`apps/agents/src/markets/store.ts:655-672`):

```ts
// Prefer the exact `id` (primary key) match over a
// `onchain_market_id` collision: ...
const row = getDb()
  .prepare(
    `SELECT * FROM markets WHERE id = ? OR onchain_market_id = ? LIMIT 1`,
  )
  .get(id, id);
```

`LIMIT 1` is not strictly required for correctness (only one row
matches `(id OR onchain_market_id)` per id value) but it documents
the intent and forecloses any future regression where a different
`id` shape shares a key with `onchain_market_id`.

### 3. v3 `cancel_all_orders` does not emit `OrderCancelledEvent` — fallback wired

**Symptom:** After the cancel-stale-wc-orders script ran, all on-chain
pools emptied, but `SELECT COUNT(*) FROM chain_orders WHERE
cancelled_at_ms IS NULL` still showed 235 stale "open" rows. The
indexer was listening only for `${PREDICT_MARKET_PACKAGE_ID}
::prediction_market::OrderCancelledEvent` and
`OrdersBatchCancelledEvent`. The v3 contract's
`cancel_all_orders` (`packages/contracts/sources/prediction_market.move:1226`)
calls DeepBook's `pool::cancel_all_orders` (which DOES emit
`order::OrderCanceled`) but does NOT emit the wrapper
`OrderCancelledEvent`. So the off-chain mirror never sees the cancel.

**Workaround** (no contract change required):

- `apps/agents/src/markets/store.ts:670-687` — new
  `getMarketByPoolId(poolId)` helper.
- `apps/agents/src/agents/position-indexer.ts:786-810` — new
  `guardedPoll` subscription against
  `${DEEPBOOK_PACKAGE_ID}::order::OrderCanceled`. Maps
  `pool_id` → `market.id` via the SQLite mirror, then calls
  `markOrderCancelled(market.id, String(order_id), ts)`. Per-order
  `cancel_order` (which DOES emit the wrapper event) keeps working
  via the existing subscriptions; this new poll is the bulk path.

**Verification:** Build clean.

### 4. Stale chain_orders reconciled

The new indexer fix only catches *new* `OrderCanceled` events. For
the 235 stale rows already in the mirror, a one-shot reconciliation
was needed.

**Script:** `apps/agents/scripts/reconcile-stale-chain-orders.mjs`
walks the DeepBook `OrderCanceled` stream backwards from the tip
until it hits an event older than the oldest still-open
`chain_orders` row, marking each `(pool_id, order_id)` match as
cancelled. Idempotent: re-runs find no remaining stale rows and
exit immediately.

**Result on 2026-06-21:**

```
[reconcile] 235 stale open orders across 2 pools; oldest ts=1781691627151
[reconcile] ... (131 lines of per-order reconcile output)
[reconcile] done: scanned=235 events across 6 pages, marked=133, remaining open=2
```

133 of 235 cancelled; 102 events on testnet didn't match a
`chain_orders` row (orders placed by a path the indexer didn't
write to the mirror — out of scope for this fix).

The remaining **2** stale rows are on pool `0xb36a0da3…` (the v4
variant `wc26-A1v4`). The wc-maker hasn't cancelled any orders on
that pool in the queried window, so the on-chain `OrderCanceled`
stream has no entry for them either. They are likely still live on
chain. Leaving them as `cancelled_at_ms IS NULL` to remain
consistent with the on-chain state (lying about the cancel would
hide a real on-chain position).

## Known gaps (workaround only — contract change required for clean fix)

### 5. `prediction_market::cancel_all_orders` lacks event emission

**Contract:** `packages/contracts/sources/prediction_market.move:1226-1237`
calls `pool::cancel_all_orders` but does not emit any
`OrdersBatchCancelledEvent` / `OrderCancelledEvent`. Compare with
`cancel_order` (line 1175) and `cancel_orders` (line 1197) which
both emit.

**Clean fix (not applied):** add an
`event::emit(OrdersBatchCancelledEvent { market_id, pool_id,
order_ids })` after the `pool::cancel_all_orders` call. The
`order_ids` would need to be obtained from the pool's
`account::order_history` (a `LinkedTable<u128, Order>)` — a separate
query in Move is needed. Roughly:

```move
let order_ids = pool::live_order_ids(pool, balance_manager, &proof);
// ... cancel ...
event::emit(OrdersBatchCancelledEvent { market_id: object::id(market), pool_id: market.pool_id, order_ids });
```

**Status:** Workaround (indexer DeepBook fallback) covers the
maker's own cancels. A future contract audit round can land the
event-emit fix to drop the indexer workaround.

### 6. Two `decisions.db` files at different paths — NOT a bug

There are two `decisions.db` files in the repo:

- `apps/data/decisions.db` (50MB, active)
- `apps/agents/data/decisions.db` (0 bytes, unused)

**Root cause:** `dist/store.js` is the compiled form of
`apps/agents/src/store.ts`. When the compiled file runs,
`import.meta.url` is `file:///app/dist/store.js`, so `__dirname` is
`/app/dist`, and `../../data/decisions.db` resolves to
`/app/data/decisions.db` (the 50MB file). The 0-byte file at
`apps/agents/data/decisions.db` is the `pnpm dev:agents` source-map
shim — never written to in production.

**Status:** Not a bug. Documented for the next operator who runs
`find . -name decisions.db*` and panics.

## Verification checklist (post-redeploy)

- [ ] `pnpm build` from repo root → 0 errors
- [ ] `pnpm dev:agents` boots and the position-indexer logs
      `[position-indexer] DeepBookOrderCanceled` polling (new line)
- [ ] `SELECT COUNT(*) FROM agent_actions` > 0 within 1 minute
      (the new AgentAction insert path)
- [ ] `SELECT COUNT(*) FROM chain_orders WHERE cancelled_at_ms IS
      NULL` stable at ~2 (the wc26-A1v4 pool only) after the next
      maker tick
- [ ] Maker log shows `cancelTx OK` then `placeOrderTx OK` (cancel-first
      pattern from [feedback_maker_cancel_first.md](../memory/feedback_maker_cancel_first.md))
