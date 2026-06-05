"use client";

import {
  useCurrentAccount,
  useCurrentClient,
  useDAppKit,
} from "@mysten/dapp-kit-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  buildDeepBookCreateBalanceManagerTx,
  buildDeepBookDepositTx,
  buildMarketWithdrawSettledTx,
  buildMintSharesTx,
  buildPlaceOrderTx,
  dollarsToDusdc,
  DUSDC_TYPE,
  QUOTE_SCALE,
  extractCreatedObjectId,
  normalizeObjectId,
  buildRedeemNoTx,
  buildRedeemNoWithStreakTx,
  buildRedeemTx,
  buildRedeemWithStreakTx,
  createPredictionDeepBookClient,
  getMarket,
  getMarketOrderBook,
  getOrderBookDepth,
  getPortfolio,
  noCoinType,
  PREDICT_BASE_COIN_KEY,
  PREDICT_QUOTE_COIN_KEY,
  tupleBookToSnapshot,
  yesCoinType,
  isMoveAbortInModule,
  type MarketInfo,
  type OrderBookSnapshot,
} from "@suipredict/sdk";
import { Badge, Card, Stat } from "@/components/ui";
import { toast } from "sonner";
import { Tooltip } from "@/components/Tooltip";
import { useUserStreakId } from "@/hooks/useUserStreakId";
import { clampNumberString } from "@/lib/forms";

// R38 audit fix: the local `txDigest` helper that returned
// "unknown" on Failed/EffectsCert has been removed. All 5
// signAndExecuteTransaction call sites now do an explicit
// `r.$kind !== "Transaction"` early-return and read
// `r.Transaction.digest` directly. The helper previously
// obscured whether a digest was real (a real one) or a literal
// "unknown" string (failure path), which made it easy for new
// call sites to toast fake successes.

const QUOTE_COIN = DUSDC_TYPE;

/**
 * R47 audit fix: translate the common
 * `prediction_market` and DeepBook move-abort
 * codes into readable copy. The dispute page
 * already has a `friendlyDisputeError` helper
 * (R37); the markets/[id] page is the survivor
 * and was rendering raw "Mint failed on-chain"
 * / "Order failed on-chain" / "Redeem failed
 * on-chain" / "Withdraw settled failed on-chain"
 * toasts for every abort. A user with
 * insufficient DUSDC for a mint just saw
 * "Mint failed on-chain" with no hint about
 * why. The translation table here covers the
 * top-5 aborts; any other Move abort falls
 * through to the previous generic message so
 * we never *lose* information, only add it.
 */
function friendlyMoveError(err: unknown, action: string): string {
  if (isMoveAbortInModule(err, "prediction_market")) {
    return `${action} failed: the market is paused or already settled.`;
  }
  // Cast external-module names: the MoveModule type only enumerates
  // our own packages, but `isMoveAbortInModule`'s regex matches any
  // module name in the error message. balance_manager is the Sui
  // framework primitive, deepbook is the order-book package, dusdc
  // is the test-stablecoin — all of which can raise aborts our
  // markets/[id] actions depend on.
  if (isMoveAbortInModule(err, "balance_manager" as Parameters<typeof isMoveAbortInModule>[1])) {
    return `${action} failed: balance manager invariant violated (insufficient funds?).`;
  }
  if (isMoveAbortInModule(err, "deepbook" as Parameters<typeof isMoveAbortInModule>[1])) {
    return `${action} failed: DeepBook pool rejected the order.`;
  }
  if (isMoveAbortInModule(err, "dusdc" as Parameters<typeof isMoveAbortInModule>[1])) {
    return `${action} failed: insufficient DUSDC balance.`;
  }
  if (isMoveAbortInModule(err, "agent_policy")) {
    return `${action} failed: agent policy paused, revoked, or out of budget.`;
  }
  return `${action} failed on-chain`;
}

/**
 * R47 audit fix: extract the underlying Move-abort message from
 * a dapp-kit `FailedTransaction` result. The discriminated union
 * nests the failure as `r.FailedTransaction.status.error`, and
 * `isMoveAbortInModule` matches against `err.message` — so we
 * rewrap the message as an `Error` to feed the existing matcher
 * without changing its signature. Without this helper, the
 * call sites would either pass a structural object (which
 * `String()`s to `[object Object]`) or have to inline a deep
 * `?.` chain at every toast site.
 */
function failedTxToError(
  r: { FailedTransaction?: { status?: { success: false; error?: { message?: string } } | { success: true } } },
): Error {
  const failed = r.FailedTransaction;
  if (!failed) return new Error("Move transaction failed");
  const status = failed.status;
  if (!status || status.success !== false) {
    return new Error("Move transaction failed");
  }
  return new Error(status.error?.message ?? "Move transaction failed");
}

// R50 audit fix: was `?? "0x000…000"`. The `if (!FEE_VAULT_ID)` guards
// at lines 468 and 783 evaluated `if (!"0x000…000")` (false), so the
// "FEE_VAULT_ID is not set" toast never fired — the PTB submitted
// with the zero vault and the on-chain abort was opaque. `app/admin/
// page.tsx:81` already uses the `?? ""` pattern. Mirror that.
const FEE_VAULT_ID = process.env.NEXT_PUBLIC_FEE_VAULT_ID ?? "";

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
  // decodeURIComponent throws on malformed escapes (e.g. `%ZZ`); a
  // typo'd URL would otherwise surface as a Next.js error overlay
  // instead of the not_found card. Round-17 audit finding #23.
  //
  // The URL decode is performed in this thin wrapper component
  // BEFORE mounting MarketDetailBody. Doing the validation here (in
  // a component that calls no other hooks) lets us short-circuit to
  // MalformedIdCard without tripping react-hooks/rules-of-hooks — the
  // body component unconditionally calls all of its useState /
  // useRef / useEffect hooks regardless of the id validity.
  let marketId: string;
  try {
    marketId = decodeURIComponent(id);
  } catch {
    return <MalformedIdCard />;
  }
  return <MarketDetailBody marketId={marketId} />;
}

function MalformedIdCard() {
  return (
    <Card>
      <div className="space-y-3 py-2">
        <h2 className="text-lg font-semibold text-white">Market not found</h2>
        <p className="text-sm text-zinc-400">
          The URL contains a malformed market id.
        </p>
        <Link
          href="/markets"
          className="inline-block rounded-md border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-white/10"
        >
          Back to markets
        </Link>
      </div>
    </Card>
  );
}

function MarketDetailBody({ marketId }: { marketId: string }) {
  const account = useCurrentAccount();
  const client = useCurrentClient();
  const dAppKit = useDAppKit();
  const { streakId } = useUserStreakId(account?.address);


  const [market, setMarket] = useState<MarketInfo | null>(null);
  const [book, setBook] = useState<OrderBookSnapshot | null>(null);
  const [side, setSide] = useState<"yes" | "no">("yes");
  const [orderSide, setOrderSide] = useState<"buy" | "sell">("buy");
  const [price, setPrice] = useState(0.5);
  const [qty, setQty] = useState(1);
  // R50 audit fix: per-action busy flags. The previous
  // single `loading: boolean` gated 7 action buttons
  // (mint, placeOrder, createBalanceManager, deposit,
  // withdraw, redeemWinner, merge) — a user mid-mint
  // could not click `redeemWinner` independently. R49
  // closed the `market.outcome === null` redeem path
  // but did not split the busy flag. Use a single
  // string-union key instead of a `Map` so React's
  // referential-equality check on `disabled` stays
  // cheap (one switch per render).
  const [busy, setBusy] = useState<
    | null
    | "mint"
    | "placeOrder"
    | "createBalanceManager"
    | "deposit"
    | "withdraw"
    | "redeemWinner"
    | "merge"
  >(null);
  const [refreshCounter, setRefreshCounter] = useState(0);
  const [loadError, setLoadError] = useState<{
    kind: "not_found" | "fetch_failed";
    message: string;
  } | null>(null);
  const [position, setPosition] = useState({ yes: 0, no: 0 });
  const [balanceManagerId, setBalanceManagerId] = useState("");
  const [tradeCapId, setTradeCapId] = useState("");
  const [depositAsset, setDepositAsset] = useState<"quote" | "base">("quote");
  const [depositAmount, setDepositAmount] = useState(10);
  // R48 audit fix: invalidate the global React Query caches that
  // the markets list, portfolio, and daily-markets pages read, so
  // a user who mints/redeems/orders on this page and then navigates
  // to /portfolio or /markets sees fresh data immediately instead
  // of waiting for the 8s portfolio `refetchInterval` or the 60s
  // `staleTime` on the markets list. R30/R32/R37/R40/R43 added
  // this pattern to parlay, daily, settings, and other pages;
  // markets/[id] was the last survivor with 6 successful-tx
  // paths and zero cache invalidation.
  const queryClient = useQueryClient();
  const invalidateMarketCaches = useCallback(() => {
    if (!account?.address) return;
    void queryClient.invalidateQueries({
      queryKey: ["portfolio", account.address],
      type: "active",
    });
    void queryClient.invalidateQueries({
      queryKey: ["marketsList"],
      type: "active",
    });
    void queryClient.invalidateQueries({
      queryKey: ["dailyMarkets"],
      type: "active",
    });
    // R49 audit fix: also invalidate the streak queries. A
    // `redeemWinner` (and any other successful side effect) can
    // advance the user's daily streak on-chain via the
    // `record_participation` flow — the home page streak badge
    // stays stale for 30s otherwise. Pattern mirrors
    // `DailyPredictionCard.tsx:198-201`.
    void queryClient.invalidateQueries({
      queryKey: ["userStreakId"],
      type: "active",
    });
    void queryClient.invalidateQueries({
      queryKey: ["streakInfo"],
      type: "active",
    });
  }, [queryClient, account?.address]);
  const initializedPrice = useRef(false);
  // R36 audit fix: a single AbortController for the component's
  // lifetime. Polling intervals and the post-submit order-confirm
  // poll both honour it — on unmount the cleanup aborts both, so
  // navigating away mid-poll stops the in-flight fetches instead
  // of letting them run to the timeoutMs. The `null` sentinel lets
  // a click handler (e.g. placeOrder) read the current signal
  // lazily without re-rendering.
  const abortRef = useRef<AbortController | null>(null);
  // Refs let the polling `refresh` see the latest deepBookMarket config
  // (resolved after `market` loads) without re-creating the interval.
  const deepBookMarketRef = useRef<{
    poolKey: string;
    poolId: string;
    baseCoinType: string;
    quoteCoinType: string;
  } | null>(null);
  const clientRef = useRef(client);
  clientRef.current = client;

  const refresh = useCallback(async (signal?: AbortSignal) => {
    // R36 audit fix: bail out before any state writes if the
    // component has already unmounted. setState on a dead component
    // is a no-op in React 18 but logs a warning; checking up-front
    // keeps the dev console clean during route changes.
    if (signal?.aborted) return;
    let m: MarketInfo;
    try {
      m = await getMarket(marketId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // The indexer returns 404 for unknown ids; treat that distinctly
      // from a transport / 5xx failure so the UI can say "not found"
      // instead of "loading…" forever.
      const kind: "not_found" | "fetch_failed" = msg.includes("404")
        ? "not_found"
        : "fetch_failed";
      setMarket(null);
      setLoadError({ kind, message: msg });
      return;
    }
    if (signal?.aborted) return;
    setLoadError(null);
    setMarket(m);
    const cfg = deepBookMarketRef.current;
    let b: OrderBookSnapshot | null = null;
    if (cfg && clientRef.current) {
      // Read directly from DeepBook when the market has an on-chain
      // pool. This shows every order any user has placed, not just
      // the agent's, and updates within the RPC's eventual-
      // consistency window (typically <2s on testnet).
      try {
        const dbClient = createPredictionDeepBookClient({
          client: clientRef.current,
          address: m.deepbook_pool_id ?? cfg.poolId,
          market: cfg,
        });
        const tuple = await getOrderBookDepth(dbClient, cfg.poolKey);
        b = tupleBookToSnapshot(marketId, tuple.bids, tuple.asks);
      } catch {
        b = null;
      }
    }
    if (!b) {
      // Fall back to the agents REST endpoint (SQLite cache of
      // agent-placed orders) when the direct read fails or the
      // market has no on-chain pool yet.
      b = await getMarketOrderBook(marketId).catch(() => null);
    }
    if (b) {
      setBook(b);
      if (b.mid_price && !initializedPrice.current) {
        setPrice(b.mid_price);
        initializedPrice.current = true;
      }
    }
  }, [marketId]);

  useEffect(() => {
    // R36 audit fix: install an AbortController on mount; abort it
    // on unmount. The 4s refresh interval is short, but a user
    // navigating away mid-fetch would otherwise keep the request
    // open until the RPC returns. AbortController is plumbed into
    // the fetch in `refresh` via the `signal` arg below.
    //
    // R42 audit fix: pause the 4s refresh when the tab is hidden.
    // Browsers throttle background-tab timers to ~1s minimum and
    // some do not run them at all; the previous code would still
    // queue a `refresh()` on every tick, and the on-chain `getObject`
    // call was being batched with the user's other tabs to
    // RPC. Skip the refresh when `document.visibilityState !==
    // "visible"` so a tab that's been backgrounded for an hour
    // doesn't fire 900 `getObject` requests when the user comes
    // back. The mount-time `refresh()` call above is the first
    // data fetch and is intentionally not visibility-gated.
    const ctl = new AbortController();
    abortRef.current = ctl;
    refresh(ctl.signal).catch(console.error);
    const t = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      refresh(ctl.signal).catch(console.error);
    }, 4000);
    return () => {
      clearInterval(t);
      ctl.abort();
      abortRef.current = null;
    };
  }, [refresh]);

  useEffect(() => {
    if (!account) return;
    getPortfolio(account.address)
      .then((rows) => {
        const row = rows.find((p) => p.market_id === marketId);
        if (row) setPosition({ yes: row.yes, no: row.no });
      })
      .catch(() => {});
  }, [account, marketId, refreshCounter]);

  useEffect(() => {
    if (!account) return;
    const key = `suipredict.deepbook.${account.address}`;
    setBalanceManagerId(window.localStorage.getItem(`${key}.manager`) ?? "");
    setTradeCapId(window.localStorage.getItem(`${key}.tradeCap`) ?? "");
  }, [account]);

  useEffect(() => {
    if (!account) return;
    const key = `suipredict.deepbook.${account.address}`;
    if (balanceManagerId) window.localStorage.setItem(`${key}.manager`, balanceManagerId);
    else window.localStorage.removeItem(`${key}.manager`);
  }, [account, balanceManagerId]);

  useEffect(() => {
    if (!account) return;
    const key = `suipredict.deepbook.${account.address}`;
    if (tradeCapId) window.localStorage.setItem(`${key}.tradeCap`, tradeCapId);
    else window.localStorage.removeItem(`${key}.tradeCap`);
  }, [account, tradeCapId]);

  const yesMid = book?.mid_price ?? 0.5;
  const impliedNo = 1 - yesMid;
  const displayedPrice = clampProbability(price);
  const yesLimitPrice = side === "yes" ? displayedPrice : 1 - displayedPrice;
  const isBid = side === "yes" ? orderSide === "buy" : orderSide === "sell";
  const isSyntheticBuyNo = side === "no" && orderSide === "buy";
  const deepBookPoolKey =
    market?.deepbook_pool_key ??
    process.env.NEXT_PUBLIC_DEEPBOOK_POOL_KEY ??
    "";
  const deepBookPoolId =
    market?.deepbook_pool_id ?? process.env.NEXT_PUBLIC_DEEPBOOK_POOL_ID ?? "";
  const deepBookBaseCoinType =
    market?.deepbook_base_coin_type ??
    process.env.NEXT_PUBLIC_DEEPBOOK_YES_COIN_TYPE ??
    "";
  const deepBookQuoteCoinType =
    market?.deepbook_quote_coin_type ??
    process.env.NEXT_PUBLIC_DEEPBOOK_QUOTE_COIN_TYPE ??
    QUOTE_COIN;
  const deepBookMarket = useMemo(() => {
    if (!deepBookPoolId || !deepBookBaseCoinType) return null;
    return {
      poolKey: deepBookPoolKey,
      poolId: deepBookPoolId,
      baseCoinType: deepBookBaseCoinType,
      quoteCoinType: deepBookQuoteCoinType,
      baseScalar:
        market?.deepbook_base_scalar ??
        Number(process.env.NEXT_PUBLIC_DEEPBOOK_YES_COIN_SCALAR ?? 1_000_000),
      quoteScalar:
        market?.deepbook_quote_scalar ??
        Number(process.env.NEXT_PUBLIC_DEEPBOOK_QUOTE_COIN_SCALAR ?? 1_000_000),
    };
  }, [
    deepBookBaseCoinType,
    deepBookPoolId,
    deepBookPoolKey,
    deepBookQuoteCoinType,
    market?.deepbook_base_scalar,
    market?.deepbook_quote_scalar,
  ]);
  const useDeepBookRoute = Boolean(deepBookMarket && balanceManagerId);

  // Mirror the deepBookMarket config into a ref so the polling
  // `refresh` callback can read it without recreating the interval.
  useEffect(() => {
    deepBookMarketRef.current = deepBookMarket;
    if (deepBookMarket) {
      // Trigger an immediate re-read now that the pool is known.
      setRefreshCounter((c) => c + 1);
    }
  }, [deepBookMarket]);
  const estimatedCost = displayedPrice * qty;
  const capitalRequired = isSyntheticBuyNo ? qty : estimatedCost;
  const payout = qty;
  const potentialProfit = Math.max(0, payout - estimatedCost);
  const actionLabel = `${orderSide === "buy" ? "Buy" : "Sell"} ${side.toUpperCase()}`;
  const routeLabel =
    useDeepBookRoute
      ? `DeepBook V3 ${isBid ? "bid" : "ask"} YES at ${formatCents(yesLimitPrice)}`
      : isSyntheticBuyNo
      ? `Split DUSDC, keep NO, ask YES at ${formatCents(yesLimitPrice)}`
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
    if (!FEE_VAULT_ID) {
      toast.error("NEXT_PUBLIC_FEE_VAULT_ID is not set in this deployment.");
      return;
    }
    setBusy("mint");
    const toastId = toast.loading("Minting YES + NO from DUSDC…");
    try {
      // R51 audit fix: normalize the owner
      // address. The gRPC `listCoins` is
      // case-sensitive on the wire; a
      // mixed-case Enoki zkLogin session
      // (uppercased in the OAuth claim)
      // would not match the on-chain
      // `Address` field and silently return
      // `{ objects: [] }`.
      const { objects } = await client.core.listCoins({
        owner: normalizeObjectId(account.address),
        coinType: QUOTE_COIN,
        // R52 audit fix: the gRPC `listCoins` defaults to
        // a 50-coin page. A user with a long history of
        // gas-refund / redeem dust can have hundreds of
        // DUSDC coins; the default silently truncates and
        // the "largest coin" sort below picks a
        // representative but the total-balance preflight
        // under-counts. 100 is a small bump that covers
        // ~5y of normal activity on a single Sui address.
        limit: 100,
      });
      if (objects.length === 0) {
        throw new Error("No DUSDC — request from DeepBook testnet form");
      }
      // R51 audit fix: pick the largest coin, not
      // `objects[0]`. The previous code took the first
      // coin in the indexer's response order, which is
      // not necessarily the largest. A user with five
      // small DUSDC coins (gas refunds, prior redeem
      // dust) would have `coin.balance < amountAtoms`
      // and the PTB would abort with
      // `EInsufficientBalance`, paying gas for a
      // doomed tx. The sibling parlay flow at
      // `app/parlay/page.tsx:280-292` already does
      // this sort; this was the survivor.
      const sorted = [...objects].sort((a, b) =>
        BigInt(b.balance) > BigInt(a.balance) ? 1 : -1,
      );
      const coin = sorted[0]!;
      // Pre-flight balance check: the sorted coin's
      // balance must be >= `amountAtoms`. The PTB
      // also implicitly checks this via
      // `EInsufficientBalance`, but a clean error
      // before signing saves the user gas + the wallet
      // a confusing abort.
      const totalBalance = objects.reduce(
        (s, c) => s + BigInt(c.balance),
        BigInt(0),
      );
      const amountAtoms = dollarsToDusdc(qty);
      // R52 audit fix: pre-flight
      // using OR, not AND. The
      // previous `&&` required *both*
      // the largest single coin and
      // the total balance to be below
      // `amountAtoms` to throw. A user
      // with five 0.5 DUSDC dust coins
      // (largest < 1 DUSDC, total =
      // 2.5 DUSDC) would pass the
      // check, then the PTB would
      // build against a 0.5 DUSDC
      // coin and abort on-chain with
      // an opaque Move error. The
      // contract's `splitCoins` takes
      // a single input coin — it
      // can't merge across coins
      // without a separate merge PTB
      // — so the largest-coin gate
      // is the right correctness
      // check.
      if (BigInt(coin.balance) < amountAtoms) {
        throw new Error(
          `Insufficient DUSDC in a single coin: need ${(Number(amountAtoms) / 1e6).toFixed(2)} DUSDC ` +
            `in one coin, largest is ${(Number(coin.balance) / 1e6).toFixed(2)} ` +
            `(total across ${objects.length} coin(s) is ${(Number(totalBalance) / 1e6).toFixed(2)}). ` +
            `Consolidate via a merge tx or deposit more DUSDC.`,
        );
      }
      // Convert the displayed `qty` (in dollars) to DUSDC atoms
      // (6 decimals). The SDK's `buildMintSharesTx` splits that
      // amount off the user's DUSDC bag in-PTB and passes only the
      // split coin to `mint_shares` — the whole bag is never
      // deposited.
      const tx = buildMintSharesTx(market.id, FEE_VAULT_ID, coin.objectId, amountAtoms);
      const r = await dAppKit.signAndExecuteTransaction({ transaction: tx });
      // R38 audit fix: same R30/R32/R37 pattern. The previous
      // `txDigest(r)` helper returns the literal "unknown" on a
      // Failed/EffectsCert result and the success toast fired
      // anyway, lying to the user that a mint succeeded.
      if (r.$kind !== "Transaction") {
        toast.error(friendlyMoveError(failedTxToError(r), "Mint"), { id: toastId });
        return;
      }
      toast.success(`Minted YES + NO: ${r.Transaction.digest.slice(0, 16)}…`, { id: toastId });
      setRefreshCounter(c => c + 1);
      invalidateMarketCaches();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Mint failed", { id: toastId });
    } finally {
      setBusy(null);
    }
  }

  async function mergeCollateral() {
    // The on-chain prediction_market module has no merge_pair entry; the
    // canonical way to exit a position pre-resolution is to sell YES and
    // NO separately on the DeepBook order book. Send the user to the
    // dedicated "Sell shares" card below to do that, rather than
    // pretending a stub click is real.
    toast.message(
      "To exit, sell YES and NO on the order book below. There is no on-chain merge.",
    );
    document
      .getElementById("trade-card")
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async function placeOrder() {
    if (!account || !client || !market) return;
    if (!useDeepBookRoute) {
      toast.error(
        "Limit orders for this market require a DeepBook pool. Use 'Mint Shares' to mint YES+NO, then sell on the DeepBook order book.",
      );
      return;
    }
    if (!deepBookMarket) return;
    setBusy("placeOrder");
    const clientOrderId = String(Date.now());
    const toastId = toast.loading("Submitting DeepBook V3 limit order...");
    try {
      // R50 audit fix: route through
      // `buildPlaceOrderTx` (the prediction_market
      // wrapper) instead of the DeepBook-direct
      // `buildDeepBookPlaceLimitOrderTx`. The
      // wrapper emits `OrderPlacedEvent { market_id,
      // pool_id, ... }`; the position-indexer relies
      // on this event to advance its `settled_weeks`
      // cursor and to surface the order in the
      // user's portfolio. The DeepBook-direct path
      // emits only DeepBook's own
      // `OrderPlaced` (no `market_id`), so the
      // indexer has no way to attribute the order
      // to a market. Limit-order orders were
      // invisible to the indexer before this fix.
      const tx = buildPlaceOrderTx({
        marketId: market.id,
        poolId: deepBookMarket.poolId,
        balanceManagerId,
        clientOrderId: BigInt(clientOrderId),
        // R50 audit fix: scale the 0..1 dollar price
        // to the on-chain 1e9-scaled quote units the
        // wrapper expects (the
        // `prediction_market::place_order` docstring
        // at `prediction_market.move:737` calls this
        // out: "500_000_000 = 0.5 Q"). The DeepBook-
        // direct path's `placeLimitOrder` accepted a
        // `number` and scaled internally; the wrapper
        // takes a raw `bigint` so the caller has to
        // do the conversion explicitly. `QUOTE_SCALE`
        // lives in the SDK barrel so we don't
        // hardcode 1e9 in three places.
        price: BigInt(Math.round(yesLimitPrice * Number(QUOTE_SCALE))),
        // `qty` is the YES * 10^decimals base quantity.
        // `displayedPrice * qty` would be a fraction
        // (0..qty), so we pass qty directly. The
        // DeepBook-direct path took a `number`; the
        // wrapper takes a `bigint` (the on-chain
        // signature is `quantity: u64`).
        quantity: BigInt(qty),
        isBid,
      });
      const r = await dAppKit.signAndExecuteTransaction({ transaction: tx });
      // R38 audit fix: dAppKit can return Failed/EffectsCert here
      // (insufficient gas, paused pool, balance-mgr invariant). On
      // those paths `txDigest(r)` returns the literal string
      // "unknown" — toast.loading would then poll an indexer endpoint
      // for 65s with no real digest to match, hammering the agents
      // service for no reason. Surface the error early and skip the
      // indexer poll.
      if (r.$kind !== "Transaction") {
        toast.error(friendlyMoveError(failedTxToError(r), "Order"), { id: toastId });
        return;
      }
      const digest = r.Transaction.digest;
      // Distinguish "submitted" from "placed". The wallet adapter returns
      // once the fullnode accepts the tx — but the position indexer
      // (cron */1) can take up to 60s to record the OrderPlaced event,
      // during which the user sees no order in the book. The
      // `clientOrderId` we passed in is stored verbatim on the order
      // row, so we can match against it specifically instead of just
      // waiting for "any new order". 30s is the sweet spot — most
      // orders are picked up within one cron tick (≤60s) but a
      // borderline-aligned tx would still fall through to the
      // "indexer hasn't seen it yet" toast.
      toast.loading(`Awaiting indexer: ${digest.slice(0, 16)}…`, { id: toastId });
      // Bumped from 30s → 65s. The position-indexer runs on `*/1`
      // (every minute), so a successful place_order can spend up to
      // ~60s in the indexer's pending window before it surfaces in
      // `chain_orders`. The 30s timeout was shorter than the indexer's
      // worst-case lag; the first confirmation attempt was more
      // likely to time out than succeed under load (round-17 audit
      // finding #10).
      const placed = await waitForOrderInBook(
        market.id,
        clientOrderId,
        65_000,
        abortRef.current?.signal,
      );
      if (placed) {
        toast.success(`Order placed: ${digest.slice(0, 16)}…`, { id: toastId });
        invalidateMarketCaches();
      } else {
        toast.message(
          `Order submitted (${digest.slice(0, 16)}…) but the indexer hasn't ` +
            "seen it yet. It will appear in the order book within ~60s.",
          { id: toastId, duration: 6_000 },
        );
      }
      await refresh();
      setRefreshCounter(c => c + 1);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Order failed", { id: toastId });
    } finally {
      setBusy(null);
    }
  }

  /**
   * Poll the agents `/markets/:id/orders` endpoint until a row with
   * `client_order_id == clientOrderId` appears. The chain_orders table
   * doesn't carry a trader column (would need a schema migration to
   * filter by user), so matching on the client-supplied
   * `client_order_id` is the cheapest reliable signal.
   */
  async function waitForOrderInBook(
    mid: string,
    clientOrderId: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const base = process.env.NEXT_PUBLIC_AGENTS_URL ?? "http://localhost:3001";
    const url = `${base}/markets/${encodeURIComponent(mid)}/orders?limit=50`;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      // R36 audit fix: bail out of the poll loop if the caller
      // unmounts (Next.js cancels via AbortSignal on the parent
      // effect's cleanup). Without this, an in-flight order
      // confirmation keeps fetching for the full timeout after
      // the user has navigated away.
      if (signal?.aborted) return false;
      try {
        const res = await fetch(url, { cache: "no-store", signal });
        if (res.ok) {
          const data = (await res.json()) as {
            orders?: { client_order_id?: number | string }[];
          };
          if (
            data.orders?.some(
              (o) => String(o.client_order_id ?? "") === clientOrderId,
            )
          ) {
            return true;
          }
        }
      } catch (err) {
        // AbortError on unmount; otherwise agents down — let the
        // natural tick pick it up.
        if (err instanceof DOMException && err.name === "AbortError") {
          return false;
        }
      }
      await new Promise((r) => setTimeout(r, 1_500));
    }
    return false;
  }

  async function createBalanceManager() {
    if (!account || !client || !deepBookMarket) return;
    setBusy("createBalanceManager");
    const toastId = toast.loading("Creating DeepBook V3 BalanceManager...");
    try {
      const dbClient = createPredictionDeepBookClient({
        client,
        address: account.address,
        market: deepBookMarket,
      });
      const tx = buildDeepBookCreateBalanceManagerTx(dbClient, account.address);
      const r = await dAppKit.signAndExecuteTransaction({ transaction: tx });
      // R38 audit fix: same $kind guard as placeOrder. On a Failed
      // return, `txDigest(r)` would yield the literal "unknown"
      // and we would then both (a) toast a fake success and
      // (b) `extractCreatedObjectId(client, "unknown", ...)` would
      // RPC-throw on the malformed digest. The "unknown" string is
      // also a dangerous value to ever persist to localStorage —
      // a later page load would re-derive the key
      // `suipredict.deepbook.<addr>.manager = "unknown"` and every
      // subsequent deposit/place-order call would 404 trying to
      // fetch a non-existent object.
      if (r.$kind !== "Transaction") {
        toast.error(friendlyMoveError(failedTxToError(r), "BalanceManager creation"), { id: toastId });
        return;
      }
      const digest = r.Transaction.digest;
      // Discover the new shared BalanceManager ID from the tx effects
      // and persist it so subsequent deposit/place-order calls find it.
      const managerId = await extractCreatedObjectId(
        client,
        digest,
        "balance_manager::BalanceManager",
      );
      if (managerId) {
        setBalanceManagerId(managerId);
        window.localStorage.setItem(
          `suipredict.deepbook.${account.address}.manager`,
          managerId,
        );
      }
      toast.success(
        `BalanceManager created: ${digest.slice(0, 16)}...`, { id: toastId }
      );
      // Wait a moment for indexer before refreshing
      setTimeout(() => setRefreshCounter(c => c + 1), 2000);
      invalidateMarketCaches();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "BalanceManager creation failed", { id: toastId });
    } finally {
      setBusy(null);
    }
  }

  async function depositToBalanceManager() {
    if (!account || !client || !deepBookMarket || !balanceManagerId) return;
    setBusy("deposit");
    const toastId = toast.loading("Depositing to DeepBook V3 BalanceManager...");
    try {
      const dbClient = createPredictionDeepBookClient({
        client,
        address: account.address,
        balanceManagerId,
        tradeCapId: tradeCapId || undefined,
        market: deepBookMarket,
      });
      const tx = buildDeepBookDepositTx(
        dbClient,
        depositAsset === "base" ? PREDICT_BASE_COIN_KEY : PREDICT_QUOTE_COIN_KEY,
        depositAmount,
      );
      const r = await dAppKit.signAndExecuteTransaction({ transaction: tx });
      // R38 audit fix: $kind guard for deposit. The deposit path is
      // the one most likely to silently "succeed" with "unknown" on
      // a quota-exhausted BalanceManager (the tx would not abort
      // cleanly at the wallet layer, but the move abort would only
      // show in effects certs). Surface the error to the user
      // instead of an "Deposit OK: unknown..." toast.
      if (r.$kind !== "Transaction") {
        toast.error(friendlyMoveError(failedTxToError(r), "Deposit"), { id: toastId });
        return;
      }
      toast.success(`Deposit OK: ${r.Transaction.digest.slice(0, 16)}...`, { id: toastId });
      invalidateMarketCaches();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Deposit failed", { id: toastId });
    } finally {
      setBusy(null);
    }
  }

  async function withdrawSettledDeepBook() {
    if (!account || !client || !market || !deepBookMarket || !balanceManagerId) return;
    setBusy("withdraw");
    const toastId = toast.loading("Withdrawing settled balances...");
    try {
      // Route through the market wrapper (`prediction_market::withdraw_settled`)
      // so the on-chain `SettledEvent` fires. The indexer advances the
      // leaderboard's `pool_weeks` cursor from that event; calling the
      // bare DeepBook `pool::withdraw_settled_amounts` (as `withdrawSettled`
      // historically did) would settle funds for the user but leave the
      // off-chain leaderboard thinking the week is un-settled.
      const tx = buildMarketWithdrawSettledTx(
        market.id,
        deepBookMarket.poolId,
        balanceManagerId,
      );
      const r = await dAppKit.signAndExecuteTransaction({ transaction: tx });
      // R38 audit fix: $kind guard. If withdraw_settled aborted (no
      // settled amounts available) we'd previously toast
      // "Settled balances withdrawn: unknown..." — extremely
      // misleading because the leaderboard pool_weeks cursor also
      // would not advance, so the user might wait a full week
      // before noticing their `SettledEvent` was never emitted.
      if (r.$kind !== "Transaction") {
        toast.error(friendlyMoveError(failedTxToError(r), "Withdraw settled"), { id: toastId });
        return;
      }
      toast.success(`Settled balances withdrawn: ${r.Transaction.digest.slice(0, 16)}...`, { id: toastId });
      setRefreshCounter(c => c + 1);
      invalidateMarketCaches();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Withdraw settled failed", { id: toastId });
    } finally {
      setBusy(null);
    }
  }

  async function redeemWinner() {
    if (!account || !client || !market) return;
    if (!FEE_VAULT_ID) {
      toast.error("NEXT_PUBLIC_FEE_VAULT_ID is not set in this deployment.");
      return;
    }
    if (market.status !== "resolved") {
      toast.error("Market is not resolved yet");
      return;
    }
    const winningSide = market.outcome === "yes" ? "yes" : market.outcome === "no" ? "no" : null;
    if (!winningSide) {
      toast.error("Market has no outcome recorded");
      return;
    }
    setBusy("redeemWinner");
    const toastId = toast.loading("Fetching your winning position...");
    try {
      const winningCoinType = winningSide === "yes" ? yesCoinType() : noCoinType();
      // R51 audit fix: normalize the owner
      // address. `listCoins` is case-sensitive
      // on the wire — a mixed-case Enoki
      // zkLogin session would otherwise
      // silently return `{ objects: [] }`
      // and trigger the "You don't hold
      // any ..." toast for a user who
      // actually holds winning tokens.
      const { objects } = await client.core.listCoins({
        owner: normalizeObjectId(account.address),
        coinType: winningCoinType,
        // R52 audit fix: same `limit: 100` rationale
        // as `splitCollateral` above. A winner with
        // 50+ winning-coin fragments would see
        // `objects[0]` and assume that's the only
        // coin; if the chain has more, the
        // unredeemed remainder stays in the wallet
        // because the redeemer only handles one
        // objectId.
        limit: 100,
      });
      const coin = objects[0];
      if (!coin) {
        throw new Error(
          `You don't hold any ${winningSide.toUpperCase()} tokens for this market`,
        );
      }
      toast.loading(
        streakId
          ? "Redeeming with streak boost…"
          : "Redeeming…",
        { id: toastId },
      );
      const tx =
        winningSide === "yes"
          ? streakId
            ? buildRedeemWithStreakTx(market.id, FEE_VAULT_ID, coin.objectId, streakId)
            : buildRedeemTx(market.id, FEE_VAULT_ID, coin.objectId)
          : streakId
            ? buildRedeemNoWithStreakTx(market.id, FEE_VAULT_ID, coin.objectId, streakId)
            : buildRedeemNoTx(market.id, FEE_VAULT_ID, coin.objectId);
      const r = await dAppKit.signAndExecuteTransaction({ transaction: tx });
      // R38 audit fix: $kind guard for redeem. Redeem is the most
      // asymmetric call here — a Failed result means the user
      // burned gas and lost the streak-attached position proof,
      // but the previous code path would still toast
      // "Redeemed: unknown..." which is much worse than no toast.
      if (r.$kind !== "Transaction") {
        toast.error(friendlyMoveError(failedTxToError(r), "Redeem"), { id: toastId });
        return;
      }
      toast.success(`Redeemed: ${r.Transaction.digest.slice(0, 16)}…`, { id: toastId });
      setRefreshCounter(c => c + 1);
      invalidateMarketCaches();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Redeem failed", { id: toastId });
    } finally {
      setBusy(null);
    }
  }

  if (!market) {
    if (loadError) {
      const isNotFound = loadError.kind === "not_found";
      return (
        <Card>
          <div className="space-y-3 py-2">
            <h2 className="text-lg font-semibold text-white">
              {isNotFound ? "Market not found" : "Could not load market"}
            </h2>
            <p className="text-sm text-zinc-400">
              {isNotFound
                ? `No market exists with id ${marketId.slice(0, 16)}… on this network.`
                : "The agents indexer is unreachable. Start it with `pnpm dev:agents` and refresh."}
            </p>
            <div className="flex gap-2">
              <Link
                href="/markets"
                className="rounded-md border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-white/10"
              >
                Back to markets
              </Link>
              {!isNotFound && (
                <button
                  type="button"
                  onClick={() => {
                    setLoadError(null);
                    setRefreshCounter((c) => c + 1);
                  }}
                  className="rounded-md bg-gradient-to-r from-violet-600 to-cyan-600 px-3 py-1.5 text-xs font-semibold text-white"
                >
                  Retry
                </button>
              )}
            </div>
          </div>
        </Card>
      );
    }
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

      <div className="relative overflow-hidden rounded-3xl border border-white/10 bg-[#11141d] p-6 sm:p-8 shadow-2xl shadow-black/40">
        {/* Background Gradients */}
        <div className="absolute -top-40 -right-40 h-[400px] w-[400px] rounded-full bg-cyan-600/10 blur-[80px] pointer-events-none" />
        <div className="absolute -bottom-40 -left-40 h-[400px] w-[400px] rounded-full bg-violet-600/10 blur-[80px] pointer-events-none" />
        
        <div className="relative z-10 flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <Badge variant={market.status === "active" ? "success" : "warning"} className="px-3 py-1 text-sm">
                {market.status}
              </Badge>
              <span className="rounded-full bg-white/5 px-3 py-1 text-xs font-semibold text-zinc-300">
                {market.category}
              </span>
              <span className="text-xs font-medium text-zinc-400">
                Ends {formatDate(market.expiry_ms)}
              </span>
            </div>
            <h1 className="max-w-4xl text-3xl font-bold tracking-tight text-white sm:text-4xl leading-tight mb-4">
              {market.title}
            </h1>
            <p className="max-w-3xl text-base leading-relaxed text-zinc-400">
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
          {!deepBookMarket && !market.id.startsWith("demo-") && (
            <div className="mb-4 rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 text-xs leading-5 text-amber-200/90">
              <p className="font-semibold text-amber-200">No DeepBook pool for this market.</p>
              <p className="mt-1 text-amber-200/70">
                Limit orders aren&apos;t routed on-chain. The order book below only
                reflects off-chain <code>chain_orders</code> rows. Use
                <span className="mx-1 rounded bg-black/30 px-1.5 py-0.5 font-mono text-[10px]">Mint YES+NO</span>
                above to take a position directly, or ask the market creator to
                deploy a DeepBook pool for live order routing.
              </p>
            </div>
          )}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {(() => {
              const bids = (book?.bids ?? []).slice(0, 8);
              const asks = (book?.asks ?? []).slice(0, 8);
              const maxBidQty = Math.max(...bids.map(l => Number(l.quantity)), 0);
              const maxAskQty = Math.max(...asks.map(l => Number(l.quantity)), 0);
              const maxVolume = Math.max(maxBidQty, maxAskQty) || 1;

              return (
                <>
                  <div className="overflow-hidden rounded-lg border border-white/10">
                    <div className="grid grid-cols-2 bg-white/[0.04] px-3 py-2 text-xs font-semibold uppercase text-zinc-500">
                      <span>Bids</span>
                      <span className="text-right">Shares</span>
                    </div>
                    {bids.map((l, idx) => (
                      <div
                        // R34 audit fix: keying on price_bps alone is
                        // unstable — multiple bids at the same price
                        // level (different sizes, different makers)
                        // produce duplicate React keys, which silently
                        // drops or mashes rows on every refetch. Add
                        // the row index and quantity to disambiguate.
                        key={`b-${l.price_bps}-${l.quantity}-${idx}`}
                        className="relative grid grid-cols-2 px-3 py-2 text-sm text-emerald-300 group z-0"
                      >
                        <div
                          className="absolute inset-y-0 right-0 bg-emerald-500/10 -z-10 transition-all group-hover:bg-emerald-500/20"
                          style={{ width: `${(Number(l.quantity) / maxVolume) * 100}%` }}
                        />
                        <span>{(l.price_bps / 100).toFixed(1)}¢</span>
                        <span className="text-right">{formatShares(l.quantity)}</span>
                      </div>
                    ))}
                    {bids.length === 0 && (
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
                    {asks.map((l, idx) => (
                      <div
                        // Same key-uniqueness fix as the bids block
                        // above. Asks can have multiple orders at the
                        // same price level; price_bps alone is not
                        // a stable React key.
                        key={`a-${l.price_bps}-${l.quantity}-${idx}`}
                        className="relative grid grid-cols-2 px-3 py-2 text-sm text-rose-300 group z-0"
                      >
                        <div
                          className="absolute inset-y-0 right-0 bg-rose-500/10 -z-10 transition-all group-hover:bg-rose-500/20"
                          style={{ width: `${(Number(l.quantity) / maxVolume) * 100}%` }}
                        />
                        <span>{(l.price_bps / 100).toFixed(1)}¢</span>
                        <span className="text-right">{formatShares(l.quantity)}</span>
                      </div>
                    ))}
                    {asks.length === 0 && (
                      <p className="px-3 py-6 text-center text-sm text-zinc-500">
                        No asks yet
                      </p>
                    )}
                  </div>
                </>
              );
            })()}
          </div>
          <div className="mt-4 grid grid-cols-3 gap-3 border-t border-white/10 pt-4">
            <Tooltip content="The current mid-price for YES shares">
              <div className="cursor-help">
                <Stat label="Mid YES" value={formatCents(yesMid)} />
              </div>
            </Tooltip>
            <Tooltip content="The complement price calculated from the YES order book (100¢ - Mid YES)">
              <div className="cursor-help">
                <Stat label="Implied NO" value={formatCents(impliedNo)} />
              </div>
            </Tooltip>
            <Tooltip content="The gap between the lowest ask and highest bid">
              <div className="cursor-help">
                <Stat label="Spread" value={`${book?.spread_bps ?? 0} bps`} />
              </div>
            </Tooltip>
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
            // R40 audit fix: route through clampNumberString so a
            // paste of "1.2.3" or "abc" doesn't silently land as
            // 0.5 (the NaN fallback of clampProbability(Number(...))).
            // R39 fixed the same class of bug for qty/deposit; the
            // price input was the only survivor.
            onChange={(e) => setPrice(clampNumberString(e.target.value, 0.5, 0.01, 0.99))}
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
            // R38 audit fix: route through clampNumberString so a
            // paste of "1.2.3", "abc", or "1e9" can't land in state
            // as `NaN` — the downstream BigInt(Math.round(...))
            // would then TypeError in the render path, leaving
            // the user with a stuck "Submitting..." spinner and
            // no error toast.
            onChange={(e) => setQty(clampNumberString(e.target.value, 0.01, 0.01, 1_000_000))}
            className="mb-4 w-full rounded-md border border-white/10 bg-black/20 px-3 py-3 text-white outline-none transition focus:border-emerald-400/70"
          />
          <div className="mb-4 rounded-lg border border-white/10 bg-black/20 p-3 text-sm">
            <div className="flex justify-between gap-3 text-zinc-400">
              <span>Est. cost</span>
              <span className="font-medium text-white">
                ${estimatedCost.toFixed(2)} DUSDC
              </span>
            </div>
            <div className="mt-2 flex justify-between gap-3 text-zinc-400">
              <Tooltip content="The total DUSDC balance needed to place this order">
                <span className="cursor-help underline decoration-white/20 underline-offset-4">Capital needed</span>
              </Tooltip>
              <span className="font-medium text-white">
                ${capitalRequired.toFixed(2)} DUSDC
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
              Order route: {routeLabel}. NO orders use the 1 - YES complement on
              the same YES book.
            </p>
          </div>
          <button
            type="button"
            disabled={
              busy === "placeOrder" ||
              !account ||
              (!useDeepBookRoute && market.id.startsWith("demo-"))
            }
            onClick={placeOrder}
            className={`min-h-12 w-full rounded-lg text-sm font-semibold text-white shadow-lg transition-all hover:scale-[1.02] disabled:cursor-not-allowed disabled:opacity-50 disabled:scale-100 ${
              orderSide === "buy"
                ? "bg-gradient-to-r from-emerald-500 to-teal-400 shadow-emerald-900/30 hover:shadow-emerald-900/50"
                : "bg-gradient-to-r from-rose-500 to-orange-400 shadow-rose-900/30 hover:shadow-rose-900/50"
            }`}
          >
            {actionLabel}
          </button>
          {market.id.startsWith("demo-") && (
            <p className="mt-3 text-xs leading-5 text-amber-300/90">
              Demo market — configure a DeepBook pool below or deploy contracts and set
              MARKET_REGISTRY_ID for local on-chain orders.
            </p>
          )}
        </Card>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card title="DeepBook V3 Account">
          <div className="space-y-4 mt-2">
            {!balanceManagerId ? (
              <div className="rounded-lg border border-white/10 bg-black/20 p-5 text-center">
                <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-cyan-500/10 text-cyan-400">
                  <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
                  </svg>
                </div>
                <h3 className="mb-1 font-medium text-white">No Trading Account</h3>
                <p className="mb-4 text-xs leading-5 text-zinc-400">
                  You need a DeepBook BalanceManager to trade. Click below to create one instantly.
                </p>
                <button
                  type="button"
                  disabled={
                    busy === "createBalanceManager" ||
                    !account ||
                    !deepBookMarket
                  }
                  onClick={createBalanceManager}
                  className="min-h-11 w-full rounded-lg bg-gradient-to-r from-violet-600 to-cyan-600 px-4 text-sm font-semibold text-white shadow-lg shadow-cyan-900/30 transition-all hover:scale-[1.02] hover:shadow-cyan-900/50 disabled:opacity-50 disabled:scale-100"
                >
                  Setup Trading Account
                </button>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="flex items-center justify-between rounded-lg border border-emerald-500/20 bg-emerald-500/10 p-3">
                  <div className="flex items-center gap-2">
                    <div className="h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.8)]" />
                    <span className="text-sm font-medium text-emerald-300">Account Ready</span>
                  </div>
                  <span className="text-xs font-mono text-zinc-500">{balanceManagerId.slice(0, 8)}...{balanceManagerId.slice(-4)}</span>
                </div>
                
                <div className="space-y-2">
                  <label className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Deposit Funds</label>
                  <div className="grid grid-cols-[1fr_100px] gap-2">
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={depositAmount}
                      // R38 audit fix: regex-bounded parse so a
                      // paste of "abc" can't leave depositAmount in
                      // a NaN state and silently submit a 0-coin
                      // deposit (which the chain rejects with
                      // EZeroAmount — confusing for the user
                      // because the input still shows the typed
                      // text but the deposit silently bounced).
                      onChange={(e) => setDepositAmount(clampNumberString(e.target.value, 0, 0, 1_000_000))}
                      className="rounded-lg border border-white/10 bg-black/20 px-3 py-2.5 text-sm text-white outline-none transition focus:border-cyan-500/50"
                    />
                    <select
                      value={depositAsset}
                      onChange={(e) => setDepositAsset(e.target.value as "quote" | "base")}
                      className="rounded-lg border border-white/10 bg-black/20 px-3 py-2.5 text-sm text-white outline-none transition focus:border-cyan-500/50"
                    >
                      <option value="quote">DUSDC</option>
                      <option value="base">YES</option>
                    </select>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3 pt-2">
                  <button
                    type="button"
                    disabled={
                      busy === "deposit" ||
                      !account ||
                      !deepBookMarket ||
                      !balanceManagerId
                    }
                    onClick={depositToBalanceManager}
                    className="min-h-11 rounded-lg bg-white/10 px-4 text-sm font-semibold text-white transition-all hover:bg-white/20 disabled:opacity-50 border border-white/10"
                  >
                    Deposit
                  </button>
                  <button
                    type="button"
                    disabled={
                      busy === "withdraw" ||
                      !account ||
                      !deepBookMarket ||
                      !balanceManagerId
                    }
                    onClick={withdrawSettledDeepBook}
                    className="min-h-11 rounded-lg border border-white/10 bg-black/20 px-4 text-sm font-semibold text-zinc-300 transition-all hover:bg-white/5 disabled:opacity-50"
                  >
                    Settle Funds
                  </button>
                </div>
              </div>
            )}
          </div>
        </Card>

        <Card title="Collateral">
          <p className="mb-4 text-sm leading-6 text-zinc-400">
            Split 1 DUSDC → 1 YES + 1 NO. Merge pair back to DUSDC.
          </p>
          <div className="grid grid-cols-2 gap-3 mt-2">
            <button
              type="button"
              disabled={busy === "mint" || !account || market.id.startsWith("demo-")}
              onClick={splitCollateral}
              className="min-h-11 rounded-lg bg-white/10 px-4 text-sm font-semibold text-white transition-all hover:bg-white/20 disabled:opacity-50 border border-white/10"
            >
              Mint Shares (YES+NO)
            </button>
            <button
              type="button"
              disabled={busy === "merge" || !account || market.id.startsWith("demo-")}
              onClick={mergeCollateral}
              className="min-h-11 rounded-lg border border-white/10 bg-black/20 px-4 text-sm font-semibold text-zinc-300 transition-all hover:bg-white/5 disabled:opacity-50"
            >
              Sell shares
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
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  // R49 audit fix: also gate on `market.outcome`. The
                  // off-chain mirror can briefly report
                  // `status = "resolved"` before the indexer records
                  // the winning side (the `MarketResolvedEvent` and
                  // the resolution-row write are two separate
                  // transactions). Submitting a redeem in that
                  // window makes the on-chain `redeem` abort with
                  // `EMarketNotResolved`, paying gas for nothing.
                  // The sibling `redeemWinner` body (line 777-779)
                  // still throws a toast on the same condition; this
                  // gate avoids the wallet-prompt round trip
                  // entirely. The button label stays the same so
                  // the disabled state is the only signal.
                  disabled={
                    busy === "redeemWinner" ||
                    !account ||
                    market.id.startsWith("demo-") ||
                    market.outcome === null
                  }
                  onClick={redeemWinner}
                  className="w-fit rounded-md bg-emerald-400 px-5 py-2.5 text-sm font-semibold text-zinc-950 transition hover:bg-emerald-300 disabled:opacity-50"
                >
                  {streakId ? "Redeem with streak boost" : "Redeem winner"}
                </button>
                {streakId && (
                  <span className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1.5 text-xs font-semibold text-emerald-300">
                    Streak active
                  </span>
                )}
                {!market.id.startsWith("demo-") && (
                  <Link
                    href={`/dispute/${encodeURIComponent(market.id)}`}
                    className="w-fit rounded-md border border-amber-500/40 bg-amber-500/10 px-5 py-2.5 text-sm font-semibold text-amber-200 transition hover:bg-amber-500/20"
                  >
                    Dispute outcome
                  </Link>
                )}
              </div>
            )}
          </div>
        </Card>
      </div>

    </div>
  );
}
