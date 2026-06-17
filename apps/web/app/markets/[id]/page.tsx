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
  getBalanceManagerBalance,
  dollarsToDusdc,
  DUSDC_TYPE,
  QUOTE_SCALE,
  BASE_SCALE,
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
import { MarketStatusBadge } from "@/components/MarketStatusBadge";
import { submitAndWait } from "@/lib/dapp-kit";
import { toast } from "sonner";
import { Tooltip } from "@/components/Tooltip";
import { FriendPositionsWidget } from "@/components/FriendPositionsWidget";
import { FaucetButton } from "@/components/FaucetButton";
import { RecentTrades } from "@/components/RecentTrades";
import { WcTeamAnalysisCard } from "@/components/WcTeamAnalysisCard";
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
  // R58.8 audit fix: `isMoveAbortInModule` now accepts
  // `string` (not just the `MoveModule` union of our
  // own packages), so the `as Parameters<...>[1]`
  // cast for external modules (balance_manager,
  // deepbook, dusdc) is no longer needed.
  if (isMoveAbortInModule(err, "balance_manager")) {
    return `${action} failed: balance manager invariant violated (insufficient funds?).`;
  }
  if (isMoveAbortInModule(err, "deepbook")) {
    return `${action} failed: DeepBook pool rejected the order.`;
  }
  if (isMoveAbortInModule(err, "dusdc")) {
    return `${action} failed: insufficient DUSDC balance.`;
  }
  if (isMoveAbortInModule(err, "agent_policy")) {
    return `${action} failed: agent policy paused, revoked, or out of budget.`;
  }
  return `${action} failed on-chain`;
}

// R50 audit fix: was `?? "0x000…000"`. The `if (!FEE_VAULT_ID)` guards
// at lines 468 and 783 evaluated `if (!"0x000…000")` (false), so the
// "FEE_VAULT_ID is not set" toast never fired — the PTB submitted
// with the zero vault and the on-chain abort was opaque. `app/admin/
// page.tsx:81` already uses the `?? ""` pattern. Mirror that.
const FEE_VAULT_ID = process.env.NEXT_PUBLIC_FEE_VAULT_ID ?? "";

/**
 * R61 audit fix: validated SUI_NETWORK for the
 * SuiVision deep-link. Mirror the same allowlist
 * the /agents and admin pages use (testnet /
 * mainnet / devnet). SuiVision doesn't host a
 * localnet indexer so we fall back to testnet on
 * unknown values; a real mainnet deploy never
 * lands on the fallback because the env is
 * validated at boot.
 */
const SUI_NETWORK_FOR_EXPLORER = (() => {
  const raw = process.env.NEXT_PUBLIC_SUI_NETWORK ?? "testnet";
  return ["testnet", "mainnet", "devnet"].includes(raw) ? raw : "testnet";
})();

/**
 * R61 audit fix: dismiss-per-market localStorage
 * for the "How it works" callout. We persist the
 * set of market ids the user has dismissed so the
 * callout only ever surfaces on a market the user
 * hasn't seen it on. `try/catch` around the JSON
 * parse so a user with corrupted localStorage
 * (manual edit, or a future migration that wrote
 * malformed JSON) doesn't crash the page render
 * — the same `try/catch` pattern the
 * `StreakWelcomeBanner` uses.
 */
const HOW_IT_WORKS_KEY = "suipredict.howItWorks.dismissed";
function readHowItWorksDismissed(marketId: string): boolean {
  if (typeof window === "undefined") return false;
  const raw = window.localStorage.getItem(HOW_IT_WORKS_KEY);
  if (!raw) return false;
  try {
    const list = JSON.parse(raw) as string[];
    return Array.isArray(list) && list.includes(marketId);
  } catch {
    return false;
  }
}
function dismissHowItWorks(marketId: string): void {
  if (typeof window === "undefined") return;
  let list: string[] = [];
  try {
    const raw = window.localStorage.getItem(HOW_IT_WORKS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) list = parsed as string[];
    }
  } catch {
    /* overwrite below */
  }
  if (!list.includes(marketId)) list.push(marketId);
  // Cap the set to the most recent 50 entries so a
  // power user visiting hundreds of markets doesn't
  // blow the localStorage budget. Older entries drop
  // off the front; they're free to be re-dismissed.
  if (list.length > 50) list = list.slice(-50);
  try {
    window.localStorage.setItem(HOW_IT_WORKS_KEY, JSON.stringify(list));
  } catch {
    /* quota exceeded — non-critical */
  }
}

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

/**
 * R32 sweep fix: relative time helper
 * for WC market kickoff. A user landing
 * on a market page mid-tournament needs
 * the relative "in 2h" / "in 3d" label
 * to gauge urgency at a glance. The
 * absolute date is also rendered (the
 * `formatDate` call) so the user has both
 * signals. The threshold table mirrors
 * the WC dashboard's `kickoffIn` helper.
 */
function formatRelativeMs(ms: number): string {
  const diff = ms - Date.now();
  if (diff <= 0) {
    // Past — distinguish "live now"
    // (within 2h of kickoff) from
    // "started earlier".
    const pastDiff = -diff;
    if (pastDiff < 2 * 60 * 60 * 1000) return "live now";
    const hours = Math.floor(pastDiff / 3_600_000);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `in ${hours}h`;
  const days = Math.floor(hours / 24);
  return `in ${days}d`;
}

export default function MarketDetailPage() {
  const { id } = useParams<{ id: string }>();
  // R61 audit fix: read the deep-link params
  // (`?side=yes|no&order=buy|sell`) from the search
  // string so the DailyWcCard's 1-tap YES/NO buttons
  // (and the FriendPositionsWidget's "Copy …" CTA)
  // land on the trade panel with the side pre-selected
  // instead of forcing the user to re-tap. Unknown
  // values fall back to the default ("yes" / "buy")
  // so a future query param (e.g. `?qty=`) doesn't
  // 500 the page.
  const search =
    typeof window !== "undefined" ? window.location.search : "";
  const params = new URLSearchParams(search);
  const sideParam = params.get("side");
  const orderParam = params.get("order");
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
  return (
    <MarketDetailBody
      marketId={marketId}
      initialSide={
        sideParam === "yes" || sideParam === "no" ? sideParam : undefined
      }
      initialOrder={
        orderParam === "buy" || orderParam === "sell" ? orderParam : undefined
      }
    />
  );
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

function MarketDetailBody({
  marketId,
  // R61 audit fix: deep-link initial state. The
  // DailyWcCard's YES/NO buttons and the
  // FriendPositionsWidget's "Copy their bet" CTA
  // both link to `/markets/${id}?side=...&order=...`;
  // passing those values down to the body lets us
  // skip the default "yes" / "buy" state and land
  // the user directly on the trade panel with the
  // side pre-selected. `undefined` means "use the
  // default" so the rest of the existing call sites
  // (and tests) keep their current behaviour.
  initialSide,
  initialOrder,
}: {
  marketId: string;
  initialSide?: "yes" | "no";
  initialOrder?: "buy" | "sell";
}) {
  const account = useCurrentAccount();
  const client = useCurrentClient();
  const dAppKit = useDAppKit();
  const { streakId } = useUserStreakId(account?.address);


  const [market, setMarket] = useState<MarketInfo | null>(null);
  const [book, setBook] = useState<OrderBookSnapshot | null>(null);
  const [side, setSide] = useState<"yes" | "no">(initialSide ?? "yes");
  const [orderSide, setOrderSide] = useState<"buy" | "sell">(initialOrder ?? "buy");
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
  // R62 audit fix: track the actual
  // timestamp of the last order-book
  // fetch so the "Last refreshed"
  // indicator can show a real time
  // string (not `Date.now()` which
  // would always show the current
  // time and be useless as a
  // freshness signal). Set on every
  // `refresh()` call and on the
  // manual ↻ Refresh button click.
  const [lastBookRefreshMs, setLastBookRefreshMs] = useState<number>(Date.now());
  // through a "mounted" state. Before mount, the
  // state is `null` (the SSR / first-render default)
  // and the conditional below short-circuits to false
  // (no hint). After mount, we read localStorage
  // and either show the hint (never dismissed) or
  // hide it (previously dismissed). This avoids the
  // pre-R61 brief flash where the server rendered
  // the hint and the client hid it ~16ms later, which
  // looked like a layout jitter to returning users.
  const [howItWorksMounted, setHowItWorksMounted] = useState(false);
  const [howItWorksDismissed, setHowItWorksDismissed] = useState(false);
  useEffect(() => {
    setHowItWorksMounted(true);
    setHowItWorksDismissed(readHowItWorksDismissed(marketId));
  }, [marketId]);

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
    // R56.12 audit fix: also invalidate this market's
    // order-book key. The local `refresh()` + `setRefreshCounter`
    // work around this for the current page, but a future
    // refactor that caches the order book in React Query would
    // hit a stale "no order yet" view for the hook's
    // `staleTime` after a successful placeOrder. Cheap to
    // add now and stops the foot-gun.
    void queryClient.invalidateQueries({
      queryKey: ["marketOrderBook", marketId],
      type: "active",
    });
  }, [queryClient, account?.address, marketId]);
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
    // R62 audit fix: mark the start of
    // a fresh fetch so the "Last
    // refreshed" indicator updates
    // for the manual ↻ Refresh click
    // as well as the 4s polling tick.
    // The timestamp is set at the
    // *start* of the fetch (not on
    // success) so the indicator
    // shows "Updated now" even
    // while the order-book read is
    // in flight — the user knows
    // the click landed and the
    // numbers will refresh in a
    // moment. On fetch failure the
    // timestamp stays put (so the
    // user sees a stale "Updated
    // 1m ago" rather than a
    // misleading "Updated now"
    // that suggests data that's
    // not there).
    setLastBookRefreshMs(Date.now());
    let m: MarketInfo;
    try {
      // R55 audit fix: normalize the market id before
      // fetching. The Sui URL decode above (`decodeURIComponent`)
      // can produce a mixed-case hex string for Enoki zkLogin
      // sessions or a user-pasted market id, and
      // `getMarket` round-trips to the agents REST
      // endpoint which is case-sensitive on the wire —
      // a mixed-case id would 404 even though the
      // canonical lowercase id exists. The same
      // pattern is already in use for `listCoins`
      // (line 100) and `getPortfolio` (line 387).
      //
      // R58.H6 audit fix: only normalize if the id
      // actually looks like a Sui object id (0x + 64
      // hex chars). `normalizeObjectId` throws on
      // anything that doesn't match the regex, and the
      // throw message ("not a valid Sui object id
      // (expected 0x + 64 hex chars)") doesn't include
      // "404" or "not found", so the page's error
      // classifier below was labelling it as
      // `fetch_failed` ("agents indexer is unreachable")
      // even though the agents service was up and
      // serving the row. Demo seed ids like
      // `wc26-K1v4` use a different namespace
      // (`isValidMarketId` in the SDK is permissive on
      // shape but strict on safety) so they pass
      // through unchanged. Without this guard, every
      // wc26-* page errored out at the load step.
      const isLikelySuiId = /^0x[0-9a-fA-F]{64}$/.test(marketId);
      m = await getMarket(isLikelySuiId ? normalizeObjectId(marketId) : marketId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // R58 audit fix: classify the error so the UI doesn't
      // tell the user "agents indexer is unreachable" when
      // the actual cause is a 404. The previous logic
      // only matched on the literal "404" string, so an
      // SDK throw like "getMarket: id must be a 32-byte
      // hex Sui object id (got \"wc26-J1v3\")" was
      // misclassified as a transport failure. The new
      // heuristic treats any error whose name + message
      // both look like a 404-style "not found" as
      // not_found; everything else (network down, 5xx,
      // timeout) is fetch_failed.
      const is404 = msg.includes("404") || /not[-_ ]?found/i.test(msg);
      const kind: "not_found" | "fetch_failed" = is404
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

  // Listen for `faucet-mint` window events from the
  // FaucetButton so a successful faucet hit re-fetches the
  // user's portfolio + bumps the order-book refresh. Without
  // this, the user would have to manually click ↻ Refresh
  // (or wait for the 4s polling tick) to see their new
  // DUSDC balance in the trade panel. The pattern mirrors
  // the existing `open-connect-modal` event bus.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onFaucetMint = (e: Event) => {
      const detail = (e as CustomEvent).detail as
        | { recipient?: string }
        | undefined;
      // No-op if the mint wasn't for this user (e.g. a
      // developer testing both ConnectModal wallets from
      // the same browser).
      if (
        detail?.recipient &&
        account?.address &&
        detail.recipient.toLowerCase() !== account.address.toLowerCase()
      ) {
        return;
      }
      setRefreshCounter((c) => c + 1);
    };
    window.addEventListener("faucet-mint", onFaucetMint);
    return () => window.removeEventListener("faucet-mint", onFaucetMint);
  }, [account?.address]);

  useEffect(() => {
    if (!account) return;
    const key = `suipredict.deepbook.${account.address}`;
    setBalanceManagerId(window.localStorage.getItem(`${key}.manager`) ?? "");
    setTradeCapId(window.localStorage.getItem(`${key}.tradeCap`) ?? "");
  }, [account]);

  useEffect(() => {
    if (!account) return;
    const key = `suipredict.deepbook.${account.address}`;
    // R57.M1 audit fix: try/catch the
    // `localStorage` write. Safari
    // private mode, Brave strict mode,
    // and any iframe with
    // `allow-same-origin` removed throw
    // `QuotaExceededError` synchronously
    // and tear down the surrounding
    // `useEffect` chain. Other
    // wallet-scoped persistence paths
    // (auth/page.tsx, providers-inner.tsx)
    // already wrap the write.
    try {
      if (balanceManagerId) window.localStorage.setItem(`${key}.manager`, balanceManagerId);
      else window.localStorage.removeItem(`${key}.manager`);
    } catch (e) {
      console.warn(
        `[markets/${marketId}] localStorage write for manager failed:`,
        e instanceof Error ? e.message : e,
      );
    }
    // `marketId` is intentionally not a dep — this
    // effect persists the *account's* deepbook
    // state, not the per-market state, and we
    // don't want to re-write localStorage on every
    // market navigation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account, balanceManagerId]);

  useEffect(() => {
    if (!account) return;
    const key = `suipredict.deepbook.${account.address}`;
    try {
      if (tradeCapId) window.localStorage.setItem(`${key}.tradeCap`, tradeCapId);
      else window.localStorage.removeItem(`${key}.tradeCap`);
    } catch (e) {
      console.warn(
        `[markets/${marketId}] localStorage write for tradeCap failed:`,
        e instanceof Error ? e.message : e,
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
  //
  // R57.M2 audit fix: gate the `setRefreshCounter` on a
  // one-shot "initialized" ref. The previous code bumped
  // the counter on every re-run, and `deepBookMarket` is a
  // fresh `useMemo` result on the first render (null) → the
  // second render (defined) — two re-runs, two
  // `setRefreshCounter(c => c + 1)` calls, two redundant
  // `refreshBookAndOrders` invocations. The first call is
  // intentional; the second is a regression.
  const deepBookMarketInitializedRef = useRef(false);
  useEffect(() => {
    deepBookMarketRef.current = deepBookMarket;
    if (deepBookMarket && !deepBookMarketInitializedRef.current) {
      deepBookMarketInitializedRef.current = true;
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
    // R33 sweep fix: refuse to mint on a
    // resolved market. The on-chain
    // `mint_shares` is permissionless and
    // would succeed even on a resolved
    // market (the user would hold YES/NO
    // shares that can never settle), but
    // that's a footgun: a user who mints
    // "Will Brazil beat Scotland?" on a
    // match that's already been decided
    // wastes gas + clutter the UI with a
    // $0 position. The friendly
    // pre-flight rejects the request
    // before the wallet-adapter spinner
    // starts.
    if (market.status !== "active") {
      toast.error(
        market.status === "resolved"
          ? "This market is already resolved. New shares cannot be minted — redeem your position instead."
          : `This market is ${market.status} and cannot accept new shares.`,
      );
      return;
    }
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
        // R61 audit fix: clearer error + actionable
        // link. The previous message pointed at the
        // "DeepBook testnet form" which is an
        // operator-side flow (only useful when the
        // agent's DUSDC TreasuryCap is configured).
        // A regular end-user with no DUSDC needs to
        // either (a) mint some on a Sui faucet, or
        // (b) ask the protocol's faucet address.
        // The toast catches the throw and renders
        // a single line, so the message has to
        // be self-contained. The link to the Sui
        // testnet faucet is the actionable item
        // — the parent `toast.error(...)` block
        // (line ~734) renders the string verbatim.
        //
        // R63 audit fix: surface the self-hosted
        // DUSDC faucet in the error toast. The
        // Sui testnet faucet (faucet.sui.io) only
        // mints SUI for gas, not the protocol's
        // DUSDC — a user who clicks that link would
        // land on a SUI balance, come back, and
        // see the same "no DUSDC" error. The
        // self-hosted faucet (the "Faucet 100 DUSDC"
        // compact button in this Collateral card,
        // or the "Get 100 DUSDC" CTA in the
        // ConnectModal) mints from the protocol's
        // TreasuryCap and is the actual fix.
        //
        // R63 audit fix: drop the
        // `open-connect-modal` dispatch here. The
        // "Mint Shares" button is `!account`-disabled
        // (line ~2527), so this code only fires
        // when the user is already connected and
        // has zero DUSDC. Opening the ConnectModal
        // at that point is a no-op (the user is
        // already connected) and just adds visual
        // noise. The compact FaucetButton in this
        // same Collateral card is the actionable
        // surface — the user can click it directly
        // without bouncing through the modal.
        throw new Error(
          "You don't have any DUSDC yet. Click \"Faucet 100 DUSDC\" below to mint from the protocol faucet. (The Sui testnet faucet only mints SUI for gas, not DUSDC.)",
        );
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
      //
      // R-UAT-23 follow-up: guard the
      // on-chain market id before calling the
      // SDK builder. The button is now
      // disabled when `onchain_market_id` is
      // empty (R-UAT-23 follow-up in the JSX
      // below), but a programmatic caller
      // (e.g. a clipboard-pasted URL to a
      // SQLite-mirror WC row) would still hit
      // the raw
      // `normalizeObjectId("wc26-A1v4")` throw
      // deep in the SDK. Pre-flight the value
      // here and surface a clear toast so the
      // error reaches the user as a friendly
      // message rather than a stack trace.
      const onchainMarketId = market.onchain_market_id;
      if (!onchainMarketId) {
        throw new Error(
          `This market has no on-chain market id (it is a SQLite-mirror demo row with id "${market.id}"). ` +
            "Minting requires a published on-chain market; the world-cup-creator agent has not yet published one. " +
            "Try a different market or wait for the next on-chain publish cycle.",
        );
      }
      const tx = buildMintSharesTx(
        // R60 audit fix: use the on-chain marketId
        // (the SQLite primary key is the `wc26-<matchId>`
        // form, which would abort the on-chain
        // `mint_shares` call).
        onchainMarketId,
        FEE_VAULT_ID,
        coin.objectId,
        amountAtoms,
      );
      // R55 audit fix: route through `submitAndWait` so
      // the `setRefreshCounter` + `invalidateMarketCaches`
      // refetches hit a node that has already finalized
      // the mint. The previous signAndExecuteTransaction
      // returned immediately after signing; the React
      // Query refetch raced on-chain finalization and
      // the user saw a stale "0 YES, 0 NO" position
      // card for ~1-2s.
      const r = await submitAndWait(dAppKit, client, tx);
      // R38 audit fix: same R30/R32/R37 pattern. The previous
      // `txDigest(r)` helper returns the literal "unknown" on a
      // Failed/EffectsCert result and the success toast fired
      // anyway, lying to the user that a mint succeeded.
      if (r.$kind !== "Transaction") {
        toast.error(friendlyMoveError(r.error, "Mint"), { id: toastId });
        return;
      }
      if (!r.digest) {
        toast.error(friendlyMoveError(undefined, "Mint"), { id: toastId });
        return;
      }
      toast.success(`Minted YES + NO: ${r.digest.slice(0, 16)}…`, { id: toastId });
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
    // NO separately on the DeepBook order book. Scroll the user down to
    // the dedicated "Trade" card (id="trade-card") with side pre-
    // selected to "sell YES" and "sell NO" so the order ticket is ready
    // to go. The scrollIntoView target is the actual <Card id="trade-card">
    // added in R62 — the previous code referenced a non-existent
    // `trade-card` id and silently no-op'd the scroll.
    const tradeCard = document.getElementById("trade-card");
    if (tradeCard) {
      // R62 audit fix: also flip the trade
      // ticket to "Sell YES" so the user is
      // one click away from the actual exit
      // flow, not staring at a Buy ticket
      // they have to manually re-configure.
      setSide("yes");
      setOrderSide("sell");
      tradeCard.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  async function placeOrder() {
    if (!account || !client || !market) return;
    // R33 sweep fix: refuse to place
    // orders on a non-active market.
    // The on-chain `place_order` would
    // happily submit an order on a
    // resolved market (the order sits
    // on the book forever, the user
    // holds a position that can never
    // settle). Same rationale as the
    // mint pre-flight above.
    if (market.status !== "active") {
      toast.error(
        market.status === "resolved"
          ? "This market is already resolved. No new orders can be placed — redeem your existing position instead."
          : `This market is ${market.status} and cannot accept new orders.`,
      );
      return;
    }
    if (!useDeepBookRoute) {
      toast.error(
        "Limit orders for this market require a DeepBook pool. Use 'Mint Shares' to mint YES+NO, then sell on the DeepBook order book.",
      );
      return;
    }
    if (!deepBookMarket) return;
    setBusy("placeOrder");
    // R56.18 audit fix: millisecond-granularity `Date.now()`
    // collisions are unlikely but possible (a programmatic
    // submit, or two tabs the same user opens for the same
    // market). Append a 6-digit random suffix so the
    // on-chain `client_order_id` is unique even for
    // back-to-back submits in the same millisecond. The
    // `chain_orders` de-duplication in the indexer would
    // otherwise attribute the second order to the first.
    //
    // R-WC-1.5 fix: pre-fix, the id was a string of the
    // form `${Date.now()}-${randomBase36}` (e.g.
    // `1781688021595-dtf6z5`). The DeepBook SDK then
    // passed this string to `tx.pure.u64(...)` which
    // internally calls `BigInt(string)` — but `BigInt`
    // rejects non-numeric characters and threw the
    // cryptic "Cannot convert 1781688021595-dtf6z5 to a
    // BigInt" error inside the wallet spinner. The fix
    // is to keep the id a numeric-only BigInt: use the
    // timestamp (ms since epoch, ~13 digits) for the
    // high 41 bits and a 23-bit random counter for the
    // low bits. Both are well within `u64`'s 19-digit
    // range, and back-to-back submits always get
    // distinct ids.
    const clientOrderId =
      (BigInt(Date.now()) << BigInt(23)) |
      BigInt(Math.floor(Math.random() * 0x7fffff));
    const toastId = toast.loading("Submitting DeepBook V3 limit order...");
    try {
      // R55 audit fix: pre-flight DUSDC balance for a
      // buy order. A user with insufficient DUSDC
      // would otherwise spin up the wallet-adapter
      // spinner, the PTB would abort inside the
      // wallet, and the user would see a generic
      // "Order failed on-chain" toast — the actual
      // reason (insufficient DUSDC) is only visible
      // if they open the dev tools. Mirror the
      // DailyPredictionCard pre-flight (lines 158-168)
      // and the parlay/page pre-flight (lines 311-320).
      // Sell orders spend a YES/NO coin, not DUSDC, so
      // the pre-flight is gated on `isBid`.
      if (isBid && account) {
        const { objects } = await client.core.listCoins({
          owner: normalizeObjectId(account.address),
          coinType: DUSDC_TYPE,
          limit: 100,
        });
        const totalBalance = objects.reduce(
          (acc, c) => acc + BigInt(c.balance),
          BigInt(0),
        );
        // `qty` is in YES base units; `yesLimitPrice` is
        // the per-share DUSDC cost (both scaled 1e6). The
        // order total is qty * yesLimitPrice / 1e6 in
        // base units. A 5% buffer keeps the user from
        // hitting a 1-atom shortfall on a rounding edge
        // (DeepBook's balance-manager invariant is
        // strict).
        const requiredAtoms =
          (BigInt(qty) * BigInt(Math.round(yesLimitPrice * 1_000_000))) /
          BigInt(1_000_000);
        const requiredWithBuffer = (requiredAtoms * BigInt(105)) / BigInt(100);
        if (totalBalance < requiredWithBuffer) {
          throw new Error(
            `Insufficient DUSDC: need ~${(Number(requiredAtoms) / 1_000_000).toFixed(2)} ` +
              `(${(Number(requiredWithBuffer) / 1_000_000).toFixed(2)} with buffer), ` +
              `have ${(Number(totalBalance) / 1_000_000).toFixed(2)}. Request more from the DeepBook testnet form.`,
          );
        }
        // R-WC-1.8 fix: also read the on-chain
        // BalanceManager balance. A user with DUSDC
        // in their WALLET but nothing deposited in
        // the BM would pass the wallet check above
        // and then see the cryptic
        // `MoveAbort in balance_manager::withdraw_with_proof
        //  abort code 3 (EBalanceManagerBalanceTooLow)`
        // inside the wallet spinner. The dryRun
        // here is a view-only call (no PTB is
        // submitted); the SDK's `getBalanceManagerBalance`
        // builds a single moveCall and reads back
        // the u64 return value.
        const bmBalance = await getBalanceManagerBalance(
          client,
          balanceManagerId,
          DUSDC_TYPE,
        );
        if (bmBalance < requiredWithBuffer) {
          const needDeposit = requiredWithBuffer - bmBalance;
          throw new Error(
            `Insufficient DUSDC in your Trading Account: ` +
              `have ${(Number(bmBalance) / 1_000_000).toFixed(2)}, need ~` +
              `${(Number(requiredAtoms) / 1_000_000).toFixed(2)} ` +
              `(${(Number(requiredWithBuffer) / 1_000_000).toFixed(2)} with buffer). ` +
              `Deposit ~${(Number(needDeposit) / 1_000_000).toFixed(2)} DUSDC into your Trading Account first ` +
              `(use the "Deposit" button below).`,
          );
        }
      }
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
        // R60 audit fix: `market.id` is the
        // SQLite primary key (the `wc26-<matchId>`
        // form for WC markets), NOT the on-chain
        // marketId. The on-chain PTB aborts with
        // `MoveAbort` if it receives a non-`0x…`
        // id. Use `onchain_market_id` when set;
        // fall back to `market.id` for non-WC
        // markets (where the two are the same).
        marketId: market.onchain_market_id ?? market.id,
        poolId: deepBookMarket.poolId,
        balanceManagerId,
        clientOrderId, // already a bigint (R-WC-1.5 fix)
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
        // `qty` is the YES share count as a number.
        // The `buildPlaceOrderTx` wrapper expects
        // the raw on-chain value (1 share = 1e6
        // atoms for the 6-decimal YES coin). Pre-fix
        // the page passed `BigInt(qty)` directly —
        // for qty=1, the on-chain value was 1 atom,
        // way below the pool's `min_size = 1e6`
        // (EOrderBelowMinimumSize, abort code 1).
        // Scale by `BASE_SCALE` (= 1e6) to convert
        // share count → atom count. `BASE_SCALE`
        // lives in the SDK barrel so we don't
        // hardcode 1e6 in three places.
        quantity: BigInt(qty) * BASE_SCALE,
        isBid,
      });
      // R55 audit fix: route through `submitAndWait` so
      // the `waitForOrderInBook` poll runs against a node
      // that has already finalized the order tx. The
      // previous signAndExecuteTransaction returned
      // immediately after signing; the indexer poll would
      // race on-chain finalization and a slow RPC could
      // spend the full 65s timeout looking for an order
      // the chain had accepted but not yet broadcast.
      const r = await submitAndWait(dAppKit, client, tx);
      // R38 audit fix: dAppKit can return Failed/EffectsCert here
      // (insufficient gas, paused pool, balance-mgr invariant). On
      // those paths `txDigest(r)` returns the literal string
      // "unknown" — toast.loading would then poll an indexer endpoint
      // for 65s with no real digest to match, hammering the agents
      // service for no reason. Surface the error early and skip the
      // indexer poll.
      if (r.$kind !== "Transaction") {
        toast.error(friendlyMoveError(r.error, "Order"), { id: toastId });
        return;
      }
      if (!r.digest) {
        toast.error(friendlyMoveError(undefined, "Order"), { id: toastId });
        return;
      }
      const digest = r.digest;
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
        // R-WC-1.5 fix: clientOrderId is now a bigint
        // (was a string like "1781688021595-dtf6z5" but
        // the BigInt() conversion inside the wallet
        // adapter rejected the hyphen). Convert to
        // string for the waitForOrderInBook comparison
        // (the on-chain chain_orders.client_order_id is
        // stored as a number; the bigint->string
        // conversion is lossless for values that fit in
        // u64, which our ms-timestamp + 23-bit-counter
        // scheme always does).
        clientOrderId.toString(),
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
   * Wait until the tab is visible OR the caller's `signal` aborts.
   * Resolves immediately if the tab is already visible. Used by
   * `waitForOrderInBook` to gate the poll loop on tab visibility
   * without leaking a `visibilitychange` listener when the outer
   * poll aborts first (R57.H1 audit fix).
   */
  function waitForVisibleOrAbort(signal?: AbortSignal): Promise<void> {
    if (typeof document === "undefined" || document.visibilityState === "visible") {
      return Promise.resolve();
    }
    if (signal?.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const onVis = () => {
        if (document.visibilityState === "visible") {
          document.removeEventListener("visibilitychange", onVis);
          signal?.removeEventListener("abort", onAbort);
          resolve();
        }
      };
      const onAbort = () => {
        document.removeEventListener("visibilitychange", onVis);
        signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      document.addEventListener("visibilitychange", onVis);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
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
      // R56.13 audit fix: pause the poll loop while the tab
      // is hidden. A user who mints and immediately
      // switches tabs for the full 65s timeout would
      // otherwise fire 43 `fetch` calls against the agents
      // service to confirm an order they can't see. The
      // 4s `setInterval` on line 362-365 was visibility-
      // gated by R42; the order-confirm poll was missed.
      //
      // R57.H1 audit fix: factor the visibility wait into a
      // helper that accepts the caller's `signal` and
      // cleans up the listener on BOTH the visibility flip
      // and the abort. The previous inline
      // `addEventListener("visibilitychange", onVis)` only
      // removed the listener on the visibility flip — if
      // the caller's `signal` aborted while the tab was
      // still hidden (e.g. parent unmount), the listener
      // piled up over a long session with several mints.
      if (
        typeof document !== "undefined" &&
        document.visibilityState !== "visible"
      ) {
        await waitForVisibleOrAbort(signal);
      }
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
      // R55 audit fix: route through `submitAndWait` so
      // the `extractCreatedObjectId` gRPC call hits a
      // node that has already finalized the create tx.
      // The previous signAndExecuteTransaction returned
      // immediately; the gRPC query for the new manager
      // id raced on-chain finalization and a slow RPC
      // would return an empty effect.
      const r = await submitAndWait(dAppKit, client, tx);
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
        toast.error(friendlyMoveError(r.error, "BalanceManager creation"), { id: toastId });
        return;
      }
      if (!r.digest) {
        toast.error(friendlyMoveError(undefined, "BalanceManager creation"), { id: toastId });
        return;
      }
      const digest = r.digest;
      // Discover the new shared BalanceManager ID from the tx effects
      // and persist it so subsequent deposit/place-order calls find it.
      const managerId = await extractCreatedObjectId(
        client,
        digest,
        "balance_manager::BalanceManager",
      );
      if (managerId) {
        setBalanceManagerId(managerId);
        // R58.H2 audit fix: wrap the
        // `localStorage.setItem` in a try/catch.
        // Safari private mode, browsers with
        // storage quotas exhausted, and
        // cookie-blocking enterprise policies
        // all throw `QuotaExceededError` on
        // write. The previous unguarded call
        // would propagate the throw up to
        // `submitAndWait`'s outer try/catch and
        // toast a generic "createBalanceManager
        // failed" — even though the on-chain
        // tx had succeeded. Log the error so
        // the user can see why the manager id
        // doesn't persist across reloads.
        try {
          window.localStorage.setItem(
            `suipredict.deepbook.${account.address}.manager`,
            managerId,
          );
        } catch (e) {
          console.warn(
            "[markets/id] localStorage.setItem for BalanceManager failed:",
            e instanceof Error ? e.message : e,
          );
          toast.warning(
            "BalanceManager created, but couldn't be cached locally. You'll need to recreate it next session.",
          );
        }
        toast.success(
          `BalanceManager created: ${digest.slice(0, 16)}...`, { id: toastId }
        );
      } else {
        // R57.H2 audit fix: surface the post-success silent
        // failure. The Transaction-kind result confirmed the
        // tx finalized, but the gRPC `objectTypes` query for
        // the new shared object came back without the
        // `BalanceManager` struct (RPC lag, indexer
        // propagation, etc). The Deposit / Place Order
        // buttons disable on `!balanceManagerId` and the
        // user has no clue why the success toast didn't
        // unlock them. Toast a distinct warning so the
        // operator knows to refresh in a few seconds.
        toast.warning(
          `BalanceManager created (${digest.slice(0, 16)}...) but the new object ID ` +
            "isn't visible to this RPC node yet. Click 'Refresh manager' in a few seconds " +
            "or reload the page.",
          { id: toastId },
        );
      }
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
    // R54 audit fix: pre-flight check the user's DUSDC balance
    // against `depositAmount`. The previous code submitted the
    // PTB without a balance check; a user with insufficient
    // DUSDC would pay gas for a tx that aborts on-chain with
    // `EInsufficientBalance`. The sibling `splitCollateral`
    // (line 538) already does this — extend the pattern to
    // deposit.
    try {
      const { objects } = await client.core.listCoins({
        owner: normalizeObjectId(account.address),
        coinType: DUSDC_TYPE,
        limit: 100,
      });
      const total = objects.reduce((s, c) => s + BigInt(c.balance), BigInt(0));
      const need = BigInt(Math.round(depositAmount * 1_000_000));
      if (total < need) {
        toast.error(
          `Insufficient DUSDC for deposit (have ${Number(total) / 1_000_000} DUSDC, need ${depositAmount} DUSDC).`,
          { id: toastId },
        );
        setBusy(null);
        return;
      }
    } catch (e) {
      // Don't block the deposit on a pre-flight RPC failure —
      // fall through to the on-chain check (which costs gas but
      // is at least definitive). The error is logged for the
      // operator.
      console.warn(
        `[markets/[id]] deposit balance pre-flight failed:`,
        e instanceof Error ? e.message : e,
      );
    }
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
      // R55 audit fix: route through `submitAndWait` so
      // the `invalidateMarketCaches()` refetch sees a
      // finalized deposit. The previous
      // signAndExecuteTransaction returned immediately;
      // the user's balance card displayed the OLD
      // deposit amount for ~1-2s after the success
      // toast.
      const r = await submitAndWait(dAppKit, client, tx);
      // R38 audit fix: $kind guard for deposit. The deposit path is
      // the one most likely to silently "succeed" with "unknown" on
      // a quota-exhausted BalanceManager (the tx would not abort
      // cleanly at the wallet layer, but the move abort would only
      // show in effects certs). Surface the error to the user
      // instead of an "Deposit OK: unknown..." toast.
      if (r.$kind !== "Transaction") {
        toast.error(friendlyMoveError(r.error, "Deposit"), { id: toastId });
        return;
      }
      if (!r.digest) {
        toast.error(friendlyMoveError(undefined, "Deposit"), { id: toastId });
        return;
      }
      toast.success(`Deposit OK: ${r.digest.slice(0, 16)}...`, { id: toastId });
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
        // R60 audit fix: see the `buildPlaceOrderTx`
        // call above. The on-chain PTB needs the
        // on-chain marketId, not the SQLite
        // primary-key form.
        market.onchain_market_id ?? market.id,
        deepBookMarket.poolId,
        balanceManagerId,
      );
      // R55 audit fix: same `submitAndWait` rationale as
      // the other markets/[id] actions. The previous
      // signAndExecuteTransaction returned before
      // finalization, so the user briefly saw their
      // OLD settled balance after the success toast.
      const r = await submitAndWait(dAppKit, client, tx);
      // R38 audit fix: $kind guard. If withdraw_settled aborted (no
      // settled amounts available) we'd previously toast
      // "Settled balances withdrawn: unknown..." — extremely
      // misleading because the leaderboard pool_weeks cursor also
      // would not advance, so the user might wait a full week
      // before noticing their `SettledEvent` was never emitted.
      if (r.$kind !== "Transaction") {
        toast.error(friendlyMoveError(r.error, "Withdraw settled"), { id: toastId });
        return;
      }
      if (!r.digest) {
        toast.error(friendlyMoveError(undefined, "Withdraw settled"), { id: toastId });
        return;
      }
      toast.success(`Settled balances withdrawn: ${r.digest.slice(0, 16)}...`, { id: toastId });
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
      // R56.1 audit fix: sort the response by `balance` and
      // pick the largest. The R52 page-size fix made this
      // bug more likely (not less): a winner with 10
      // 0.1-share fragments and one 0.5-share fragment
      // would redeem a 0.1 fragment first, abort on-chain
      // with `EInsufficientBalance` (the on-chain
      // `redeem` redeems the whole input coin), pay gas,
      // and need to retry until the largest fragment
      // happened to land first. Mirror the
      // `splitCollateral` sort at line 522-524.
      const sortedWinning = [...objects].sort((a, b) =>
        BigInt(b.balance) > BigInt(a.balance) ? 1 : -1,
      );
      const coin = sortedWinning[0];
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
      // R60 audit fix: the on-chain `redeem*` PTBs
      // need the on-chain marketId. The SQLite
      // primary-key form (`wc26-<matchId>` for WC
      // markets) would abort with `MoveAbort`. Use
      // `onchain_market_id` when set, fall back to
      // `market.id` for non-WC markets.
      const redeemMarketId = market.onchain_market_id ?? market.id;
      const tx =
        winningSide === "yes"
          ? streakId
            ? buildRedeemWithStreakTx(redeemMarketId, FEE_VAULT_ID, coin.objectId, streakId)
            : buildRedeemTx(redeemMarketId, FEE_VAULT_ID, coin.objectId)
          : streakId
            ? buildRedeemNoWithStreakTx(redeemMarketId, FEE_VAULT_ID, coin.objectId, streakId)
            : buildRedeemNoTx(redeemMarketId, FEE_VAULT_ID, coin.objectId);
      // R55 audit fix: route through `submitAndWait` so
      // the redeem confirmation reflects the on-chain
      // state. The previous signAndExecuteTransaction
      // returned immediately; the user briefly saw the
      // "Redeemed" toast but their position card still
      // showed the now-spent YES/NO coins for ~1-2s.
      const r = await submitAndWait(dAppKit, client, tx);
      // R38 audit fix: $kind guard for redeem. Redeem is the most
      // asymmetric call here — a Failed result means the user
      // burned gas and lost the streak-attached position proof,
      // but the previous code path would still toast
      // "Redeemed: unknown..." which is much worse than no toast.
      if (r.$kind !== "Transaction") {
        toast.error(friendlyMoveError(r.error, "Redeem"), { id: toastId });
        return;
      }
      if (!r.digest) {
        toast.error(friendlyMoveError(undefined, "Redeem"), { id: toastId });
        return;
      }
      toast.success(`Redeemed: ${r.digest.slice(0, 16)}…`, { id: toastId });
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
      {/* R30 sweep fix: back link with a
         left-arrow icon. The pre-R30 build
         was a bare "Back to markets" text
         link — same string used by every
         detail page (markets/[id], group,
         dispute, etc.) and easy to miss in
         the dark theme. The new link has a
         `←` icon, more breathing room, and
         a slightly larger font so the user
         can find it after drilling in from
         a friend's shared URL. */}
      <Link
        href="/markets"
        className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 -ml-2 text-sm font-medium text-zinc-400 transition hover:bg-white/5 hover:text-white"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 18l-6-6 6-6" />
        </svg>
        Back to markets
      </Link>
      {/* R61 audit fix: "Connect to trade" banner for
         unconnected users. The trade panel's buttons
         are correctly disabled when `!account`, but
         a first-time visitor scanning the page saw
         a wall of greyed-out buttons with no
         explanation. A short banner above the
         market title makes the unlock clear and links
         to the ConnectModal trigger (the header has
         its own Connect button, but the user has to
         know to look up there). Hidden on
         `streakId` / already-connected paths so it
         doesn't nag a returning user. */}
      {!account && market.status === "active" && (
        <div className="flex flex-col gap-2 rounded-2xl border border-violet-500/20 bg-gradient-to-r from-violet-500/10 to-cyan-500/5 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <span className="text-2xl">🔗</span>
            <div>
              <p className="text-sm font-bold text-white">Connect a wallet to trade</p>
              <p className="text-xs text-zinc-400">
                Mint → Trade → Redeem. All on Sui via the dApp Kit. Google zkLogin and
                Sui Wallet extensions both work.
              </p>
            </div>
          </div>
          <button
            onClick={() => {
              if (typeof window !== "undefined") {
                window.dispatchEvent(new CustomEvent("open-connect-modal"));
              }
            }}
            className="shrink-0 rounded-lg bg-gradient-to-r from-violet-600 to-cyan-600 px-4 py-2 text-xs font-bold text-white text-center hover:scale-[1.02] active:scale-95 transition"
          >
            Connect Wallet
          </button>
        </div>
      )}
      {/* R61 audit fix: 3-step "How it works" callout for
         first-time users. A user landing on a market
         detail page (often from a friend's shared URL
         or a social link) had no context for the
         three-step flow (mint → trade → redeem). The
         callout uses the same dark-glass aesthetic
         as the rest of the page, dismisses per-market
         (we don't want to nag the same user on every
         page), and re-surfaces on a different market
         id. The dismissed-set lives in localStorage
         so a returning user sees a clean page. The
         `howItWorksDismissed` state is hydrated from
         localStorage inside a useEffect (avoids a
         SSR/CSR hydration mismatch where the server
         renders the hint and the client hides it, or
         vice versa). */}
      {market.status === "active" && howItWorksMounted && !howItWorksDismissed && (
        <div className="rounded-2xl border border-cyan-500/20 bg-cyan-500/5 p-4 sm:p-5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="text-sm font-bold text-cyan-200">How this works</h3>
              <p className="mt-1 text-xs text-cyan-300/80">
                Prediction markets on Sui run in three steps. Each one is a
                single transaction you sign from your connected wallet.
              </p>
            </div>
            <button
              onClick={() => {
                dismissHowItWorks(marketId);
                setHowItWorksDismissed(true);
              }}
              aria-label="Dismiss how-it-works hint"
              className="shrink-0 rounded-md p-1 text-cyan-300/60 hover:bg-cyan-500/10 hover:text-cyan-200 transition"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" d="M6 6l12 12M6 18L18 6" />
              </svg>
            </button>
          </div>
          <ol className="mt-3 grid gap-2 text-xs sm:grid-cols-3">
            <li className="rounded-lg border border-cyan-500/15 bg-panel p-3">
              <div className="flex items-center gap-2 text-cyan-300 font-bold">
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-cyan-500/20 text-[10px]">1</span>
                Mint
              </div>
              <p className="mt-1 text-cyan-200/80">
                Convert DUSDC into matched YES + NO shares. Each
                1 DUSDC gives 1 YES + 1 NO.
              </p>
            </li>
            <li className="rounded-lg border border-cyan-500/15 bg-panel p-3">
              <div className="flex items-center gap-2 text-cyan-300 font-bold">
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-cyan-500/20 text-[10px]">2</span>
                Trade
              </div>
              <p className="mt-1 text-cyan-200/80">
                Sell the side you don&apos;t want on the CLOB, or
                buy more of the side you do.
              </p>
            </li>
            <li className="rounded-lg border border-cyan-500/15 bg-panel p-3">
              <div className="flex items-center gap-2 text-cyan-300 font-bold">
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-cyan-500/20 text-[10px]">3</span>
                Redeem
              </div>
              <p className="mt-1 text-cyan-200/80">
                After resolution, winning shares redeem 1-for-1
                into DUSDC. Losing shares are worth 0.
              </p>
            </li>
          </ol>
        </div>
      )}

      <div className="relative overflow-hidden rounded-3xl border border-white/10 bg-panel-strong p-6 sm:p-8 shadow-2xl shadow-black/40">
        {/* Background Gradients */}
        <div className="absolute -top-40 -right-40 h-[400px] w-[400px] rounded-full bg-cyan-600/10 blur-[80px] pointer-events-none" />
        <div className="absolute -bottom-40 -left-40 h-[400px] w-[400px] rounded-full bg-violet-600/10 blur-[80px] pointer-events-none" />

        <div className="relative z-10 flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <Badge variant={market.status === "active" ? "success" : "warning"} className="px-3 py-1 text-sm">
                {market.status}
              </Badge>
              {/* R32 sweep fix: prominent
                  "Winner: YES/NO" pill for
                  resolved markets. The
                  previous build only showed
                  the small `status` badge
                  ("resolved" in amber) — a
                  user with a winning position
                  had to scroll to the
                  "Your position" card to
                  see the actual winning side.
                  The new pill is bigger, the
                  side is colored (emerald for
                  YES, rose for NO) so the
                  user can read it at a
                  glance, and it sits in the
                  same row as the other
                  metadata pills. Renders
                  nothing when `outcome` is
                  null (the indexer is
                  briefly between
                  `MarketResolvedEvent` and
                  the `markets.outcome` row
                  write). */}
              {market.status === "resolved" && market.outcome && (
                <span
                  className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-bold ${
                    market.outcome === "yes"
                      ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30"
                      : "bg-rose-500/20 text-rose-300 border border-rose-500/30"
                  }`}
                >
                  <span aria-hidden="true">🏆</span>
                  Winner: {market.outcome.toUpperCase()}
                </span>
              )}
              <span className="rounded-full bg-white/5 px-3 py-1 text-xs font-semibold text-zinc-300">
                {market.category}
              </span>
              <span className="text-xs font-medium text-zinc-400">
                {/* R62 audit fix: render the
                   kickoff time (not the
                   expiry) for WC markets.
                   The markets list and home
                   page already do this — the
                   market detail page was
                   the asymmetric survivor
                   that showed "Ends
                   {kickoff + 2h}" for WC
                   markets, misleading
                   readers about when the
                   match actually starts.
                   Mirror the same pattern:
                   "Kicks {date}" for WC
                   markets with kickoff_ms,
                   "Ends {date}" for
                   everything else. The
                   `formatDate` helper
                   already includes the
                   hour+minute so the
                   kickoff time is visible. */}
                {market.category === "worldcup" && market.kickoff_ms
                  ? `Kicks ${formatDate(market.kickoff_ms)} · ${formatRelativeMs(market.kickoff_ms)}`
                  : `Ends ${formatDate(market.expiry_ms)}`}
              </span>
              <a
                href={`https://twitter.com/intent/tweet?text=${encodeURIComponent(
                  `I'm trading on "${market.title}" — beat me:`,
                )}&url=${encodeURIComponent(
                  // R57 audit fix: strip query params + hash from
                  // the shared URL. A wallet that opens a
                  // Sui-specific deep link (e.g.
                  // `?recipient=0x…&amount=…`) could otherwise
                  // leak the user's session into the X.com
                  // post. The market path is the only thing we
                  // need to share; the recipient is implied by
                  // the recipient's wallet when they open the
                  // link.
                  typeof window !== "undefined"
                    ? `${window.location.origin}${window.location.pathname}`
                    : "",
                )}&via=SuiPredict`}
                target="_blank"
                rel="noopener noreferrer"
                className="ml-auto inline-flex items-center gap-1 rounded-full bg-sky-500/20 px-3 py-1 text-xs font-semibold text-sky-300 border border-sky-500/30 hover:bg-sky-500/30"
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
                Share
              </a>
              {/* R61 audit fix: copy-link button. The X
                 share CTA is fine for users who want to
                 tweet, but the most common share action
                 is "send to a friend in Telegram / DM".
                 The X button doesn't help there. The
                 copy-link uses the modern `navigator.clipboard`
                 API (HTTPS / localhost only) and falls
                 back to a hidden-textarea + execCommand
                 path for the rare `http://` dev deploy.
                 The toast gives the user a confirmation
                 signal (no feedback → user double-clicks
                 → confused). The button is rendered
                 next to the X share so the two are
                 visually grouped under the market title. */}
              <button
                type="button"
                onClick={async () => {
                  const url =
                    typeof window !== "undefined"
                      ? `${window.location.origin}${window.location.pathname}`
                      : "";
                  if (!url) return;
                  try {
                    if (
                      typeof navigator !== "undefined" &&
                      navigator.clipboard?.writeText
                    ) {
                      await navigator.clipboard.writeText(url);
                      toast.success("Link copied to clipboard");
                      return;
                    }
                    // Fallback for non-secure contexts
                    // (http://, file://). Create a hidden
                    // textarea, select the text, exec
                    // `copy`, and remove the node.
                    const ta = document.createElement("textarea");
                    ta.value = url;
                    ta.style.position = "fixed";
                    ta.style.opacity = "0";
                    document.body.appendChild(ta);
                    ta.select();
                    const ok = document.execCommand("copy");
                    document.body.removeChild(ta);
                    if (ok) toast.success("Link copied to clipboard");
                    else toast.error("Could not copy link");
                  } catch {
                    toast.error("Could not copy link");
                  }
                }}
                aria-label="Copy market link"
                className="inline-flex items-center gap-1 rounded-full bg-white/5 px-3 py-1 text-xs font-semibold text-zinc-300 border border-white/10 hover:bg-white/10 transition"
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="9" y="9" width="11" height="11" rx="2" />
                  <path d="M5 15V5a2 2 0 0 1 2-2h10" />
                </svg>
                Copy link
              </button>
              {/* R62 audit fix: SuiVision link
                 in the header for all non-demo
                 markets (not just resolved). The
                 pre-R62 build had the link only
                 inside the "Your position" card
                 — an active-market user had to
                 scroll all the way down to
                 verify the on-chain state. The
                 link uses the same SuiVision
                 URL pattern as the resolved-state
                 link, but uses
                 `market.onchain_market_id ?? market.id`
                 so WC markets (where the SQLite
                 id is `wc26-<matchId>` and the
                 on-chain id is the Sui object id
                 of the PredictionMarket) link to
                 the correct on-chain object. */}
              {!market.id.startsWith("demo-") && (() => {
                const onchainId = market.onchain_market_id ?? market.id;
                // SuiVision indexes Sui object ids
                // (0x + 64 hex chars). The SQLite
                // primary-key form for WC markets
                // is `wc26-<matchId>` and isn't a
                // valid Sui object id; gate on the
                // strict shape so the link
                // doesn't 404 SuiVision.
                if (!/^0x[0-9a-fA-F]{64}$/.test(onchainId)) return null;
                return (
                  <a
                    href={`https://${SUI_NETWORK_FOR_EXPLORER}.suivision.xyz/object/${encodeURIComponent(onchainId)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 rounded-full bg-cyan-500/10 px-3 py-1 text-xs font-semibold text-cyan-300 border border-cyan-500/30 hover:bg-cyan-500/20 transition"
                  >
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path strokeLinecap="round" d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                      <path strokeLinecap="round" d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                    </svg>
                    SuiVision
                  </a>
                );
              })()}
            </div>
            <h1 className="max-w-4xl text-3xl font-bold tracking-tight text-white sm:text-4xl leading-tight mb-4">
              {market.title}
            </h1>
            {/* R-WC-1.2 fix: tradeable-state badge in
                the detail-page header. Same component
                the list page uses, so a user always
                sees the same status for the same
                market id. The badge sits above the
                description so a Preview market reads
                "PREVIEW · Will Brazil win?" instead of
                just "Will Brazil win?" — the user
                knows upfront that the order book below
                is off-chain. */}
            <div className="mb-3">
              <MarketStatusBadge market={market} />
            </div>
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

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)]">
        <Card title="YES order book" className="order-2 lg:order-1 lg:col-span-1">
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
              {/*
                R-WC-1.2 fix: surface the actual root
                cause for the 44 ghost WC markets.
                Pre-fix the warning just said "ask
                the market creator to deploy a pool"
                which was misleading because the
                wc-creator was already trying every
                15 min and getting `ECurrencyAlreadyExists`
                — the system constraint, not a missed
                deploy. The new copy explains:
                  1. Sui's CoinRegistry allows only one
                     Currency<YES<DUSDC>> per package.
                  2. The contract needs a per-market
                     coin type upgrade to support
                     more than one market.
                  3. Until the upgrade ships, the
                     1 tradeable WC market
                     (wc26-A1v4 today) is the only
                     one with a live pool.
                Demo-* markets keep the original
                terse warning (those rows are
                intentionally SQLite-only).
              */}
              {!market.onchain_market_id && market.id.startsWith("wc26-") && (
                <details className="mt-2 rounded border border-amber-500/20 bg-black/20 p-2 text-amber-200/80">
                  <summary className="cursor-pointer text-amber-200">
                    Why is this market a preview?
                  </summary>
                  <div className="mt-2 space-y-2 text-amber-200/80">
                    <p>
                      The Sui system <code className="text-amber-200">CoinRegistry</code>
                      (the on-chain registry that all Sui coins are registered
                      with) allows only <strong>one</strong> Currency&lt;T&gt; per
                      type T per package. The current contract uses
                      <code className="mx-1 text-amber-200">YES&lt;DUSDC&gt;</code>
                      for all WC markets, so the first market registers
                      <code className="mx-1 text-amber-200">Currency&lt;YES&lt;DUSDC&gt;&gt;</code>
                      and every subsequent market aborts with
                      <code className="mx-1 text-amber-200">ECurrencyAlreadyExists</code>.
                    </p>
                    <p>
                      <strong className="text-amber-200">Current state:</strong> only
                      the very first WC market (the <code className="text-amber-200">wc26-A1v4</code>
                      demo) has a live DeepBook pool. The other 44 ghost rows in
                      this list are SQLite-only previews — the on-chain
                      PredictionMarket has not been published.
                    </p>
                    <p>
                      <strong className="text-amber-200">Long-term fix:</strong> the
                      contract needs to be upgraded to use per-market coin types
                      (e.g. <code className="text-amber-200">YES&lt;DUSDC, MarketId&gt;</code>)
                      so each market gets its own Currency and its own DeepBook
                      pool. Until that ships, this list will always show one
                      tradeable row + 44 preview rows.
                    </p>
                    <p>
                      <strong className="text-amber-200">Manual workaround:</strong>{" "}
                      an operator can run <code className="text-amber-200">node
                      scripts/bootstrap-wc-markets.mjs</code> to deploy a single
                      new market (it will register a fresh
                      <code className="mx-1 text-amber-200">Currency&lt;…&gt;</code>
                      and a new pool, but only one — the next run will hit the
                      same limit). See <code className="text-amber-200">docs/SOP-DEPLOYMENT.md</code>
                      for the full deploy workflow.
                    </p>
                  </div>
                </details>
              )}
              {!market.onchain_market_id && !market.id.startsWith("wc26-") && !market.id.startsWith("demo-") && (
                <details className="mt-2 rounded border border-amber-500/20 bg-black/20 p-2 text-amber-200/80">
                  <summary className="cursor-pointer text-amber-200">
                    How do I create a pool?
                  </summary>
                  <div className="mt-2 space-y-2 font-mono text-[10px]">
                    <p>
                      The market row exists locally but the on-chain
                      <code className="mx-1">PredictionMarket</code>
                      object hasn&apos;t been published yet. To deploy
                      it on Sui testnet:
                    </p>
                    <pre className="overflow-x-auto rounded bg-black/40 p-2 leading-relaxed">{`cd apps/agents
node scripts/bootstrap-wc-markets.mjs`}</pre>
                    <p>
                      Cost: ~0.01 SUI per market (one PTB each). The
                      script shares the existing DeepBook
                      <code className="mx-1">YES&lt;DUSDC&gt;</code>
                      pool, so the 500 DEEP fee only applies to the
                      very first market ever deployed on this
                      registry.
                    </p>
                  </div>
                </details>
              )}
            </div>
          )}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {(() => {
              // R-WC-1.9 fix: render BOTH the YES and NO
              // order books side by side. The on-chain
              // DeepBook pool is `Pool<YES<Q>, Q>` —
              // only the YES token has its own
              // limit-order book. The NO order book
              // is the COMPLEMENT of the YES book:
              //   - YES bid @ P (willing to buy YES) ==
              //     NO offer @ (1 - P) (willing to sell
              //     NO, since YES + NO = 1 DUSDC).
              //   - YES ask @ P (willing to sell YES) ==
              //     NO bid @ (1 - P) (willing to buy
              //     NO).
              // So we derive the NO book from the YES
              // book by inverting prices and swapping
              // the bid/ask sides. Each book is shown
              // as a 2-column card (Bids | Asks) so
              // the depth visualization is consistent
              // across sides.
              const yesBids = (book?.bids ?? []).slice(0, 8);
              const yesAsks = (book?.asks ?? []).slice(0, 8);
              // YES bid @ P -> NO ask @ (1 - P);
              // sort NO asks ascending by price
              // (cheapest first, the standard ask book
              // ordering).
              const noAsks = yesBids
                .map((l) => ({
                  price_bps: 10_000 - l.price_bps,
                  quantity: l.quantity,
                }))
                .filter((l) => l.price_bps > 0)
                .sort((a, b) => a.price_bps - b.price_bps)
                .slice(0, 8);
              // YES ask @ P -> NO bid @ (1 - P);
              // sort NO bids descending by price
              // (highest first, the standard bid book
              // ordering).
              const noBids = yesAsks
                .map((l) => ({
                  price_bps: 10_000 - l.price_bps,
                  quantity: l.quantity,
                }))
                .filter((l) => l.price_bps > 0)
                .sort((a, b) => b.price_bps - a.price_bps)
                .slice(0, 8);
              // Aggregate the YES and NO quantities
              // separately so each book's bar chart
              // is scaled to its own max (not to the
              // union — the YES pool is 2x deeper
              // than the NO book in most markets).
              const maxYesQty = Math.max(
                ...yesBids.map((l) => Number(l.quantity)),
                ...yesAsks.map((l) => Number(l.quantity)),
                0,
              );
              const maxNoQty = Math.max(
                ...noBids.map((l) => Number(l.quantity)),
                ...noAsks.map((l) => Number(l.quantity)),
                0,
              );
              const maxYes = maxYesQty || 1;
              const maxNo = maxNoQty || 1;

              return (
                <>
                  <div
                    className={`overflow-hidden rounded-lg border ${
                      side === "yes"
                        ? "border-emerald-500/50"
                        : "border-white/10"
                    }`}
                  >
                    <div className="flex items-center justify-between bg-emerald-500/10 px-3 py-2 text-xs font-bold uppercase tracking-wider text-emerald-300">
                      <span>YES order book</span>
                      {side === "yes" && (
                        <span className="rounded-full bg-emerald-500/20 px-1.5 py-0.5 text-[9px]">
                          active
                        </span>
                      )}
                    </div>
                    <div className="grid grid-cols-2 border-b border-white/10 bg-white/[0.04] px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                      <span>Bids</span>
                      <span className="text-right">Shares</span>
                    </div>
                    {yesBids.map((l, idx) => (
                      <div
                        key={`ybid-${l.price_bps}-${l.quantity}-${idx}`}
                        className="relative grid grid-cols-2 px-3 py-1.5 text-sm text-emerald-300 group z-0"
                      >
                        <div
                          className="absolute inset-y-0 right-0 bg-emerald-500/10 -z-10 transition-all group-hover:bg-emerald-500/20"
                          style={{ width: `${(Number(l.quantity) / maxYes) * 100}%` }}
                        />
                        <span>{(l.price_bps / 100).toFixed(1)}¢</span>
                        <span className="text-right">{formatShares(l.quantity)}</span>
                      </div>
                    ))}
                    {yesBids.length === 0 && (
                      <p className="px-3 py-3 text-center text-xs text-zinc-500">
                        No YES bids
                      </p>
                    )}
                    <div className="grid grid-cols-2 border-y border-white/10 bg-white/[0.04] px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                      <span>Asks</span>
                      <span className="text-right">Shares</span>
                    </div>
                    {yesAsks.map((l, idx) => (
                      <div
                        key={`yask-${l.price_bps}-${l.quantity}-${idx}`}
                        className="relative grid grid-cols-2 px-3 py-1.5 text-sm text-rose-300 group z-0"
                      >
                        <div
                          className="absolute inset-y-0 right-0 bg-rose-500/10 -z-10 transition-all group-hover:bg-rose-500/20"
                          style={{ width: `${(Number(l.quantity) / maxYes) * 100}%` }}
                        />
                        <span>{(l.price_bps / 100).toFixed(1)}¢</span>
                        <span className="text-right">{formatShares(l.quantity)}</span>
                      </div>
                    ))}
                    {yesAsks.length === 0 && (
                      <p className="px-3 py-3 text-center text-xs text-zinc-500">
                        No YES asks
                      </p>
                    )}
                  </div>
                  <div
                    className={`overflow-hidden rounded-lg border ${
                      side === "no"
                        ? "border-rose-500/50"
                        : "border-white/10"
                    }`}
                  >
                    <div className="flex items-center justify-between bg-rose-500/10 px-3 py-2 text-xs font-bold uppercase tracking-wider text-rose-300">
                      <span>NO order book</span>
                      {side === "no" && (
                        <span className="rounded-full bg-rose-500/20 px-1.5 py-0.5 text-[9px]">
                          active
                        </span>
                      )}
                    </div>
                    <div className="grid grid-cols-2 border-b border-white/10 bg-white/[0.04] px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                      <span>Bids</span>
                      <span className="text-right">Shares</span>
                    </div>
                    {noBids.map((l, idx) => (
                      <div
                        key={`nbid-${l.price_bps}-${l.quantity}-${idx}`}
                        className="relative grid grid-cols-2 px-3 py-1.5 text-sm text-emerald-300 group z-0"
                      >
                        <div
                          className="absolute inset-y-0 right-0 bg-emerald-500/10 -z-10 transition-all group-hover:bg-emerald-500/20"
                          style={{ width: `${(Number(l.quantity) / maxNo) * 100}%` }}
                        />
                        <span>{(l.price_bps / 100).toFixed(1)}¢</span>
                        <span className="text-right">{formatShares(l.quantity)}</span>
                      </div>
                    ))}
                    {noBids.length === 0 && (
                      <p className="px-3 py-3 text-center text-xs text-zinc-500">
                        No NO bids
                      </p>
                    )}
                    <div className="grid grid-cols-2 border-y border-white/10 bg-white/[0.04] px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                      <span>Asks</span>
                      <span className="text-right">Shares</span>
                    </div>
                    {noAsks.map((l, idx) => (
                      <div
                        key={`noask-${l.price_bps}-${l.quantity}-${idx}`}
                        className="relative grid grid-cols-2 px-3 py-1.5 text-sm text-rose-300 group z-0"
                      >
                        <div
                          className="absolute inset-y-0 right-0 bg-rose-500/10 -z-10 transition-all group-hover:bg-rose-500/20"
                          style={{ width: `${(Number(l.quantity) / maxNo) * 100}%` }}
                        />
                        <span>{(l.price_bps / 100).toFixed(1)}¢</span>
                        <span className="text-right">{formatShares(l.quantity)}</span>
                      </div>
                    ))}
                    {noAsks.length === 0 && (
                      <p className="px-3 py-3 text-center text-xs text-zinc-500">
                        No NO asks
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
          {/* R62 audit fix: "Last refreshed"
             indicator + manual refresh
             button on the order book.
             The order book auto-polls
             every 4s via the `setInterval`
             on line 365, but a user who
             just placed an order wants
             immediate confirmation. The
             button bypasses the 4s
             wait by calling `refresh()`
             synchronously (which re-runs
             `getMarket` + the DeepBook
             depth read). The timestamp
             uses `toLocaleTimeString` for
             a 24h-format local time
             string. */}
          <div className="mt-2 flex items-center justify-between gap-2 text-[10px] text-zinc-500">
            <span className="whitespace-nowrap tabular-nums">
              Updated {new Date(lastBookRefreshMs).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
            </span>
            <button
              type="button"
              onClick={() => {
                setRefreshCounter((c) => c + 1);
                toast.loading("Refreshing order book…", { id: "book-refresh" });
                // Clear the toast after the
                // 4s polling tick has had a
                // chance to land. We use a
                // quick `setTimeout` rather
                // than the natural polling
                // cadence so the toast
                // doesn't sit on screen for
                // a full 4s — the user can
                // see the bid/ask numbers
                // change in <1s and the
                // toast just confirms the
                // manual click landed.
                setTimeout(() => toast.success("Order book refreshed", { id: "book-refresh" }), 1500);
              }}
              className="rounded border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-zinc-300 hover:bg-white/10 transition"
            >
              ↻ Refresh
            </button>
          </div>

          {/* R32 sweep fix: surface a "Recent
              trades" panel below the order book
              so a user landing on a market mid-
              session has a single-glance signal of
              recent activity (price drift, fill
              rate, "is this a quiet book?"). The
              panel calls `getMarketTrades(marketId,
              10)` on mount and refreshes every
              10s when the tab is visible. The
              trades are populated by the agents'
              position-indexer (from
              `DeepBookOrderFilled` events) so
              demo / pre-launch markets show the
              friendly empty state.

              R-WC-2 fix: moved INSIDE the
              order book card so the page grid
              has only 2 children (order book +
              trade wrapper) and the `order-*`
              classes place them in the
              intended columns. The pre-R-WC-2
              build had RecentTrades as a
              sibling of the order book, which
              made it the first auto-placed
              cell and pushed the trade card
              to a new row on the left.

              R-FIX-RT layout fix: separated
              from the "Updated / ↻ Refresh"
              footer row by a border-t divider.
              Pre-fix the `<RecentTrades>`
              component was rendered INSIDE
              the footer flex row as a sibling
              of the timestamp and the refresh
              button, and the component itself
              rendered its own outer <Card> —
              producing a nested-card-in-a-
              flex-row layout where the
              "RECENT TRADES" title and content
              competed for flex-row space with
              "Updated HH:MM:SS" and
              "↻ REFRESH" and overflowed on
              both desktop and mobile. The
              component now renders a self-
              contained <section> with its own
              title row, and the border-t +
              pt-4 wrapper below establishes
              it as a distinct subsection of
              the order book card without
              nested-card visual noise. */}
          <div className="mt-4 border-t border-white/10 pt-4">
            <RecentTrades marketId={marketId} limit={10} />
          </div>
        </Card>

        <div className="order-1 lg:order-2 lg:col-span-2 grid gap-4 lg:grid-cols-2 min-w-0">
          <Card title="Trade" id="trade-card">
          {/*
            UAT-FN-03 fix: replace the trade form with a
            settlement banner when the market is resolved.
            The on-chain `place_order` would happily submit
            an order on a settled market (it sits on the
            book forever; the user holds a position that
            can never settle) and the previous UI exposed
            the full Buy/Sell form, price input, and "Buy
            YES" button as live, clickable controls. Same
            fix is needed for the mint path (line ~786)
            and the order path (line ~1000) which already
            pre-flight `market.status !== "active"`, but
            rendering the controls in the first place was
            the user-facing bug. Show the winner, a
            redeem/dispute hint, and a "back to markets"
            link. The card title stays "Trade" so the
            user's muscle memory isn't disrupted — the
            banner inside tells them the market is done.
          */}
          {market.status !== "active" ? (
            <div className="space-y-4 py-2" data-testid="settled-banner">
              <div
                className={`flex items-start gap-3 rounded-lg border p-4 ${
                  market.status === "resolved"
                    ? market.outcome === "yes"
                      ? "border-emerald-500/30 bg-emerald-500/10"
                      : market.outcome === "no"
                      ? "border-rose-500/30 bg-rose-500/10"
                      : "border-amber-500/30 bg-amber-500/10"
                    : "border-amber-500/30 bg-amber-500/10"
                }`}
              >
                <div className="text-2xl" aria-hidden="true">
                  {market.status === "resolved" ? "🏁" : "⏸️"}
                </div>
                <div className="min-w-0 flex-1">
                  <h3 className="text-base font-semibold text-white">
                    {market.status === "resolved"
                      ? "Market settled"
                      : `Market ${market.status}`}
                  </h3>
                  <p className="mt-1 text-sm text-zinc-300">
                    {market.status === "resolved"
                      ? market.outcome
                        ? `Winner: ${market.outcome.toUpperCase()}. New orders cannot be placed. Use the position card below to redeem your payout${position.yes > 0 || position.no > 0 ? "" : " if you held winning shares"}.`
                        : "Outcome recorded. New orders cannot be placed."
                      : `This market is ${market.status} and is not currently accepting orders. Check back later.`}
                  </p>
                </div>
              </div>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Link
                  href="/markets"
                  className="inline-flex min-h-11 flex-1 items-center justify-center rounded-lg bg-white/5 px-4 text-sm font-semibold text-white transition hover:bg-white/10"
                >
                  ← Back to markets
                </Link>
                {market.status === "resolved" && (
                  <Link
                    href="/portfolio"
                    className="inline-flex min-h-11 flex-1 items-center justify-center rounded-lg bg-gradient-to-r from-emerald-600 to-cyan-600 px-4 text-sm font-semibold text-white shadow-lg shadow-cyan-900/30 transition hover:scale-[1.02]"
                  >
                    Go to portfolio →
                  </Link>
                )}
              </div>
            </div>
          ) : (
          <>
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
            // UAT-FN-12 fix (price side): mirror
            // the size input's aria-invalid +
            // aria-describedby. The pre-fix price
            // input had no programmatic signal
            // for the screen-reader user that
            // the value was out of bounds; the
            // `clampNumberString` onChange
            // silently coerced the value but
            // the visual state didn't update.
            // The new `aria-invalid` flips when
            // the displayed price is below
            // 0.01 or above 0.99 (the same
            // range the `clampNumberString`
            // enforces), and the hint text
            // below the input gives the user
            // the same range. Both inputs now
            // share the same a11y pattern.
            aria-invalid={displayedPrice < 0.01 || displayedPrice > 0.99}
            aria-describedby="price-hint"
            className={`mb-1 w-full rounded-md border bg-black/20 px-3 py-3 text-white outline-none transition ${
              displayedPrice < 0.01 || displayedPrice > 0.99
                ? "border-rose-500/50 focus:border-rose-500/70"
                : "border-white/10 focus:border-emerald-400/70"
            }`}
          />
          <p
            id="price-hint"
            className={`mb-4 text-[10px] ${
              displayedPrice < 0.01 || displayedPrice > 0.99
                ? "text-rose-300"
                : "text-zinc-500"
            }`}
          >
            0.01 – 0.99. The on-chain order book rejects prices outside
            this range.
          </p>
          <label className="mb-1.5 block text-xs font-semibold uppercase text-zinc-500">
            Size
          </label>
          <input
            type="number"
            step="0.01"
            min="0.01"
            // UAT-FN-12 fix: cap the
            // input at 1,000,000
            // shares. The pre-fix
            // build had no `max`
            // attribute; a user
            // could type `999999`
            // or `1e10` and click
            // "Buy YES" with the
            // button still enabled
            // (the disabled check
            // only gated on
            // `qty <= 0`). The
            // `clampNumberString`
            // on the onChange
            // already silently
            // truncated the value
            // to 1M in state but
            // the browser-side
            // `max` was missing —
            // a screen-reader user
            // had no programmatic
            // signal that the
            // input range was
            // bounded, and a
            // screen-only user
            // could paste a value
            // that the browser
            // would accept and
            // only then silently
            // clamp. The
            // `aria-invalid` flag
            // mirrors the price
            // input's pre-existing
            // pattern (none yet —
            // added here as the
            // first instance) and
            // turns the border
            // rose if the user
            // pastes an out-of-
            // range value.
            max="1000000"
            value={qty}
            // R38 audit fix: route through clampNumberString so a
            // paste of "1.2.3", "abc", or "1e9" can't land in state
            // as `NaN` — the downstream BigInt(Math.round(...))
            // would then TypeError in the render path, leaving
            // the user with a stuck "Submitting..." spinner and
            // no error toast.
            onChange={(e) => setQty(clampNumberString(e.target.value, 0.01, 0.01, 1_000_000))}
            aria-invalid={qty > 1_000_000 || qty < 0.01}
            aria-describedby="size-hint"
            className={`mb-1 w-full rounded-md border bg-black/20 px-3 py-3 text-white outline-none transition ${
              qty > 1_000_000 || qty < 0.01
                ? "border-rose-500/50 focus:border-rose-500/70"
                : "border-white/10 focus:border-emerald-400/70"
            }`}
          />
          <p
            id="size-hint"
            className={`mb-4 text-[10px] ${
              qty > 1_000_000 ? "text-rose-300" : "text-zinc-500"
            }`}
          >
            0.01 – 1,000,000 shares. The on-chain order book caps the
            per-order quantity at 1M.
          </p>
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
            {/* R62 audit fix: surface a
                "far from mid" warning
                when the user's limit
                price is more than 20¢
                away from the current
                mid. A user who enters
                0.95 for a YES buy when
                the mid is 0.50 will
                see their order sit on
                the book forever (or
                get filled only if a
                sudden reprice happens),
                and the pre-R62 build
                silently accepted the
                input without any
                "your price is 45¢
                above mid" hint. The
                warning is purely
                advisory (doesn't
                disable the submit) and
                uses the same amber
                colour the rest of the
                trade panel uses for
                "not enough DUSDC" /
                "balance manager
                required" hints, so the
                user can still proceed
                if they really want to
                sit on a wide order. */}
            {(() => {
              const priceDiff = Math.abs(displayedPrice - yesMid);
              if (priceDiff > 0.2) {
                return (
                  <div className="mt-2 flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-200">
                    <span aria-hidden="true">⚠️</span>
                    <span>
                      Your limit is {Math.round(priceDiff * 100)}¢ {displayedPrice > yesMid ? "above" : "below"} the
                      current mid ({formatCents(yesMid)}). This order is unlikely
                      to fill until the market reprices.
                    </span>
                  </div>
                );
              }
              return null;
            })()}
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
              (!useDeepBookRoute && market.id.startsWith("demo-")) ||
              market.status !== "active" ||
              qty <= 0 ||
              displayedPrice <= 0 ||
              displayedPrice >= 1
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
          </>
          )}
        </Card>

        {/* R-WC-2: team analysis card. Sits in the
           right column of the YES order book / Trade
           grid, stacked below the Trade card on
           desktop so it's at the same level visually
           (right side, same width as the Trade card).
           On mobile it stacks below the Trade card
           (flex-col). The WcTeamAnalysisCard
           component handles its own loading / error
           / no-match states internally. Non-WC
           markets skip the card entirely. */}
        {market.id.startsWith("wc26-") && (
          <Card title="Team Analysis">
            <WcTeamAnalysisCard marketId={market.id} />
          </Card>
        )}
        </div>
      </div>

      <FriendPositionsWidget
        marketId={marketId}
        onCopyBet={(side, size) => {
          setSide(side);
          setOrderSide("buy");
          setQty(Math.max(1, Math.round(size / 1e6)));
          toast.success(`Copied friend's ${side.toUpperCase()} bet — adjust and place below`);
        }}
      />

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
                      onChange={(e) => setDepositAmount(clampNumberString(e.target.value, 1, 1, 1_000_000))}
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
          {/* Self-hosted DUSDC faucet. Rendered inside the
             Collateral card because the user is exactly
             one click away from needing DUSDC to mint
             YES+NO shares. The compact variant is a
             single 1-tap button — the FaucetButton
             self-handles the "agents offline" /
             "faucet disabled" / "no TreasuryCap" states
             and renders a friendly hint instead of a
             greyed-out button. The corresponding
             `faucet-mint` window event triggers a
             re-fetch of the user's DUSDC balance so they
             can immediately click "Mint Shares" again. */}
          <FaucetButton
            variant="compact"
            label="Faucet 100 DUSDC"
            className="mb-3"
          />
          <div className="grid grid-cols-2 gap-3 mt-2">
            <button
              type="button"
              // R-UAT-23 follow-up: the WC markets
              // (e.g. `wc26-A1v4`) are seeded
              // into the SQLite mirror with no
              // on-chain market id (the
              // world-cup-creator's on-chain path
              // is gated on a self-hosted DeepBook
              // pool that doesn't exist for the
              // current testnet deploy). The
              // `splitCollateral` flow calls
              // `buildMintSharesTx(market.onchain_market_id ?? market.id, ...)`;
              // the SDK then calls
              // `normalizeObjectId("wc26-A1v4")` and
              // throws with the raw
              // `"wc26-A1v4" is not a valid Sui
              // object id` message. Disable the
              // button up-front when the market has
              // no on-chain market id, with a
              // short `title=` hint that explains why
              // the button is grey. Users who want
              // to mint against a real on-chain
              // market can still do so — just not
              // against a SQLite-mirror WC row.
              disabled={
                busy === "mint" ||
                !account ||
                market.id.startsWith("demo-") ||
                market.status !== "active" ||
                !market.onchain_market_id
              }
              title={
                !market.onchain_market_id
                  ? "This market has no on-chain market id (it's a SQLite-mirror demo row). Minting requires an on-chain market — try a different market or wait for the world-cup-creator to publish one on-chain."
                  : undefined
              }
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
            {/* R61 audit fix: estimated value + P&L
               rollup. The previous build only showed
               the raw share counts — a user with 100
               YES shares had no signal what those
               shares were worth. The value line
               computes the estimated redemption
               value at the current mid (active
               markets) or at $1/share (resolved
               markets where the user holds the
               winning side). A resolved losing
               side reads $0, which is also the
               truthful value. */}
            <div className="rounded-md border border-white/5 bg-white/[0.02] p-3">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Estimated value</p>
              <p className="mt-1 text-xl font-bold text-cyan-300">
                $
                {(() => {
                  if (market.status === "resolved" && market.outcome) {
                    const winning =
                      market.outcome === "yes" ? position.yes : position.no;
                    return (winning / 1e6).toLocaleString(undefined, {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    });
                  }
                  // Active market: use the current
                  // mid for the user's dominant side
                  // (the one with the bigger balance).
                  // A user with equal YES/NO holds
                  // 1 DUSDC worth of "balanced"
                  // collateral (because redeem(YES) +
                  // redeem(NO) = 1 DUSDC, the
                  // "complete set" arbitrage).
                  const mid = book?.mid_price ?? 0.5;
                  const yesValue = (position.yes / 1e6) * mid;
                  const noValue = (position.no / 1e6) * (1 - mid);
                  return (yesValue + noValue).toLocaleString(undefined, {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  });
                })()}
              </p>
              <p className="mt-0.5 text-xs text-zinc-500">
                {market.status === "resolved" && market.outcome
                  ? `Winning side: ${market.outcome.toUpperCase()} · redeem to claim`
                  : "at current mid-price"}
              </p>
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
                  // R63 audit fix: pass the on-chain
                  // marketId, not the SQLite primary-key
                  // form. For WC markets the SQLite id is
                  // `wc26-<matchId>` but the dispute
                  // builder calls `normalizeObjectId(marketId)`
                  // (which throws on non-Sui-ids) and
                  // `tx.object(...)` (which aborts on-chain
                  // with `MoveAbort` if the object isn't a
                  // valid PredictionMarket). Use
                  // `onchain_market_id ?? market.id` — same
                  // pattern the mint / redeem / placeOrder
                  // builders use (R60 audit fix). For non-WC
                  // markets the two are identical; the
                  // fallback is a safety net.
                  <Link
                    href={`/dispute/${encodeURIComponent(
                      (market as { onchain_market_id?: string }).onchain_market_id ?? market.id,
                    )}`}
                    className="w-fit rounded-md border border-amber-500/40 bg-amber-500/10 px-5 py-2.5 text-sm font-semibold text-amber-200 transition hover:bg-amber-500/20"
                  >
                    Dispute outcome
                  </Link>
                )}
                {/* R61 audit fix: deep-link to the SuiVision
                   block explorer so a curious user (or an
                   auditor triaging a dispute) can verify
                   the on-chain state directly. The link
                   uses the same `SUI_NETWORK` allowlist
                   the `/agents` page uses (testnet / mainnet
                   / devnet — never `localnet` since SuiVision
                   doesn't index a localnet node). The link
                   only renders for non-demo markets because
                   SuiVision can't index a SQLite-only stub. */}
                {!market.id.startsWith("demo-") && (() => {
                  // R63 audit fix: use the on-chain
                  // marketId, not the SQLite form, and
                  // gate on the strict `0x + 64 hex`
                  // shape so a WC market's `wc26-*`
                  // SQLite id (which isn't a Sui object
                  // id) doesn't produce a broken
                  // `https://testnet.suivision.xyz/object/wc26-...`
                  // link that 404s. The pre-fix code
                  // was the asymmetric survivor — the
                  // header SuiVision link (line ~1999)
                  // already uses
                  // `onchain_market_id ?? market.id` and
                  // the same `^0x[0-9a-fA-F]{64}$` gate.
                  // Mirror that pattern so both
                  // SuiVision links behave identically.
                  const onchainId = market.onchain_market_id ?? market.id;
                  if (!/^0x[0-9a-fA-F]{64}$/.test(onchainId)) return null;
                  return (
                    <a
                      href={`https://${SUI_NETWORK_FOR_EXPLORER}.suivision.xyz/object/${encodeURIComponent(onchainId)}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="w-fit inline-flex items-center gap-1.5 rounded-md border border-cyan-500/30 bg-cyan-500/10 px-5 py-2.5 text-sm font-semibold text-cyan-200 transition hover:bg-cyan-500/20"
                    >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path strokeLinecap="round" d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                      <path strokeLinecap="round" d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                    </svg>
                    View on SuiVision ↗
                    </a>
                  );
                })()}
              </div>
            )}
          </div>
        </Card>
      </div>

    </div>
  );
}
