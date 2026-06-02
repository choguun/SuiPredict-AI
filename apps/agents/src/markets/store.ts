import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  MarketInfo,
  OrderBookLevel,
  OrderBookSnapshot,
  PortfolioPosition,
  TradeRecord,
} from "@suipredict/sdk";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, "../../data/markets.db");

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) {
    mkdirSync(dirname(DB_PATH), { recursive: true });
    db = new Database(DB_PATH);
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
    `);
    migrateMarketColumns();
    seedDemoMarkets();
  }
  return db;
}

/** Append a vault activity row. Used by the position-indexer. */
export function recordVaultFlow(flow: {
  vault_id: string;
  kind: "created" | "deposit" | "withdraw" | "allocate" | "deallocate";
  actor?: string;
  amount?: number;
  vlp_delta?: number;
  total_allocated?: number;
  ts_ms: number;
}): void {
  getDb()
    .prepare(
      `INSERT INTO vault_flows
         (vault_id, kind, actor, amount, vlp_delta, total_allocated, ts_ms)
       VALUES
         (@vault_id, @kind, @actor, @amount, @vlp_delta, @total_allocated, @ts_ms)`,
    )
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

export interface VaultFlow {
  id: number;
  vault_id: string;
  kind: "created" | "deposit" | "withdraw" | "allocate" | "deallocate";
  actor: string | null;
  amount: number;
  vlp_delta: number;
  total_allocated: number | null;
  ts_ms: number;
}

/** Recent vault flows, newest first. */
export function listVaultFlows(
  vaultId?: string,
  limit: number = 50,
): VaultFlow[] {
  const db = getDb();
  if (vaultId) {
    return db
      .prepare(
        `SELECT * FROM vault_flows WHERE vault_id = ? ORDER BY ts_ms DESC LIMIT ?`,
      )
      .all(vaultId, limit) as VaultFlow[];
  }
  return db
    .prepare(`SELECT * FROM vault_flows ORDER BY ts_ms DESC LIMIT ?`)
    .all(limit) as VaultFlow[];
}

function migrateMarketColumns() {
  const existing = new Set(
    (getDb().prepare(`PRAGMA table_info(markets)`).all() as { name: string }[]).map(
      (row) => row.name,
    ),
  );
  const columns: Record<string, string> = {
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
  };
  for (const [name, type] of Object.entries(columns)) {
    if (!existing.has(name)) {
      getDb().exec(`ALTER TABLE markets ADD COLUMN ${name} ${type}`);
    }
  }
}

function seedDemoMarkets() {
  const count = getDb()
    .prepare(`SELECT COUNT(*) as c FROM markets`)
    .get() as { c: number };
  if (count.c > 0) return;

  const now = Date.now();
  const demos: MarketInfo[] = [
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
  for (const m of demos) insert.run(m);

  const orderInsert = getDb().prepare(`
    INSERT OR IGNORE INTO orders
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

export function upsertMarket(market: MarketInfo): void {
  getDb()
    .prepare(
      `INSERT INTO markets
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
         referral_id=excluded.referral_id`,
    )
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

export function listMarkets(): MarketInfo[] {
  return getDb()
    .prepare(`SELECT * FROM markets ORDER BY created_at_ms DESC`)
    .all()
    .map(rowToMarket);
}

export function getMarket(id: string): MarketInfo | null {
  const row = getDb().prepare(`SELECT * FROM markets WHERE id = ?`).get(id);
  return row ? rowToMarket(row) : null;
}

export function markMarketResolved(
  marketId: string,
  outcome: "yes" | "no",
): void {
  getDb()
    .prepare(
      `UPDATE markets SET status = 'resolved', outcome = ? WHERE id = ?`,
    )
    .run(outcome, marketId);
}

export function markMarketDisputed(
  marketId: string,
  evidenceUri: string,
  disputeCount: number,
  timestampMs: number,
): void {
  getDb()
    .prepare(
      `UPDATE markets
       SET disputed = 1,
           dispute_count = ?,
           dispute_evidence_uri = ?,
           last_dispute_at_ms = ?,
           status = 'disputed'
       WHERE id = ?`,
    )
    .run(disputeCount, evidenceUri, timestampMs, marketId);
}

export function markMarketUndisputed(
  marketId: string,
  finalOutcome: "yes" | "no",
): void {
  // After the dispute resolves, the market is back to its prior status
  // (resolved) with the (possibly-overridden) outcome. `dispute_count`
  // is preserved for the audit trail; only `disputed` is cleared.
  getDb()
    .prepare(
      `UPDATE markets
       SET disputed = 0,
           status = 'resolved',
           outcome = ?
       WHERE id = ?`,
    )
    .run(finalOutcome, marketId);
}

export function upsertOrder(order: {
  market_id: string;
  order_id: number;
  owner: string;
  is_bid: boolean;
  price_bps: number;
  quantity: number;
  filled?: number;
  timestamp_ms: number;
}): void {
  getDb()
    .prepare(
      `INSERT INTO demo_orders (market_id, order_id, owner, is_bid, price_bps, quantity, filled, timestamp_ms)
       VALUES (@market_id, @order_id, @owner, @is_bid, @price_bps, @quantity, @filled, @timestamp_ms)
       ON CONFLICT(market_id, order_id) DO UPDATE SET
         filled=excluded.filled, quantity=excluded.quantity`,
    )
    .run({
      ...order,
      is_bid: order.is_bid ? 1 : 0,
      filled: order.filled ?? 0,
    });
}

export function recordTrade(trade: Omit<TradeRecord, "market_id"> & { market_id: string }): void {
  const id = `${trade.market_id}-${trade.order_id}-${trade.timestamp_ms}`;
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO trades (id, market_id, order_id, price_bps, quantity, is_bid, timestamp_ms)
       VALUES (@id, @market_id, @order_id, @price_bps, @quantity, @is_bid, @timestamp_ms)`,
    )
    .run({
      id,
      ...trade,
      is_bid: trade.is_bid ? 1 : 0,
    });
}

export function getOrderBook(marketId: string): OrderBookSnapshot {
  // Read the on-chain order book (`chain_orders`, populated by the
  // position-indexer from `OrderPlacedEvent`) instead of the synthetic
  // `demo_orders` table. `demo_orders` only carries the MarketMaker's
  // two-sided placeholder quotes; the production book is real user
  // orders. JOIN to `markets` for the deepbook scalars — the on-chain
  // `price` field is a u64 in DeepBook's scaled-integer space, so we
  // need both scalars to normalize back to the [0,1] range the UI
  // formats as bps (`price_bps = normalized * 10_000`).
  const rows = getDb()
    .prepare(
      `SELECT co.*, m.deepbook_base_scalar, m.deepbook_quote_scalar
       FROM chain_orders co
       LEFT JOIN markets m ON co.market_id = m.id
       WHERE co.market_id = ?
         AND co.cancelled_at_ms IS NULL
         AND co.filled_quantity < co.quantity
       ORDER BY co.price`,
    )
    .all(marketId) as Record<string, unknown>[];

  const bids: OrderBookLevel[] = [];
  const asks: OrderBookLevel[] = [];
  for (const r of rows) {
    const remaining = (r.quantity as number) - (r.filled_quantity as number);
    if (remaining <= 0) continue;
    const baseScalar = (r.deepbook_base_scalar as number | null) ?? 1_000_000;
    const quoteScalar = (r.deepbook_quote_scalar as number | null) ?? 1_000_000;
    const rawPrice = r.price as number;
    // DeepBook stores price as `rawPrice = normalized * quoteScalar / baseScalar`
    // so to recover the [0,1] probability we invert: normalized = raw * base / quote.
    // If the scalars are missing for some reason, fall back to treating `price`
    // as already-normalized rather than emitting 0/NaN.
    const normalized =
      baseScalar && quoteScalar ? (rawPrice * baseScalar) / quoteScalar : rawPrice;
    const level: OrderBookLevel = {
      price: normalized,
      price_bps: Math.round(normalized * 10_000),
      quantity: remaining,
      order_id: String(r.order_id),
    };
    if (r.is_bid) bids.push(level);
    else asks.push(level);
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

export function getTrades(marketId: string, limit = 50): TradeRecord[] {
  return getDb()
    .prepare(
      `SELECT * FROM trades WHERE market_id = ? ORDER BY timestamp_ms DESC LIMIT ?`,
    )
    .all(marketId, limit)
    .map((r) => {
      const row = r as Record<string, unknown>;
      return {
        market_id: row.market_id as string,
        order_id: String(row.order_id),
        price_bps: row.price_bps as number,
        quantity: row.quantity as number,
        is_bid: Boolean(row.is_bid),
        timestamp_ms: row.timestamp_ms as number,
      };
    });
}

export function upsertPosition(
  marketId: string,
  address: string,
  yes: number,
  no: number,
): void {
  getDb()
    .prepare(
      `INSERT INTO positions (market_id, address, yes, no)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(market_id, address) DO UPDATE SET yes=excluded.yes, no=excluded.no`,
    )
    .run(marketId, address, yes, no);
}

export function decrementPosition(
  marketId: string,
  address: string,
  side: "yes" | "no",
  amount: number,
): void {
  if (amount <= 0) return;
  const column = side === "yes" ? "yes" : "no";
  getDb()
    .prepare(
      `INSERT INTO positions (market_id, address, yes, no)
       VALUES (?, ?, 0, 0)
       ON CONFLICT(market_id, address) DO UPDATE SET
         ${column} = MAX(0, ${column} - ?)`,
    )
    .run(marketId, address, amount);
}

export function getPosition(
  marketId: string,
  address: string,
): { yes: number; no: number } | null {
  const row = getDb()
    .prepare(`SELECT yes, no FROM positions WHERE market_id = ? AND address = ?`)
    .get(marketId, address) as { yes: number; no: number } | undefined;
  return row ?? null;
}

export function getPortfolio(address: string): PortfolioPosition[] {
  const rows = getDb()
    .prepare(
      `SELECT p.*, m.title, m.status, m.outcome
       FROM positions p JOIN markets m ON m.id = p.market_id
       WHERE p.address = ? AND (p.yes > 0 OR p.no > 0)`,
    )
    .all(address) as Record<string, unknown>[];

  return rows.map((r) => ({
    market_id: r.market_id as string,
    title: r.title as string,
    yes: r.yes as number,
    no: r.no as number,
    status: r.status as string,
    outcome: (r.outcome as string) ?? null,
  }));
}

export function getVaultSummaryFromEnv(): {
  vault_id: string;
  total_balance: number;
  allocated: number;
  available: number;
} {
  // Return 0s when env vars are unset rather than fake 1B / 200M
  // placeholders. The risk monitor would otherwise show 80% utilization
  // on a non-existent vault and pause the agent policy. The 1B
  // default was a leftover from the predict-server shadow that
  // intentionally faked liquidity for UI demos.
  const vaultId = process.env.VAULT_OBJECT_ID ?? "";
  const total = Number(process.env.VAULT_TOTAL_BALANCE ?? 0);
  const allocated = Number(process.env.VAULT_ALLOCATED ?? 0);
  return {
    vault_id: vaultId,
    total_balance: total,
    allocated,
    available: Math.max(0, total - allocated),
  };
}

export function recordChainOrder(o: {
  market_id: string;
  order_id: string;
  pool_id: string;
  client_order_id: string;
  is_bid: boolean;
  price: number;
  quantity: number;
  timestamp_ms: number;
}): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO chain_orders
        (market_id, order_id, pool_id, client_order_id, is_bid, price, quantity, timestamp_ms)
       VALUES (@market_id, @order_id, @pool_id, @client_order_id, @is_bid, @price, @quantity, @timestamp_ms)`,
    )
    .run({ ...o, is_bid: o.is_bid ? 1 : 0 });
}

export function recordSettlement(s: {
  market_id: string;
  pool_id: string;
  trader: string;
  timestamp_ms: number;
}): void {
  getDb()
    .prepare(
      `INSERT INTO settlements (market_id, pool_id, trader, timestamp_ms)
       VALUES (@market_id, @pool_id, @trader, @timestamp_ms)`,
    )
    .run(s);
}

/**
 * Mark a chain order as cancelled. Idempotent: a second call for the
 * same `(market_id, order_id)` is a no-op. Required by the UI's
 * "open orders" view, which otherwise keeps a cancelled row visible
 * until the next page load.
 */
export function markOrderCancelled(
  marketId: string,
  orderId: string,
  timestampMs: number,
): void {
  getDb()
    .prepare(
      `UPDATE chain_orders
         SET cancelled_at_ms = ?
       WHERE market_id = ? AND order_id = ? AND cancelled_at_ms IS NULL`,
    )
    .run(timestampMs, marketId, orderId);
}

export function listChainOrders(
  marketId: string,
  limit = 50,
): Array<{
  market_id: string;
  order_id: string;
  pool_id: string;
  client_order_id: string;
  is_bid: boolean;
  price: number;
  quantity: number;
  timestamp_ms: number;
}> {
  // `cancelled_at_ms` is set by `markOrderCancelled` (driven by the
  // OrderCancelledEvent poller) and by the user-side cancel tx. The
  // UI's "open orders" panel filters by `cancelled_at_ms IS NULL`
  // server-side so a cancelled row doesn't keep rendering after the
  // user has dismissed the cancel toast.
  return getDb()
    .prepare(
      `SELECT * FROM chain_orders WHERE market_id = ?
         AND cancelled_at_ms IS NULL
       ORDER BY timestamp_ms DESC LIMIT ?`,
    )
    .all(marketId, limit)
    .map((r) => {
      const row = r as Record<string, unknown>;
      return {
        market_id: row.market_id as string,
        order_id: row.order_id as string,
        pool_id: row.pool_id as string,
        client_order_id: String(row.client_order_id ?? ""),
        is_bid: Boolean(row.is_bid),
        price: row.price as number,
        quantity: row.quantity as number,
        timestamp_ms: row.timestamp_ms as number,
      };
    });
}

function rowToMarket(row: unknown): MarketInfo {
  const r = row as Record<string, unknown>;
  return {
    id: r.id as string,
    title: r.title as string,
    description: r.description as string,
    category: r.category as string,
    expiry_ms: r.expiry_ms as number,
    resolution_source: r.resolution_source as string,
    status: r.status as MarketInfo["status"],
    outcome: (r.outcome as MarketInfo["outcome"]) ?? null,
    pool_id: (r.pool_id as string) ?? null,
    order_book_id: (r.order_book_id as string) ?? null,
    deepbook_pool_key: (r.deepbook_pool_key as string) ?? null,
    deepbook_pool_id: (r.deepbook_pool_id as string) ?? null,
    deepbook_base_coin_type: (r.deepbook_base_coin_type as string) ?? null,
    deepbook_quote_coin_type: (r.deepbook_quote_coin_type as string) ?? null,
    deepbook_base_scalar: (r.deepbook_base_scalar as number) ?? null,
    deepbook_quote_scalar: (r.deepbook_quote_scalar as number) ?? null,
    referral_id: (r.referral_id as string) ?? null,
    created_at_ms: r.created_at_ms as number,
    // Dispute fields. `disputed` is INTEGER 0/1 in SQLite; coerce to a
    // proper boolean so the SDK contract matches the TS reader. The
    // other three are nullable — `dispute_count` defaults to 0 on the
    // schema but is included here so a future row without it doesn't
    // produce `undefined` in JSON.
    disputed: Boolean(r.disputed),
    dispute_count: (r.dispute_count as number) ?? 0,
    dispute_evidence_uri: (r.dispute_evidence_uri as string) ?? null,
    last_dispute_at_ms: (r.last_dispute_at_ms as number) ?? null,
  };
}
