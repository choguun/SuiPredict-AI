"use client";

import {
  useCurrentAccount,
  useCurrentClient,
  useDAppKit,
} from "@mysten/dapp-kit-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  buildBuyNoLimitOrderTx,
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

function clampProbability(value: number) {
  if (Number.isNaN(value)) return 0.5;
  return Math.min(0.99, Math.max(0.01, value));
}

function formatCents(value: number) {
  return `${(clampProbability(value) * 100).toFixed(1)}¢`;
}

function formatShares(value: number) {
  return (value / 1e6).toLocaleString(undefined, {
    maximumFractionDigits: 2,
  });
}

function formatDate(ms: number) {
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

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
  const initializedPrice = useRef(false);

  const refresh = useCallback(async () => {
    const [m, b] = await Promise.all([
      getMarket(marketId),
      getMarketOrderBook(marketId),
    ]);
    setMarket(m);
    setBook(b);
    if (b.mid_price && !initializedPrice.current) {
      setPrice(b.mid_price);
      initializedPrice.current = true;
    }
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

  const yesMid = book?.mid_price ?? 0.5;
  const impliedNo = 1 - yesMid;
  const displayedPrice = clampProbability(price);
  const yesLimitPrice = side === "yes" ? displayedPrice : 1 - displayedPrice;
  const priceBps = Math.round(clampProbability(yesLimitPrice) * 10_000);
  const isBid = side === "yes" ? orderSide === "buy" : orderSide === "sell";
  const isSyntheticBuyNo = side === "no" && orderSide === "buy";
  const quantityAtoms = BigInt(Math.floor(qty * 1_000_000));
  const quoteAtoms = (quantityAtoms * BigInt(priceBps)) / BigInt(10_000);
  const estimatedCost = displayedPrice * qty;
  const capitalRequired = isSyntheticBuyNo ? qty : estimatedCost;
  const payout = qty;
  const potentialProfit = Math.max(0, payout - estimatedCost);
  const actionLabel = `${orderSide === "buy" ? "Buy" : "Sell"} ${side.toUpperCase()}`;
  const routeLabel =
    isSyntheticBuyNo
      ? `Split DBUSDC, keep NO, ask YES at ${formatCents(yesLimitPrice)}`
      : side === "yes"
      ? `${orderSide === "buy" ? "Bid" : "Ask"} YES at ${formatCents(displayedPrice)}`
      : `${isBid ? "Bid" : "Ask"} YES at ${formatCents(yesLimitPrice)}`;

  function selectSide(next: "yes" | "no") {
    if (next === side) return;
    const currentYesPrice = side === "yes" ? displayedPrice : 1 - displayedPrice;
    setSide(next);
    setPrice(clampProbability(next === "yes" ? currentYesPrice : 1 - currentYesPrice));
  }

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
    if (!account || !client || !market?.order_book_id) return;
    setLoading(true);
    setStatus("Placing limit order…");
    try {
      let tx;
      const { objects } = await client.core.listCoins({
        owner: account.address,
        coinType: DBUSDC,
      });
      if (isSyntheticBuyNo) {
        const coin = objects.find((c) => BigInt(c.balance) >= quantityAtoms);
        if (!coin) {
          throw new Error(
            `Need ${(Number(quantityAtoms) / 1e6).toFixed(2)} DBUSDC to split collateral`,
          );
        }
        tx = buildBuyNoLimitOrderTx({
          marketId: market.id,
          orderBookId: market.order_book_id,
          collateralCoinId: coin.objectId,
          yesPriceBps: priceBps,
          quantity: quantityAtoms,
        });
      } else {
        let quoteCoinId: string | undefined;
        if (isBid) {
          const coin = objects.find((c) => BigInt(c.balance) >= quoteAtoms);
          if (!coin) {
            throw new Error(
              `Need ${(Number(quoteAtoms) / 1e6).toFixed(2)} DBUSDC for this bid`,
            );
          }
          quoteCoinId = coin.objectId;
        }
        tx = buildPlaceLimitOrderTx({
          marketId: market.id,
          orderBookId: market.order_book_id,
          isBid,
          priceBps,
          quantity: quantityAtoms,
          quoteCoinId,
        });
      }
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
    <div className="space-y-5">
      <Link
        href="/markets"
        className="inline-flex text-sm font-medium text-zinc-400 transition hover:text-white"
      >
        Back to markets
      </Link>

      <div className="rounded-lg border border-white/10 bg-[#11141d] p-5 sm:p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <Badge variant={market.status === "active" ? "success" : "warning"}>
                {market.status}
              </Badge>
              <span className="text-xs font-medium text-zinc-500">
                {market.category}
              </span>
              <span className="text-xs text-zinc-600">
                Ends {formatDate(market.expiry_ms)}
              </span>
            </div>
            <h1 className="max-w-4xl text-2xl font-semibold tracking-tight text-white sm:text-3xl">
              {market.title}
            </h1>
            <p className="mt-3 max-w-3xl text-sm leading-6 text-zinc-400">
              {market.description}
            </p>
          </div>

          <div className="grid min-w-full grid-cols-2 gap-2 sm:min-w-72">
            <div className="rounded-lg border border-emerald-400/20 bg-emerald-400/10 p-3">
              <p className="text-xs font-medium uppercase text-emerald-300/80">Yes</p>
              <p className="mt-1 text-3xl font-semibold text-emerald-200">
                {formatCents(yesMid)}
              </p>
            </div>
            <div className="rounded-lg border border-rose-400/20 bg-rose-400/10 p-3">
              <p className="text-xs font-medium uppercase text-rose-300/80">No</p>
              <p className="mt-1 text-3xl font-semibold text-rose-200">
                {formatCents(impliedNo)}
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <Card title="YES order book" className="order-2 lg:order-1">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="overflow-hidden rounded-lg border border-white/10">
              <div className="grid grid-cols-2 bg-white/[0.04] px-3 py-2 text-xs font-semibold uppercase text-zinc-500">
                <span>Bids</span>
                <span className="text-right">Shares</span>
              </div>
              {(book?.bids ?? []).slice(0, 8).map((l) => (
                <div
                  key={`b-${l.price_bps}`}
                  className="grid grid-cols-2 px-3 py-2 text-sm text-emerald-300 odd:bg-white/[0.02]"
                >
                  <span>{(l.price_bps / 100).toFixed(1)}¢</span>
                  <span className="text-right">{formatShares(l.quantity)}</span>
                </div>
              ))}
              {(book?.bids ?? []).length === 0 && (
                <p className="px-3 py-6 text-center text-sm text-zinc-500">
                  No bids yet
                </p>
              )}
            </div>
            <div className="overflow-hidden rounded-lg border border-white/10">
              <div className="grid grid-cols-2 bg-white/[0.04] px-3 py-2 text-xs font-semibold uppercase text-zinc-500">
                <span>Asks</span>
                <span className="text-right">Shares</span>
              </div>
              {(book?.asks ?? []).slice(0, 8).map((l) => (
                <div
                  key={`a-${l.price_bps}`}
                  className="grid grid-cols-2 px-3 py-2 text-sm text-rose-300 odd:bg-white/[0.02]"
                >
                  <span>{(l.price_bps / 100).toFixed(1)}¢</span>
                  <span className="text-right">{formatShares(l.quantity)}</span>
                </div>
              ))}
              {(book?.asks ?? []).length === 0 && (
                <p className="px-3 py-6 text-center text-sm text-zinc-500">
                  No asks yet
                </p>
              )}
            </div>
          </div>
          <div className="mt-4 grid grid-cols-3 gap-3 border-t border-white/10 pt-4">
            <Stat label="Mid YES" value={formatCents(yesMid)} />
            <Stat label="Implied NO" value={formatCents(impliedNo)} />
            <Stat label="Spread" value={`${book?.spread_bps ?? 0} bps`} />
          </div>
        </Card>

        <Card title="Trade" className="order-1 lg:order-2">
          <div className="mb-4 grid grid-cols-2 gap-2">
            {(["yes", "no"] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => selectSide(s)}
                className={`min-h-11 rounded-md text-sm font-semibold transition ${
                  side === s
                    ? s === "yes"
                      ? "bg-emerald-400 text-zinc-950"
                      : "bg-rose-400 text-zinc-950"
                    : "border border-white/10 bg-white/[0.04] text-zinc-400 hover:bg-white/10 hover:text-white"
                }`}
              >
                {s.toUpperCase()}
              </button>
            ))}
          </div>
          <div className="mb-4 grid grid-cols-2 gap-2">
            {(["buy", "sell"] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setOrderSide(s)}
                className={`min-h-11 rounded-md border text-sm font-semibold transition ${
                  orderSide === s
                    ? s === "buy"
                      ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-200"
                      : "border-rose-400/30 bg-rose-400/10 text-rose-200"
                    : "border-white/10 bg-white/[0.04] text-zinc-400 hover:bg-white/10 hover:text-white"
                }`}
              >
                {s === "buy" ? `Buy ${side.toUpperCase()}` : `Sell ${side.toUpperCase()}`}
              </button>
            ))}
          </div>

          <label className="mb-1.5 block text-xs font-semibold uppercase text-zinc-500">
            {side.toUpperCase()} price
          </label>
          <input
            type="number"
            step="0.01"
            min="0.01"
            max="0.99"
            value={price}
            onChange={(e) => setPrice(clampProbability(Number(e.target.value)))}
            className="mb-4 w-full rounded-md border border-white/10 bg-black/20 px-3 py-3 text-white outline-none transition focus:border-emerald-400/70"
          />
          <label className="mb-1.5 block text-xs font-semibold uppercase text-zinc-500">
            Size
          </label>
          <input
            type="number"
            step="0.01"
            min="0.01"
            value={qty}
            onChange={(e) => setQty(Math.max(0.01, Number(e.target.value)))}
            className="mb-4 w-full rounded-md border border-white/10 bg-black/20 px-3 py-3 text-white outline-none transition focus:border-emerald-400/70"
          />
          <div className="mb-4 rounded-lg border border-white/10 bg-black/20 p-3 text-sm">
            <div className="flex justify-between gap-3 text-zinc-400">
              <span>Est. cost</span>
              <span className="font-medium text-white">
                ${estimatedCost.toFixed(2)} DBUSDC
              </span>
            </div>
            <div className="mt-2 flex justify-between gap-3 text-zinc-400">
              <span>Capital needed</span>
              <span className="font-medium text-white">
                ${capitalRequired.toFixed(2)} DBUSDC
              </span>
            </div>
            <div className="mt-2 flex justify-between gap-3 text-zinc-400">
              <span>Max payout</span>
              <span className="font-medium text-white">
                ${payout.toFixed(2)}
              </span>
            </div>
            <div className="mt-2 flex justify-between gap-3 text-zinc-400">
              <span>Profit if right</span>
              <span className="font-medium text-emerald-300">
                ${potentialProfit.toFixed(2)}
              </span>
            </div>
            <p className="mt-3 border-t border-white/10 pt-3 text-xs leading-5 text-zinc-500">
              Order route: {routeLabel}. NO orders use the 1 - YES
              complement on the same book.
            </p>
          </div>
          <button
            type="button"
            disabled={loading || !account || market.id.startsWith("demo-")}
            onClick={placeOrder}
            className={`min-h-12 w-full rounded-md text-sm font-semibold text-zinc-950 transition disabled:cursor-not-allowed disabled:opacity-50 ${
              orderSide === "buy"
                ? "bg-emerald-400 hover:bg-emerald-300"
                : "bg-rose-400 hover:bg-rose-300"
            }`}
          >
            {actionLabel}
          </button>
          {market.id.startsWith("demo-") && (
            <p className="mt-3 text-xs leading-5 text-amber-300/90">
              Demo market — deploy contracts and set MARKET_REGISTRY_ID for on-chain orders.
            </p>
          )}
        </Card>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card title="Collateral">
          <p className="mb-4 text-sm leading-6 text-zinc-400">
            Split 1 DBUSDC → 1 YES + 1 NO. Merge pair back to DBUSDC.
          </p>
          <div className="grid grid-cols-2 gap-3">
            <button
              type="button"
              disabled={loading || !account || market.id.startsWith("demo-")}
              onClick={splitCollateral}
              className="min-h-11 rounded-md bg-white px-4 text-sm font-semibold text-zinc-950 transition hover:bg-zinc-200 disabled:opacity-50"
            >
              Split
            </button>
            <button
              type="button"
              disabled={loading || !account || market.id.startsWith("demo-")}
              onClick={mergeCollateral}
              className="min-h-11 rounded-md border border-white/10 bg-white/[0.04] px-4 text-sm font-semibold text-white transition hover:bg-white/10 disabled:opacity-50"
            >
              Merge
            </button>
          </div>
        </Card>
        <Card title="Your position">
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-2 gap-4">
              <Stat label="YES" value={(position.yes / 1e6).toFixed(4)} />
              <Stat label="NO" value={(position.no / 1e6).toFixed(4)} />
            </div>
            {market.status === "resolved" && (
              <button
                type="button"
                disabled={loading || !account || market.id.startsWith("demo-")}
                onClick={redeemWinner}
                className="w-fit rounded-md bg-emerald-400 px-5 py-2.5 text-sm font-semibold text-zinc-950 transition hover:bg-emerald-300 disabled:opacity-50"
              >
                Redeem winner
              </button>
            )}
          </div>
        </Card>
      </div>

      {status && (
        <div className="rounded-lg border border-white/10 bg-[#11141d] p-4">
          <p className="break-words font-mono text-sm text-emerald-300">{status}</p>
        </div>
      )}
    </div>
  );
}
