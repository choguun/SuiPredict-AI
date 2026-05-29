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

function getDb(): Database.Database {
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
        created_at_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS orders (
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
    `);
    seedDemoMarkets();
  }
  return db;
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
       (id, title, description, category, expiry_ms, resolution_source, status, outcome, pool_id, order_book_id, created_at_ms)
       VALUES (@id, @title, @description, @category, @expiry_ms, @resolution_source, @status, @outcome, @pool_id, @order_book_id, @created_at_ms)
       ON CONFLICT(id) DO UPDATE SET
         title=excluded.title, description=excluded.description, category=excluded.category,
         expiry_ms=excluded.expiry_ms, resolution_source=excluded.resolution_source,
         status=excluded.status, outcome=excluded.outcome, pool_id=excluded.pool_id,
         order_book_id=excluded.order_book_id`,
    )
    .run({
      ...market,
      outcome: market.outcome ?? null,
      pool_id: market.pool_id ?? null,
      order_book_id: market.order_book_id ?? null,
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
      `INSERT INTO orders (market_id, order_id, owner, is_bid, price_bps, quantity, filled, timestamp_ms)
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
  const rows = getDb()
    .prepare(
      `SELECT * FROM orders WHERE market_id = ? AND filled < quantity ORDER BY price_bps`,
    )
    .all(marketId) as Record<string, unknown>[];

  const bids: OrderBookLevel[] = [];
  const asks: OrderBookLevel[] = [];
  for (const r of rows) {
    const remaining = (r.quantity as number) - (r.filled as number);
    if (remaining <= 0) continue;
    const level: OrderBookLevel = {
      price: (r.price_bps as number) / 10_000,
      price_bps: r.price_bps as number,
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
  const vaultId = process.env.VAULT_OBJECT_ID ?? "demo-vault";
  const total = Number(process.env.VAULT_TOTAL_BALANCE ?? 1_000_000_000);
  const allocated = Number(process.env.VAULT_ALLOCATED ?? 200_000_000);
  return {
    vault_id: vaultId,
    total_balance: total,
    allocated,
    available: total - allocated,
  };
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
    created_at_ms: r.created_at_ms as number,
  };
}
