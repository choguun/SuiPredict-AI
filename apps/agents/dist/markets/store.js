import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DATA_DIR
    ? join(process.env.DATA_DIR, "markets.db")
    : join(__dirname, "../../data/markets.db");
let db = null;
// R53 audit fix: see the
// matching `closeDb()` in
// `store.ts` and
// `gamification/store.ts` for
// the SIGTERM-handler drain.
export function closeDb() {
    if (db) {
        try {
            db.close();
        }
        catch {
            // shutdown is best-effort
        }
        db = null;
    }
}
export function getDb() {
    if (!db) {
        mkdirSync(dirname(DB_PATH), { recursive: true });
        db = new Database(DB_PATH);
        // R48 audit fix: enable WAL, busy_timeout, and foreign_keys on
        // the markets DB. The cron-driven indexer writers and the
        // HTTP route readers would otherwise serialize via
        // SQLITE_BUSY, and the readers' per-route handlers had no
        // retry. busy_timeout lets SQLite wait up to 5s for the
        // writer to finish.
        db.pragma("journal_mode = WAL");
        db.pragma("busy_timeout = 5000");
        db.pragma("foreign_keys = ON");
        db.exec(`
      CREATE TABLE IF NOT EXISTS markets (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        category TEXT NOT NULL DEFAULT 'general',
        expiry_ms INTEGER NOT NULL,
        resolution_source TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'active',
        outcome TEXT,
        pool_id TEXT,
        order_book_id TEXT,
        deepbook_pool_key TEXT,
        deepbook_pool_id TEXT,
        deepbook_base_coin_type TEXT,
        deepbook_quote_coin_type TEXT,
        deepbook_base_scalar INTEGER,
        deepbook_quote_scalar INTEGER,
        referral_id TEXT,
        created_at_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS demo_orders (
        market_id TEXT NOT NULL,
        order_id INTEGER NOT NULL,
        owner TEXT NOT NULL,
        is_bid INTEGER NOT NULL,
        price_bps INTEGER NOT NULL,
        quantity INTEGER NOT NULL,
        filled INTEGER NOT NULL DEFAULT 0,
        timestamp_ms INTEGER NOT NULL,
        PRIMARY KEY (market_id, order_id)
      );
      CREATE TABLE IF NOT EXISTS trades (
        id TEXT PRIMARY KEY,
        market_id TEXT NOT NULL,
        order_id INTEGER NOT NULL,
        price_bps INTEGER NOT NULL,
        quantity INTEGER NOT NULL,
        is_bid INTEGER NOT NULL,
        timestamp_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS positions (
        market_id TEXT NOT NULL,
        address TEXT NOT NULL,
        yes INTEGER NOT NULL DEFAULT 0,
        no INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (market_id, address)
      );
      CREATE TABLE IF NOT EXISTS chain_orders (
        market_id TEXT NOT NULL,
        order_id TEXT NOT NULL,
        pool_id TEXT NOT NULL,
        -- Stored as TEXT (not INTEGER) because the on-chain
        -- client_order_id: u64 can exceed JavaScript's
        -- Number.MAX_SAFE_INTEGER (2^53-1) once the user picks
        -- values from a non-monotonic source. JS Number coercion via
        -- Number(j.client_order_id ?? 0) (the round-15 writer) would
        -- silently lose precision and the web's
        -- String(o.client_order_id) match in waitForOrderInBook
        -- would never resolve. See audit round-17 finding #8.
        client_order_id TEXT NOT NULL,
        is_bid INTEGER NOT NULL,
        price INTEGER NOT NULL,
        quantity INTEGER NOT NULL,
        timestamp_ms INTEGER NOT NULL,
        cancelled_at_ms INTEGER,
        filled_quantity INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (market_id, order_id)
      );
      CREATE TABLE IF NOT EXISTS settlements (
        market_id TEXT NOT NULL,
        pool_id TEXT NOT NULL,
        trader TEXT NOT NULL,
        timestamp_ms INTEGER NOT NULL,
        id INTEGER PRIMARY KEY AUTOINCREMENT
      );
      CREATE TABLE IF NOT EXISTS indexer_state (
        key TEXT PRIMARY KEY,
        cursor TEXT,
        -- R51 audit fix: stamp each cursor row with the
        -- (network, package_id) it was captured under. The
        -- position-indexer compares these against the
        -- runtime env on readCursor() and discards the
        -- cursor on a mismatch (e.g. testnet -> mainnet
        -- hot-patch, or agent_policy republished under a
        -- new id on the same network). Pre-R51 rows
        -- (created before this migration ran) had no
        -- columns at all; migrateIndexerStateColumns()
        -- adds them below with empty defaults so the
        -- mismatch check fires and re-bootstraps from
        -- the genesis cursor.
        network TEXT NOT NULL DEFAULT '',
        package_id TEXT NOT NULL DEFAULT '',
        updated_at_ms INTEGER NOT NULL
      );

      -- Vault activity log. Populated by the position-indexer from the
      -- on-chain VaultCreated / Deposited / Withdrawn / Allocated /
      -- Deallocated events (these were unsubscribed before r15 — the
      -- vault page reads its summary directly from the SDK, so the table
      -- is purely a recent-activity feed for the vault UI). Powers an
      -- optional "Recent flows" panel on /vault.
      CREATE TABLE IF NOT EXISTS vault_flows (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        vault_id TEXT NOT NULL,
        kind TEXT NOT NULL,         -- 'created' | 'deposit' | 'withdraw' | 'allocate' | 'deallocate'
        actor TEXT,                 -- user (for deposit/withdraw) or admin
        amount INTEGER NOT NULL DEFAULT 0,
        vlp_delta INTEGER NOT NULL DEFAULT 0,
        total_allocated INTEGER,
        ts_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_vault_flows_vault_ts
        ON vault_flows(vault_id, ts_ms DESC);

      -- Registry tracking. Populated by the position-indexer from the
      -- RegistryCreated / MarketRegistered events (registry.move). The
      -- MarketRegistry itself is a single shared object so the
      -- 'registries' table has at most one row in production, but
      -- tracking its id+admin gives the admin dashboard a
      -- confirmed-bootstrap signal. The 'registered_markets' table
      -- mirrors the on-chain Table<u64, ID> index so the admin view
      -- can list all known markets without an on-chain read.
      CREATE TABLE IF NOT EXISTS registries (
        id TEXT PRIMARY KEY,
        admin TEXT NOT NULL,
        ts_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS registered_markets (
        market_id TEXT PRIMARY KEY,
        market_index INTEGER NOT NULL,
        ts_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_registered_markets_index
        ON registered_markets(market_index);

      -- R56 audit fix: persistent per-market demo order counter.
      -- The market-maker generates synthetic order_id values for
      -- the demo path (no on-chain digest to derive from). The R47
      -- audit's comment claimed the counter was "SQLite-backed"
      -- but the implementation was an in-process Map (see
      -- apps/agents/src/agents/market-maker.ts:74). A SIGTERM or
      -- Railway redeploy cleared the Map, and the next tick
      -- re-seeded from Date.now() - which on a fast redeploy can
      -- be the same value as a previously-written order_id,
      -- colliding on the (market_id, order_id) PK in demo_orders
      -- and silently flipping a cancelled row back to filled=0.
      -- Persist the next-id per market so the counter survives
      -- process restarts and is also shared across replicas (if
      -- the agents service is ever horizontally scaled).
      CREATE TABLE IF NOT EXISTS demo_order_counters (
        market_id TEXT PRIMARY KEY,
        next_id INTEGER NOT NULL
      );
    `);
        migrateMarketColumns();
        migrateIndexerStateColumns();
        // R58.H16: recover from an indexer_state btree
        // corruption (e.g. caused by a hot-patch that
        // swapped the cursor format while a write was
        // in flight). Runs AFTER the column migration
        // so the rebuild uses the latest schema.
        recoverIndexerStateCorruption();
        // R46 audit fix: only seed demo markets in dev / test
        // environments. The previous code ran on every fresh DB
        // regardless of `NODE_ENV`, which meant a production
        // operator (or CI deploy) that wiped the DB for any reason
        // (disk pressure, schema reset, disaster-recovery) would
        // see two demo markets — "Will BTC exceed $100k by June
        // 30?" and "Will SUI hit a new ATH in 2026?" — show up on
        // the public `/markets` page the moment the agents booted.
        // The indexer then starts chasing `MarketResolved` events
        // for these on-chain object ids that don't exist (the
        // "demo-btc-100k" id is a synthetic local string, not a
        // 0x… transaction digest), logging "market not found"
        // warnings forever. Gate on `NODE_ENV !== "production"`
        // (matching the R41 /agents service's policy of never
        // running dev-only fixtures in prod) and accept an
        // explicit `SEED_DEMO_MARKETS=1` override for local
        // development.
        if (process.env.NODE_ENV !== "production" || process.env.SEED_DEMO_MARKETS === "1") {
            seedDemoMarkets();
        }
    }
    return db;
}
/** Append a vault activity row. Used by the position-indexer. */
export function recordVaultFlow(flow) {
    getDb()
        .prepare(`INSERT INTO vault_flows
         (vault_id, kind, actor, amount, vlp_delta, total_allocated, ts_ms)
       VALUES
         (@vault_id, @kind, @actor, @amount, @vlp_delta, @total_allocated, @ts_ms)`)
        .run({
        vault_id: flow.vault_id,
        kind: flow.kind,
        actor: flow.actor ?? null,
        amount: flow.amount ?? 0,
        vlp_delta: flow.vlp_delta ?? 0,
        total_allocated: flow.total_allocated ?? null,
        ts_ms: flow.ts_ms,
    });
}
/** Recent vault flows, newest first. */
export function listVaultFlows(vaultId, limit = 50) {
    const db = getDb();
    if (vaultId) {
        return db
            .prepare(`SELECT * FROM vault_flows WHERE vault_id = ? ORDER BY ts_ms DESC LIMIT ?`)
            .all(vaultId, limit);
    }
    return db
        .prepare(`SELECT * FROM vault_flows ORDER BY ts_ms DESC LIMIT ?`)
        .all(limit);
}
function migrateMarketColumns() {
    const existing = new Set(getDb().prepare(`PRAGMA table_info(markets)`).all().map((row) => row.name));
    const columns = {
        deepbook_pool_key: "TEXT",
        deepbook_pool_id: "TEXT",
        deepbook_base_coin_type: "TEXT",
        deepbook_quote_coin_type: "TEXT",
        deepbook_base_scalar: "INTEGER",
        deepbook_quote_scalar: "INTEGER",
        referral_id: "TEXT",
        disputed: "INTEGER NOT NULL DEFAULT 0",
        dispute_count: "INTEGER NOT NULL DEFAULT 0",
        dispute_evidence_uri: "TEXT",
        last_dispute_at_ms: "INTEGER",
        // R46 audit fix: `category` is in the CREATE TABLE
        // (line 27) but was never added to this migration
        // list. A pre-R46 DB that was created before
        // `category` was added to CREATE TABLE wouldn't
        // have the column at all; the `ALTER TABLE` would
        // then error on the rare pre-R35 DB the operator
        // still has on disk. Add it for symmetry and to
        // guarantee a consistent shape regardless of when
        // the DB was first provisioned.
        category: "TEXT NOT NULL DEFAULT 'general'",
    };
    for (const [name, type] of Object.entries(columns)) {
        if (!existing.has(name)) {
            getDb().exec(`ALTER TABLE markets ADD COLUMN ${name} ${type}`);
        }
    }
}
/**
 * R51 audit fix: add the `network` and `package_id` columns to
 * pre-existing `indexer_state` tables. The R50 audit introduced
 * the (network, package_id) cursor tag in `position-indexer.ts`
 * but didn't ship the schema migration; a fresh DB has the
 * columns via CREATE TABLE, but a pre-R51 DB throws
 * `SqliteError: no such column: network` on the first cursor
 * read, breaking all 30 event subscriptions.
 *
 * Empty defaults mean pre-R51 cursor rows compare as mismatched
 * against the runtime env (which has SUI_NETWORK /
 * AGENT_POLICY_PACKAGE_ID set), and `readCursor` discards them,
 * re-bootstrapping from the genesis cursor. The empty defaults
 * are also safe for fresh rows written by R50 code that didn't
 * supply the columns — those rows just look mismatched and are
 * re-bootstrapped on the next read, which is exactly the
 * pre-R51 behavior.
 */
function migrateIndexerStateColumns() {
    const existing = new Set(getDb().prepare(`PRAGMA table_info(indexer_state)`).all().map((row) => row.name));
    const columns = {
        network: "TEXT NOT NULL DEFAULT ''",
        package_id: "TEXT NOT NULL DEFAULT ''",
    };
    for (const [name, type] of Object.entries(columns)) {
        if (!existing.has(name)) {
            getDb().exec(`ALTER TABLE indexer_state ADD COLUMN ${name} ${type}`);
        }
    }
}
/**
 * R58.H16 audit fix: detect a corrupt `indexer_state`
 * table and rebuild it. The pre-fix code crashed with
 * `database disk image is malformed` on every indexer
 * tick when the btree was corrupted (common after a
 * hot-patch that swapped the R58.H7 cursor format from
 * the stringified `[object Object]` to a JSON object
 * while a write was in flight). The indexer would
 * silently fail forever, never re-indexing a single
 * on-chain event, and the boot log would fill with
 *   [position-indexer] MarketCreated poll failed:
 *     database disk image is malformed
 *   [position-indexer] VaultCreated poll failed: ...
 *   [position-indexer] PolicyCreated poll failed: ...
 * The fix: at boot, after the migrations, run
 * `PRAGMA integrity_check` on the indexer_state table.
 * If it reports corruption (or the integrity check
 * itself throws), drop the table and let the indexer
 * re-bootstrap from the genesis cursor on the next
 * tick. The cursor loss is bounded (we re-index the
 * handful of historical events on the next poll) and
 * the alternative is permanent indexer outage.
 */
function recoverIndexerStateCorruption() {
    const db = getDb();
    let integrity;
    try {
        integrity = db
            .prepare(`PRAGMA integrity_check(indexer_state)`)
            .all();
    }
    catch (err) {
        // The pragma itself threw. On a fresh DB the
        // table doesn't exist yet and SQLite throws
        // "no such table: indexer_state" — that's the
        // expected path; fall through to the CREATE
        // TABLE in initSchema. Treat any other throw
        // as corruption and drop+rebuild.
        const msg = err instanceof Error ? err.message : String(err);
        if (/no such table/i.test(msg))
            return;
        integrity = [{ integrity_check: `throw: ${msg}` }];
    }
    const ok = integrity && integrity.length === 1 && integrity[0]?.integrity_check === "ok";
    if (ok)
        return;
    console.warn(`[agents] indexer_state table is corrupt (integrity_check: ${integrity
        ?.map((r) => r.integrity_check)
        .join(", ") ?? "unknown"}). Rebuilding.`);
    try {
        db.exec(`DROP TABLE IF EXISTS indexer_state`);
    }
    catch (dropErr) {
        console.error(`[agents] DROP TABLE indexer_state failed: ${dropErr instanceof Error ? dropErr.message : String(dropErr)}`);
        return;
    }
    // Recreate the table with the same schema as the
    // CREATE TABLE in `initSchema` so the indexer can
    // start fresh.
    db.exec(`
    CREATE TABLE IF NOT EXISTS indexer_state (
      key TEXT PRIMARY KEY,
      cursor TEXT,
      network TEXT NOT NULL DEFAULT '',
      package_id TEXT NOT NULL DEFAULT '',
      updated_at_ms INTEGER NOT NULL
    );
  `);
    console.warn(`[agents] indexer_state rebuilt; indexer will re-bootstrap from genesis.`);
}
/** Idempotent insert of a RegistryCreated event. */
export function recordRegistry(row) {
    getDb()
        .prepare(`INSERT INTO registries (id, admin, ts_ms)
       VALUES (@id, @admin, @ts_ms)
       ON CONFLICT(id) DO UPDATE SET
         admin = excluded.admin,
         ts_ms = excluded.ts_ms`)
        .run({ id: row.id, admin: row.admin, ts_ms: row.ts_ms });
}
/** Idempotent insert of a MarketRegistered event. */
export function recordRegisteredMarket(row) {
    getDb()
        .prepare(`INSERT INTO registered_markets (market_id, market_index, ts_ms)
       VALUES (@market_id, @market_index, @ts_ms)
       ON CONFLICT(market_id) DO UPDATE SET
         market_index = excluded.market_index,
         ts_ms = excluded.ts_ms`)
        .run({
        market_id: row.market_id,
        market_index: row.market_index,
        ts_ms: row.ts_ms,
    });
}
export function listRegisteredMarkets(limit = 200) {
    return getDb()
        .prepare(`SELECT market_id, market_index, ts_ms
         FROM registered_markets
        ORDER BY market_index ASC
        LIMIT ?`)
        .all(limit);
}
export function getRegistry() {
    const row = getDb()
        .prepare(`SELECT id, admin, ts_ms FROM registries ORDER BY ts_ms ASC LIMIT 1`)
        .get();
    return row ?? null;
}
function seedDemoMarkets() {
    const count = getDb()
        .prepare(`SELECT COUNT(*) as c FROM markets`)
        .get();
    if (count.c > 0)
        return;
    const now = Date.now();
    const demos = [
        {
            id: "demo-btc-100k",
            title: "Will BTC exceed $100k by June 30?",
            description: "Resolves YES if BTC spot >= $100,000 UTC on expiry.",
            category: "crypto",
            expiry_ms: now + 7 * 86_400_000,
            resolution_source: "CoinGecko BTC/USD",
            status: "active",
            order_book_id: "demo-book-btc",
            created_at_ms: now,
        },
        {
            id: "demo-sui-ath",
            title: "Will SUI hit a new ATH in 2026?",
            description: "Resolves YES if SUI exceeds prior all-time high before Dec 31.",
            category: "crypto",
            expiry_ms: now + 14 * 86_400_000,
            resolution_source: "CoinGecko SUI/USD",
            status: "active",
            order_book_id: "demo-book-sui",
            created_at_ms: now,
        },
    ];
    const insert = getDb().prepare(`
    INSERT OR IGNORE INTO markets
    (id, title, description, category, expiry_ms, resolution_source, status, order_book_id, created_at_ms)
    VALUES (@id, @title, @description, @category, @expiry_ms, @resolution_source, @status, @order_book_id, @created_at_ms)
  `);
    for (const m of demos)
        insert.run(m);
    const orderInsert = getDb().prepare(`
    INSERT OR IGNORE INTO demo_orders
    (market_id, order_id, owner, is_bid, price_bps, quantity, filled, timestamp_ms)
    VALUES (@market_id, @order_id, @owner, @is_bid, @price_bps, @quantity, @filled, @timestamp_ms)
  `);
    orderInsert.run({
        market_id: "demo-btc-100k",
        order_id: 1,
        owner: "0xagent",
        is_bid: 1,
        price_bps: 4800,
        quantity: 50_000_000,
        filled: 0,
        timestamp_ms: now,
    });
    orderInsert.run({
        market_id: "demo-btc-100k",
        order_id: 2,
        owner: "0xagent",
        is_bid: 0,
        price_bps: 5200,
        quantity: 50_000_000,
        filled: 0,
        timestamp_ms: now,
    });
}
export function upsertMarket(market) {
    getDb()
        .prepare(`INSERT INTO markets
       (id, title, description, category, expiry_ms, resolution_source, status, outcome, pool_id, order_book_id,
        deepbook_pool_key, deepbook_pool_id, deepbook_base_coin_type, deepbook_quote_coin_type,
        deepbook_base_scalar, deepbook_quote_scalar, referral_id, created_at_ms)
       VALUES (@id, @title, @description, @category, @expiry_ms, @resolution_source, @status, @outcome, @pool_id, @order_book_id,
        @deepbook_pool_key, @deepbook_pool_id, @deepbook_base_coin_type, @deepbook_quote_coin_type,
        @deepbook_base_scalar, @deepbook_quote_scalar, @referral_id, @created_at_ms)
       ON CONFLICT(id) DO UPDATE SET
         title=excluded.title, description=excluded.description, category=excluded.category,
         expiry_ms=excluded.expiry_ms, resolution_source=excluded.resolution_source,
         status=excluded.status, outcome=excluded.outcome, pool_id=excluded.pool_id,
         order_book_id=excluded.order_book_id,
         deepbook_pool_key=excluded.deepbook_pool_key, deepbook_pool_id=excluded.deepbook_pool_id,
         deepbook_base_coin_type=excluded.deepbook_base_coin_type,
         deepbook_quote_coin_type=excluded.deepbook_quote_coin_type,
         deepbook_base_scalar=excluded.deepbook_base_scalar,
         deepbook_quote_scalar=excluded.deepbook_quote_scalar,
         referral_id=excluded.referral_id`)
        .run({
        ...market,
        outcome: market.outcome ?? null,
        pool_id: market.pool_id ?? null,
        order_book_id: market.order_book_id ?? null,
        deepbook_pool_key: market.deepbook_pool_key ?? null,
        deepbook_pool_id: market.deepbook_pool_id ?? null,
        deepbook_base_coin_type: market.deepbook_base_coin_type ?? null,
        deepbook_quote_coin_type: market.deepbook_quote_coin_type ?? null,
        deepbook_base_scalar: market.deepbook_base_scalar ?? null,
        deepbook_quote_scalar: market.deepbook_quote_scalar ?? null,
        referral_id: market.referral_id ?? null,
        created_at_ms: market.created_at_ms ?? Date.now(),
    });
}
export function listMarkets() {
    return getDb()
        .prepare(`SELECT * FROM markets ORDER BY created_at_ms DESC`)
        .all()
        .map(rowToMarket);
}
export function getMarket(id) {
    const row = getDb().prepare(`SELECT * FROM markets WHERE id = ?`).get(id);
    return row ? rowToMarket(row) : null;
}
export function markMarketResolved(marketId, outcome) {
    // R57 agents audit fix: only flip markets that aren't already
    // resolved. The previous UPDATE had no `status != 'resolved'`
    // guard, so a re-org that re-broadcast an old `MarketResolved`
    // event would silently overwrite the existing `outcome` field
    // (a "yes" → "no" swap) and the leaderboard would re-rank the
    // market on the new outcome. The on-chain event is the
    // source of truth; the DB mirror should be idempotent.
    getDb()
        .prepare(`UPDATE markets SET status = 'resolved', outcome = ? WHERE id = ? AND status != 'resolved'`)
        .run(outcome, marketId);
}
// R57 agents audit fix: dedicated helper for the post-referral
// `referral_id` patch. The previous `market-creator.ts`
// imported `getDb` directly to issue
// `UPDATE markets SET referral_id = ? WHERE id = ?`, breaking
// the encapsulation of `markets/store.ts`. Wrap the SQL here
// so a future schema change (e.g. adding `referral_attempted_at`
// to the patch) only touches this file.
export function patchMarketReferralId(marketId, referralId) {
    getDb()
        .prepare(`UPDATE markets SET referral_id = ? WHERE id = ?`)
        .run(referralId, marketId);
}
export function markMarketDisputed(marketId, evidenceUri, disputeCount, timestampMs) {
    // R58.H3 audit fix: scope the dispute write to markets
    // that are still in `resolved`. The
    // `market-disputer` worker re-fires on
    // `MarketDisputed` events and a duplicate or replayed
    // event used to flip an already-`disputed` row back
    // to status='disputed' and overwrite the evidence URI
    // — losing the prior URI for the audit trail. Mirror
    // the `markMarketResolved` guard pattern from R57.
    const result = getDb()
        .prepare(`UPDATE markets
       SET disputed = 1,
           dispute_count = ?,
           dispute_evidence_uri = ?,
           last_dispute_at_ms = ?,
           status = 'disputed'
       WHERE id = ? AND status = 'resolved'`)
        .run(disputeCount, evidenceUri, timestampMs, marketId);
    if (result.changes === 0) {
        console.warn(`[store.markMarketDisputed] no-op for market=${marketId}; ` +
            `not in 'resolved' state. Likely a duplicate or replayed event.`);
    }
}
export function markMarketUndisputed(marketId, finalOutcome) {
    // After the dispute resolves, the market is back to its prior status
    // (resolved) with the (possibly-overridden) outcome. `dispute_count`
    // is preserved for the audit trail; only `disputed` is cleared.
    // R58.H3 audit fix: scope the undispu
    // te write to markets currently in `disputed` so
    // a stray post-resolution event can't unresolve a
    // never-disputed market. Mirror the
    // `markMarketDisputed` guard above.
    const result = getDb()
        .prepare(`UPDATE markets
       SET disputed = 0,
           status = 'resolved',
           outcome = ?
       WHERE id = ? AND status = 'disputed'`)
        .run(finalOutcome, marketId);
    if (result.changes === 0) {
        console.warn(`[store.markMarketUndisputed] no-op for market=${marketId}; ` +
            `not in 'disputed' state. Likely a duplicate or replayed event.`);
    }
}
export function upsertOrder(order) {
    getDb()
        .prepare(`INSERT INTO demo_orders (market_id, order_id, owner, is_bid, price_bps, quantity, filled, timestamp_ms)
       VALUES (@market_id, @order_id, @owner, @is_bid, @price_bps, @quantity, @filled, @timestamp_ms)
       ON CONFLICT(market_id, order_id) DO UPDATE SET
         filled=excluded.filled, quantity=excluded.quantity`)
        .run({
        ...order,
        is_bid: order.is_bid ? 1 : 0,
        filled: order.filled ?? 0,
    });
}
/**
 * R56 audit fix: per-market monotonic `order_id` for the demo
 * path, backed by the `demo_order_counters` table. The previous
 * in-process `Map` (R47) was cleared on every redeploy, so the
 * next tick re-seeded from `Date.now()` and could collide with
 * a previously-written `order_id` (a fast Railway redeploy keeps
 * `Date.now()` the same or smaller), flipping a cancelled row
 * back to `filled=0` via the `ON CONFLICT` clause in
 * `upsertOrder`. Atomic UPSERT inside a transaction so two MM
 * ticks racing across replicas (if the agents service is ever
 * horizontally scaled) cannot both read the same `next_id`.
 *
 * The `MAX(order_id)+1` seed is a safety net for the case where
 * a row was written directly to `demo_orders` (bypassing this
 * helper, e.g. by a future migration script) and the counter
 * table is empty. The `RETURNING next_id` returns the new
 * value for the caller's next bid/ask pair.
 */
export function nextDemoOrderId(marketId) {
    const db = getDb();
    // Atomic UPSERT: if a row exists, advance by 2 (one bid + one
    // ask) and return the OLD value; if not, seed from MAX(order_id)+1
    // for the market, or `Date.now()` if the table is empty.
    const stmt = db.prepare(`INSERT INTO demo_order_counters (market_id, next_id)
     VALUES (
       @marketId,
       COALESCE(
         (SELECT MAX(order_id) + 1 FROM demo_orders WHERE market_id = @marketId),
         @seed
       ) + 2
     )
     ON CONFLICT(market_id) DO UPDATE SET next_id = next_id + 2
     RETURNING next_id - 2 AS issued`);
    const row = stmt.get({ marketId, seed: Date.now() });
    if (row == null) {
        // Should be unreachable: UPSERT always returns a row.
        const fallback = Date.now();
        return fallback;
    }
    return Number(row.issued);
}
export function recordTrade(trade) {
    const id = `${trade.market_id}-${trade.order_id}-${trade.timestamp_ms}`;
    getDb()
        .prepare(`INSERT OR IGNORE INTO trades (id, market_id, order_id, price_bps, quantity, is_bid, timestamp_ms)
       VALUES (@id, @market_id, @order_id, @price_bps, @quantity, @is_bid, @timestamp_ms)`)
        .run({
        id,
        ...trade,
        is_bid: trade.is_bid ? 1 : 0,
    });
}
export function getOrderBook(marketId) {
    // Read the on-chain order book (`chain_orders`, populated by the
    // position-indexer from `OrderPlacedEvent`) instead of the synthetic
    // `demo_orders` table. `demo_orders` only carries the MarketMaker's
    // two-sided placeholder quotes; the production book is real user
    // orders. JOIN to `markets` for the deepbook scalars — the on-chain
    // `price` field is a u64 in DeepBook's scaled-integer space, so we
    // need both scalars to normalize back to the [0,1] range the UI
    // formats as bps (`price_bps = normalized * 10_000`).
    //
    // `chain_orders.filled_quantity` is declared for forward-compat
    // (a future fill-event subscription would write to it) but the
    // current Sui Predict contract does NOT emit an OrderFilled event
    // — fills happen inside DeepBook's matching engine and we have no
    // off-chain mirror of partial fill state. We therefore do NOT filter
    // on `co.filled_quantity < co.quantity`: every uncancelled placed
    // order is shown at its full quantity. For partial-fill state, the
    // /markets/:id/book REST route already overlays DeepBook's
    // authoritative `getOrderBookDepth` in the maker-bot path
    // (apps/agents/src/agents/market-maker.ts).
    // R48 audit fix: demo markets (id starts with `demo-`) only
    // ever have synthetic quotes written to `demo_orders` by the
    // market-maker (see `apps/agents/src/agents/market-maker.ts:179`).
    // The previous query only read `chain_orders`, so the demo
    // order book was always empty. UNION `demo_orders` into the
    // result so demo markets surface their maker quotes. The
    // `chain_orders` schema is rich (filled, scaled, etc.) and the
    // `demo_orders` schema is lean, so we only project the common
    // columns the OrderBookLevel needs.
    const isDemo = marketId.startsWith("demo-");
    const rows = isDemo
        ? getDb()
            .prepare(`SELECT do.market_id, do.order_id, do.owner, do.is_bid,
                  do.price_bps, do.quantity, 0 AS filled,
                  NULL AS cancelled_at_ms, 1 AS deepbook_base_scalar,
                  1 AS deepbook_quote_scalar
             FROM demo_orders do
            WHERE do.market_id = ?
            ORDER BY do.price_bps`)
            .all(marketId)
        : getDb()
            .prepare(`SELECT co.*, m.deepbook_base_scalar, m.deepbook_quote_scalar
           FROM chain_orders co
           LEFT JOIN markets m ON co.market_id = m.id
           WHERE co.market_id = ?
             AND co.cancelled_at_ms IS NULL
           ORDER BY co.price`)
            .all(marketId);
    const bids = [];
    const asks = [];
    for (const r of rows) {
        // No fill tracking → treat the full `quantity` as remaining.
        const remaining = r.quantity;
        if (remaining <= 0)
            continue;
        const baseScalar = r.deepbook_base_scalar ?? 1_000_000;
        const quoteScalar = r.deepbook_quote_scalar ?? 1_000_000;
        const rawPrice = r.price;
        // DeepBook stores price as `rawPrice = normalized * quoteScalar / baseScalar`
        // so to recover the [0,1] probability we invert: normalized = raw * base / quote.
        // If the scalars are missing for some reason, fall back to treating `price`
        // as already-normalized rather than emitting 0/NaN.
        const normalized = baseScalar && quoteScalar ? (rawPrice * baseScalar) / quoteScalar : rawPrice;
        const level = {
            price: normalized,
            price_bps: Math.round(normalized * 10_000),
            quantity: remaining,
            order_id: String(r.order_id),
        };
        if (r.is_bid)
            bids.push(level);
        else
            asks.push(level);
    }
    bids.sort((a, b) => b.price_bps - a.price_bps);
    asks.sort((a, b) => a.price_bps - b.price_bps);
    const bestBid = bids[0]?.price_bps ?? 0;
    const bestAsk = asks[0]?.price_bps ?? 10_000;
    const mid = bestBid && bestAsk ? (bestBid + bestAsk) / 2 / 10_000 : 0.5;
    const spread = bestBid && bestAsk ? bestAsk - bestBid : 400;
    return {
        market_id: marketId,
        bids: bids.slice(0, 20),
        asks: asks.slice(0, 20),
        spread_bps: spread,
        mid_price: mid,
    };
}
export function getTrades(marketId, limit = 50) {
    return getDb()
        .prepare(`SELECT * FROM trades WHERE market_id = ? ORDER BY timestamp_ms DESC LIMIT ?`)
        .all(marketId, limit)
        .map((r) => {
        const row = r;
        return {
            market_id: row.market_id,
            order_id: String(row.order_id),
            price_bps: row.price_bps,
            quantity: row.quantity,
            is_bid: Boolean(row.is_bid),
            timestamp_ms: row.timestamp_ms,
        };
    });
}
export function upsertPosition(marketId, address, yes, no) {
    getDb()
        .prepare(`INSERT INTO positions (market_id, address, yes, no)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(market_id, address) DO UPDATE SET yes=excluded.yes, no=excluded.no`)
        .run(marketId, address, yes, no);
}
export function decrementPosition(marketId, address, side, amount) {
    if (amount <= 0)
        return;
    const column = side === "yes" ? "yes" : "no";
    // R58.H2 audit fix: surface a loud warning when the
    // pre-update position is missing. The UPSERT pattern
    // here is correct (it inserts a 0-row,0-row sentinel
    // and then the DO UPDATE clamps at 0), but the path
    // that triggers it is itself a sign that an earlier
    // `incrementPosition` was missed — most commonly a
    // `PositionMinted` event seen by the indexer's poll
    // loop AFTER the `PositionRedeemed` event. Without
    // the warning the operator sees a phantom "0 shares
    // burned" in the decision log and assumes the
    // indexer is healthy. The same R45 pattern added
    // a warning to `markPoolWeekSettled` for a similar
    // reason.
    const before = getDb()
        .prepare(`SELECT yes, no FROM positions WHERE market_id = ? AND address = ?`)
        .get(marketId, address);
    if (!before) {
        console.warn(`[store.decrementPosition] no existing position for market=${marketId} ` +
            `address=${address}; UPSERTing a sentinel. The indexer is likely ` +
            `out of order (Redeemed seen before Minted).`);
    }
    else {
        const had = before[column];
        if (had < amount) {
            console.warn(`[store.decrementPosition] clamping ${column}=${had} - ${amount} -> 0 ` +
                `for market=${marketId} address=${address}. Burned > held; ` +
                `check the indexer cursor for a missed mint event.`);
        }
    }
    getDb()
        .prepare(`INSERT INTO positions (market_id, address, yes, no)
       VALUES (?, ?, 0, 0)
       ON CONFLICT(market_id, address) DO UPDATE SET
         ${column} = MAX(0, ${column} - ?)`)
        .run(marketId, address, amount);
}
export function getPosition(marketId, address) {
    const row = getDb()
        .prepare(`SELECT yes, no FROM positions WHERE market_id = ? AND address = ?`)
        .get(marketId, address);
    return row ?? null;
}
export function getPortfolio(address) {
    const rows = getDb()
        .prepare(`SELECT p.*, m.title, m.status, m.outcome
       FROM positions p JOIN markets m ON m.id = p.market_id
       WHERE p.address = ? AND (p.yes > 0 OR p.no > 0)`)
        .all(address);
    return rows.map((r) => ({
        market_id: r.market_id,
        title: r.title,
        yes: r.yes,
        no: r.no,
        status: r.status,
        outcome: r.outcome ?? null,
    }));
}
export function getVaultSummaryFromEnv() {
    // Return 0s when env vars are unset rather than fake 1B / 200M
    // placeholders. The risk monitor would otherwise show 80% utilization
    // on a non-existent vault and pause the agent policy. The 1B
    // default was a leftover from the predict-server shadow that
    // intentionally faked liquidity for UI demos.
    //
    // R56 audit fix: route both reads through `safeFloat`. The R55
    // sweep added `safeFloat` to lib.ts specifically for this
    // pattern (`Number("10_USDC")=NaN` from a unit-suffix paste,
    // `Number("1e20")` OOM, etc.) but this site was missed. A
    // `NaN` total falls to the `total_balance > 0 ? allocated /
    // total_balance : 0` branch in `risk-monitor.ts` (0% utilization),
    // so a critically over-utilized vault would never trip the
    // pause threshold. The opposite (env missing, total=0) reports
    // 0% utilization when the vault is actually over-budget.
    // Logged at warn so the operator can see the bad value in the
    // agent stderr and fix the env.
    const vaultId = process.env.VAULT_OBJECT_ID ?? "";
    const total = safeFloatFromEnv("VAULT_TOTAL_BALANCE", 0);
    const allocated = safeFloatFromEnv("VAULT_ALLOCATED", 0);
    return {
        vault_id: vaultId,
        total_balance: total,
        allocated,
        available: Math.max(0, total - allocated),
    };
}
// R56 audit fix: inlined env-safe float parse for the vault summary.
// `safeFloat` lives in `lib.ts` to keep the import surface small for
// callers that don't already pull from `lib.js`. This module's other
// helpers (`upsertOrder`, `getOrderBook`, etc.) only use the local
// `getDb()` singleton and the `@suipredict/sdk` types, so adding a
// full `lib.js` import would have been a heavier change for a single
// call site. Keep the guard semantics identical to `lib.safeFloat`:
// warn on non-finite, return the fallback.
function safeFloatFromEnv(name, fallback) {
    const v = process.env[name];
    if (v === undefined || v === null)
        return fallback;
    const n = Number(v);
    if (!Number.isFinite(n)) {
        console.warn(`[markets.store] env ${name}="${v}" is not a finite number; using fallback ${fallback}.`);
        return fallback;
    }
    return n;
}
export function recordChainOrder(o) {
    getDb()
        .prepare(`INSERT OR IGNORE INTO chain_orders
        (market_id, order_id, pool_id, client_order_id, is_bid, price, quantity, timestamp_ms)
       VALUES (@market_id, @order_id, @pool_id, @client_order_id, @is_bid, @price, @quantity, @timestamp_ms)`)
        .run({ ...o, is_bid: o.is_bid ? 1 : 0 });
}
export function recordSettlement(s) {
    getDb()
        .prepare(`INSERT INTO settlements (market_id, pool_id, trader, timestamp_ms)
       VALUES (@market_id, @pool_id, @trader, @timestamp_ms)`)
        .run(s);
}
/**
 * Mark a chain order as cancelled. Idempotent: a second call for the
 * same `(market_id, order_id)` is a no-op. Required by the UI's
 * "open orders" view, which otherwise keeps a cancelled row visible
 * until the next page load.
 */
export function markOrderCancelled(marketId, orderId, timestampMs) {
    getDb()
        .prepare(`UPDATE chain_orders
         SET cancelled_at_ms = ?
       WHERE market_id = ? AND order_id = ? AND cancelled_at_ms IS NULL`)
        .run(timestampMs, marketId, orderId);
}
export function listChainOrders(marketId, limit = 50) {
    // `cancelled_at_ms` is set by `markOrderCancelled` (driven by the
    // OrderCancelledEvent poller) and by the user-side cancel tx. The
    // UI's "open orders" panel filters by `cancelled_at_ms IS NULL`
    // server-side so a cancelled row doesn't keep rendering after the
    // user has dismissed the cancel toast.
    return getDb()
        .prepare(`SELECT * FROM chain_orders WHERE market_id = ?
         AND cancelled_at_ms IS NULL
       ORDER BY timestamp_ms DESC LIMIT ?`)
        .all(marketId, limit)
        .map((r) => {
        const row = r;
        return {
            market_id: row.market_id,
            order_id: row.order_id,
            pool_id: row.pool_id,
            client_order_id: String(row.client_order_id ?? ""),
            is_bid: Boolean(row.is_bid),
            price: row.price,
            quantity: row.quantity,
            timestamp_ms: row.timestamp_ms,
        };
    });
}
function rowToMarket(row) {
    const r = row;
    // R57 agents audit fix: validate `outcome` against the
    // documented union before casting. The previous
    // `r.outcome as MarketInfo["outcome"]` cast silently
    // accepted any string — a future schema migration that
    // renames `"yes"` → `"YES"` (or stores an error string) would
    // propagate the wrong value into the leaderboard and the
    // resolve-worker outcome classifier. Restrict to the two
    // documented values, fall back to `null` for anything else.
    const rawOutcome = r.outcome;
    const outcome = rawOutcome === "yes" || rawOutcome === "no" ? rawOutcome : null;
    return {
        id: r.id,
        title: r.title,
        description: r.description,
        category: r.category,
        expiry_ms: r.expiry_ms,
        resolution_source: r.resolution_source,
        status: r.status,
        outcome,
        pool_id: r.pool_id ?? null,
        order_book_id: r.order_book_id ?? null,
        deepbook_pool_key: r.deepbook_pool_key ?? null,
        deepbook_pool_id: r.deepbook_pool_id ?? null,
        deepbook_base_coin_type: r.deepbook_base_coin_type ?? null,
        deepbook_quote_coin_type: r.deepbook_quote_coin_type ?? null,
        deepbook_base_scalar: r.deepbook_base_scalar ?? null,
        deepbook_quote_scalar: r.deepbook_quote_scalar ?? null,
        referral_id: r.referral_id ?? null,
        created_at_ms: r.created_at_ms,
        // Dispute fields. `disputed` is INTEGER 0/1 in SQLite; coerce to a
        // proper boolean so the SDK contract matches the TS reader. The
        // other three are nullable — `dispute_count` defaults to 0 on the
        // schema but is included here so a future row without it doesn't
        // produce `undefined` in JSON.
        disputed: Boolean(r.disputed),
        dispute_count: r.dispute_count ?? 0,
        dispute_evidence_uri: r.dispute_evidence_uri ?? null,
        last_dispute_at_ms: r.last_dispute_at_ms ?? null,
    };
}
//# sourceMappingURL=store.js.map