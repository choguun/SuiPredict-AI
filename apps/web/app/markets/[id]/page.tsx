"use client";

import {
  useCurrentAccount,
  useCurrentClient,
  useDAppKit,
} from "@mysten/dapp-kit-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import {
  buildMergeCollateralTx,
  buildPlaceLimitOrderTx,
  buildRedeemWinnerTx,
  buildSplitCollateralTx,
  getMarket,
  getMarketOrderBook,
  getPortfolio,
  type MarketInfo,
  type OrderBookSnapshot,
} from "@suipredict/sdk";
import { Badge, Card, Stat } from "@/components/ui";

function txDigest(r: { $kind: string; Transaction?: { digest: string } }): string {
  return r.$kind === "Transaction" ? r.Transaction!.digest : "unknown";
}

const DBUSDC =
  "0xf7152c05930480cd740d7311b5b8b45c6f488e3a53a11c3f74a6fac36a52e0d7::DBUSDC::DBUSDC";

export default function MarketDetailPage() {
  const { id } = useParams<{ id: string }>();
  const marketId = decodeURIComponent(id);
  const account = useCurrentAccount();
  const client = useCurrentClient();
  const dAppKit = useDAppKit();

  const [market, setMarket] = useState<MarketInfo | null>(null);
  const [book, setBook] = useState<OrderBookSnapshot | null>(null);
  const [side, setSide] = useState<"yes" | "no">("yes");
  const [orderSide, setOrderSide] = useState<"buy" | "sell">("buy");
  const [price, setPrice] = useState(0.5);
  const [qty, setQty] = useState(1);
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(false);
  const [position, setPosition] = useState({ yes: 0, no: 0 });

  const refresh = useCallback(async () => {
    const [m, b] = await Promise.all([
      getMarket(marketId),
      getMarketOrderBook(marketId),
    ]);
    setMarket(m);
    setBook(b);
    if (b.mid_price) setPrice(b.mid_price);
  }, [marketId]);

  useEffect(() => {
    refresh().catch(console.error);
    const t = setInterval(() => refresh().catch(console.error), 4000);
    return () => clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    if (!account) return;
    getPortfolio(account.address)
      .then((rows) => {
        const row = rows.find((p) => p.market_id === marketId);
        if (row) setPosition({ yes: row.yes, no: row.no });
      })
      .catch(() => {});
  }, [account, marketId, status]);

  const impliedNo = 1 - (book?.mid_price ?? price);
  const priceBps = Math.round(price * 10_000);

  async function splitCollateral() {
    if (!account || !client || !market) return;
    setLoading(true);
    setStatus("Splitting DBUSDC → YES + NO…");
    try {
      const { objects } = await client.core.listCoins({
        owner: account.address,
        coinType: DBUSDC,
      });
      const coin = objects[0];
      if (!coin) throw new Error("No DBUSDC — request from DeepBook testnet form");
      const tx = buildSplitCollateralTx(market.id, coin.objectId);
      const r = await dAppKit.signAndExecuteTransaction({ transaction: tx });
      setStatus(`Split OK: ${txDigest(r).slice(0, 16)}…`);
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "Split failed");
    } finally {
      setLoading(false);
    }
  }

  async function mergeCollateral() {
    if (!account || !client || !market) return;
    setLoading(true);
    setStatus("Merging YES + NO → DBUSDC…");
    try {
      const amount = BigInt(Math.floor(qty * 1_000_000));
      const tx = buildMergeCollateralTx(market.id, amount);
      const r = await dAppKit.signAndExecuteTransaction({ transaction: tx });
      setStatus(`Merge OK: ${txDigest(r).slice(0, 16)}…`);
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "Merge failed");
    } finally {
      setLoading(false);
    }
  }

  async function placeOrder() {
    if (!account || !market?.order_book_id) return;
    setLoading(true);
    setStatus("Placing limit order…");
    try {
      const tx = buildPlaceLimitOrderTx({
        marketId: market.id,
        orderBookId: market.order_book_id,
        isBid: orderSide === "buy",
        priceBps,
        quantity: BigInt(Math.floor(qty * 1_000_000)),
      });
      const r = await dAppKit.signAndExecuteTransaction({ transaction: tx });
      setStatus(`Order placed: ${txDigest(r).slice(0, 16)}…`);
      await refresh();
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "Order failed");
    } finally {
      setLoading(false);
    }
  }

  async function redeemWinner() {
    if (!account || !market) return;
    setLoading(true);
    try {
      const tx = buildRedeemWinnerTx(market.id);
      const r = await dAppKit.signAndExecuteTransaction({ transaction: tx });
      setStatus(`Redeemed: ${txDigest(r).slice(0, 16)}…`);
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "Redeem failed");
    } finally {
      setLoading(false);
    }
  }

  if (!market) {
    return (
      <Card>
        <p className="text-zinc-400">Loading market…</p>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <Link href="/markets" className="text-sm text-cyan-400 hover:underline">
        ← Markets
      </Link>
      <div>
        <Badge variant={market.status === "active" ? "success" : "warning"}>
          {market.status}
        </Badge>
        <h1 className="mt-2 text-2xl font-bold">{market.title}</h1>
        <p className="text-zinc-400">{market.description}</p>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Order book (YES)" className="lg:col-span-2">
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <p className="mb-2 text-xs uppercase text-zinc-500">Bids</p>
              {(book?.bids ?? []).slice(0, 8).map((l) => (
                <div key={`b-${l.price_bps}`} className="flex justify-between text-emerald-400">
                  <span>{(l.price_bps / 100).toFixed(1)}¢</span>
                  <span>{(l.quantity / 1e6).toFixed(2)}</span>
                </div>
              ))}
            </div>
            <div>
              <p className="mb-2 text-xs uppercase text-zinc-500">Asks</p>
              {(book?.asks ?? []).slice(0, 8).map((l) => (
                <div key={`a-${l.price_bps}`} className="flex justify-between text-rose-400">
                  <span>{(l.price_bps / 100).toFixed(1)}¢</span>
                  <span>{(l.quantity / 1e6).toFixed(2)}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="mt-4 flex gap-4 border-t border-zinc-800 pt-4">
            <Stat label="Mid YES" value={`${((book?.mid_price ?? 0.5) * 100).toFixed(1)}¢`} />
            <Stat label="Implied NO" value={`${(impliedNo * 100).toFixed(1)}¢`} />
            <Stat label="Spread" value={`${book?.spread_bps ?? 0} bps`} />
          </div>
        </Card>

        <Card title="Trade">
          <div className="flex gap-2 mb-3">
            {(["yes", "no"] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setSide(s)}
                className={`flex-1 rounded-lg py-2 text-sm ${
                  side === s ? "bg-cyan-500/20 text-cyan-300" : "bg-zinc-800 text-zinc-400"
                }`}
              >
                {s.toUpperCase()}
              </button>
            ))}
          </div>
          {side === "no" && (
            <p className="mb-3 text-xs text-zinc-500">
              NO price ≈ {(impliedNo * 100).toFixed(1)}¢ (1 − YES). Trade YES or hold NO from split.
            </p>
          )}
          <div className="flex gap-2 mb-3">
            {(["buy", "sell"] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setOrderSide(s)}
                className={`flex-1 rounded-lg py-2 text-sm ${
                  orderSide === s
                    ? s === "buy"
                      ? "bg-emerald-500/20 text-emerald-300"
                      : "bg-rose-500/20 text-rose-300"
                    : "bg-zinc-800 text-zinc-400"
                }`}
              >
                {s === "buy" ? "Buy YES" : "Sell YES"}
              </button>
            ))}
          </div>
          <label className="block text-xs text-zinc-500 mb-1">Price (0–1)</label>
          <input
            type="number"
            step="0.01"
            min="0.01"
            max="0.99"
            value={price}
            onChange={(e) => setPrice(Number(e.target.value))}
            className="w-full rounded-lg bg-zinc-800 px-3 py-2 mb-3"
          />
          <label className="block text-xs text-zinc-500 mb-1">Size (tokens)</label>
          <input
            type="number"
            min="0.01"
            value={qty}
            onChange={(e) => setQty(Number(e.target.value))}
            className="w-full rounded-lg bg-zinc-800 px-3 py-2 mb-3"
          />
          <button
            type="button"
            disabled={loading || !account || market.id.startsWith("demo-")}
            onClick={placeOrder}
            className="w-full rounded-lg bg-cyan-500 py-2.5 text-sm font-medium text-zinc-950 disabled:opacity-50"
          >
            Place limit order
          </button>
          {market.id.startsWith("demo-") && (
            <p className="mt-2 text-xs text-amber-400/80">
              Demo market — deploy contracts and set MARKET_REGISTRY_ID for on-chain orders.
            </p>
          )}
        </Card>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card title="Collateral">
          <p className="text-sm text-zinc-400 mb-3">
            Split 1 DBUSDC → 1 YES + 1 NO. Merge pair back to DBUSDC.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={loading || !account || market.id.startsWith("demo-")}
              onClick={splitCollateral}
              className="rounded-lg border border-zinc-700 px-4 py-2 text-sm hover:bg-zinc-800"
            >
              Split
            </button>
            <button
              type="button"
              disabled={loading || !account || market.id.startsWith("demo-")}
              onClick={mergeCollateral}
              className="rounded-lg border border-zinc-700 px-4 py-2 text-sm hover:bg-zinc-800"
            >
              Merge
            </button>
          </div>
        </Card>
        <Card title="Your position">
          <Stat label="YES" value={(position.yes / 1e6).toFixed(4)} />
          <Stat label="NO" value={(position.no / 1e6).toFixed(4)} />
          {market.status === "resolved" && (
            <button
              type="button"
              disabled={loading || !account || market.id.startsWith("demo-")}
              onClick={redeemWinner}
              className="mt-3 rounded-lg bg-emerald-600 px-4 py-2 text-sm text-white"
            >
              Redeem winner
            </button>
          )}
        </Card>
      </div>

      {status && (
        <p className="text-sm text-zinc-400 font-mono">{status}</p>
      )}
    </div>
  );
}
