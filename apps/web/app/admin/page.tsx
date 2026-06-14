"use client";

/**
 * Protocol admin panel — a single page that exposes the three
 * admin-gated on-chain operations a deployer needs:
 *
 *   1. Withdraw accumulated mint/redeem fees from `FeeVault<DUSDC>`.
 *      Authority: connected wallet must equal `vault.admin` (set at
 *      `init_fee_vault` time).
 *   2. Update the prize-pool distribution curve (rank → bps). Authority:
 *      connected wallet must equal `PrizeAdmin.admin`.
 *   3. Resolve a previously-disputed market. Authority: the market
 *      creator (set at `create_market` time) — this is per-market, not
 *      per-admin, but the page surfaces it because a deployer is
 *      typically also the creator.
 *   4. Update the parlay pool's max payout cap (`max_payout_bps`).
 *      Authority: connected wallet must equal `pool.admin` (set at
 *      `parlay::create_pool` time). The /parlay page slider is then
 *      clamped to this new cap on the next page load.
 *   5. Parlay pool admin: withdraw dUSDC from the pool's balance, or
 *      rotate the admin address to a new key. Both gated by
 *      `pool.admin` at the on-chain call site.
 *
 * The page is intentionally not linked in the nav. Bookmark
 * `/admin` (or set `NEXT_PUBLIC_ADMIN_ADDRESS` to your wallet so the
 * "not authorized" hint is suppressed for that address).
 */

import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useCurrentAccount,
  useCurrentClient,
  useDAppKit,
} from "@mysten/dapp-kit-react";
import {
  buildWithdrawFeesTx,
  buildSetDistributionTx,
  buildResolveDisputeTx,
  buildCreateMarketTx,
  buildSetMaxPayoutBpsTx,
  buildParlayAdminWithdrawTx,
  buildRotateParlayAdminTx,
  buildAllocateForMmTx,
  buildReturnFromMmTx,
  isValidSuiAddress,
  readFeeVaultBalance,
  readFeeVaultAdmin,
  readPrizePoolBalance,
  readPrizePoolCurrentWeek,
  readPrizePoolWeeklyPrize,
  readPrizePoolDistribution,
  readProtocolVaultTotalBalance,
  readProtocolVaultAvailableBalance,
  readProtocolVaultAllocated,
  readProtocolVaultAdmin,
  readParlayPoolBalance,
  readParlayPoolAdmin,
  readParlayMaxPayoutBps,
  readParlayTotalVolume,
  readParlayTotalPaidOut,
  DUSDC_TYPE,
} from "@suipredict/sdk";
// R49 audit fix: route the admin card catch blocks through a
// helper that surfaces Move aborts (`EUnauthorized`,
// `ETooSoon`, `EBpsTooHigh`, etc.) with their symbolic name
// instead of a hard-coded "Resolve failed" / "Distribution
// update failed" string. The SDK's `@suipredict/sdk/move-errors`
// barrel exports `moveAbortSymbolAny` (no friendly wrapper
// exists in the SDK today), so the helper lives here. The
// dispute page's `friendlyDisputeError` and the markets/[id]
// page's `friendlyMoveError` follow the same shape; lift to
// a shared util if a third caller adopts it.
import { extractMoveAbortCode, moveAbortSymbolAny } from "@suipredict/sdk/move-errors";
import { Card, Stat, Badge } from "@/components/ui";
import { submitAndWait } from "@/lib/dapp-kit";

// Read FEE_VAULT_ID from the env directly instead of the SDK's
// `FEE_VAULT_ID` constant. The SDK constant falls back to the all-zero
// Sui address, which would make the `!FEE_VAULT_ID` guard below a no-op
// and surface as an opaque on-chain abort when the env is unset. The
// raw env check ensures a friendly toast instead.
const FEE_VAULT_ID = process.env.NEXT_PUBLIC_FEE_VAULT_ID ?? "";
const PRIZE_POOL_ID = process.env.NEXT_PUBLIC_PRIZE_POOL_ID ?? "";
const PRIZE_ADMIN_ID = process.env.NEXT_PUBLIC_PRIZE_ADMIN_ID ?? "";
const PARLAY_POOL_ID = process.env.NEXT_PUBLIC_PARLAY_POOL_ID ?? "";
const VAULT_OBJECT_ID = process.env.NEXT_PUBLIC_VAULT_OBJECT_ID ?? "";
// Used as the placeholder in the SetMaxPayoutBpsCard input. The actual
// submit reads the input value, not this — we just want the form to
// pre-fill with a sensible round number on first render.
const PARLAY_DEFAULT_MAX_BPS = Number(
  process.env.NEXT_PUBLIC_PARLAY_MAX_PAYOUT_BPS ?? 50_000,
);
const ADMIN_ADDRESS = process.env.NEXT_PUBLIC_ADMIN_ADDRESS ?? "";

// SuiVision is the canonical Sui explorer; the per-network subdomain
// matches the value in `process.env.NEXT_PUBLIC_SUI_NETWORK` (the
// same env the agents use). Mainnet, testnet, and devnet are the only
// three SuiVision indexes — `localnet` and unknown values fall back to
// the testnet URL, which is the most likely to actually resolve for
// dev machines. The `as` cast on a raw env value would silently accept
// any string; narrow via runtime membership check.
//
// R51 audit fix: drop "localnet" from the allowlist.
// SuiVision only indexes mainnet/testnet/devnet; a
// `https://localnet.suivision.xyz/...` link 404s
// (the subdomain does not resolve). Pre-R51, a
// developer running `sui start --with-faucet` would
// see every "View on SuiVision" button in the
// admin dashboard link to a useless 404. With
// "localnet" removed, the membership check now
// falls through to the "testnet" default, and the
// SuiVision link points to a real (testnet)
// page that surfaces a clear "tx not found" if
// the operator copied a localnet digest. Local
// operators can still get the digest from the
// CLI without the web UI.
const SUI_NETWORKS = ["testnet", "mainnet", "devnet"] as const;
type SuiNetwork = (typeof SUI_NETWORKS)[number];
const rawNetwork = process.env.NEXT_PUBLIC_SUI_NETWORK ?? "testnet";
const SUI_NETWORK: SuiNetwork = (SUI_NETWORKS as readonly string[]).includes(rawNetwork)
  ? (rawNetwork as SuiNetwork)
  : "testnet";
const SUIVISION_TX_URL = `https://${SUI_NETWORK}.suivision.xyz/txblock/`;

// R38 audit fix: the local `txDigest` helper that returned
// "submitted" on Failed/EffectsCert has been removed. All 9
// signAndExecuteTransaction call sites in the admin cards now
// do an explicit `r.$kind !== "Transaction"` early-return and
// read `r.Transaction.digest` directly. The previous helper
// also made it trivial for new call sites to silently swallow
// the "submitted" fallback and not surface real errors.

function shortAddr(a: string | null | undefined): string {
  if (!a) return "—";
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

// R49 audit fix: local helper for the admin catch blocks. If
// the error is a Move abort with a symbolic name in one of our
// packages, surface the symbol + abort code; otherwise pass the
// underlying message through. This avoids the "Resolve failed"
// / "Distribution update failed" hard-coded strings that hide
// `EUnauthorized` / `ETooSoon` / `EBpsTooHigh` from the operator.
function friendlyAdminError(err: unknown, action: string): string {
  const base = err instanceof Error ? err.message : String(err);
  // R58.7 audit fix: route through the SDK's shared
  // `extractMoveAbortCode` helper instead of duplicating a
  // local regex. The local regex used non-greedy
  // `MoveAbort[^\n]*\)\s*,\s*(\d+)\s*\)` and returned the
  // *innermost* (first-in-string) abort code — for a
  // wrapper PTB that aborts on a deeper call (e.g. the
  // `withdraw_fees` admin tx whose Move aborts in
  // `vault::withdraw` underneath) the admin panel would
  // misreport the outer code. The SDK helper (R57.3) is
  // greedy + anchored to `in command` and returns the
  // outer (last) abort.
  const code = extractMoveAbortCode(base);
  if (code != null) {
    const sym = moveAbortSymbolAny(code);
    if (sym) {
      return `${action} failed: ${sym} (abort code ${code})`;
    }
    return `${action} failed: Move abort ${code}`;
  }
  return `${action} failed: ${base}`;
}

export default function AdminPage() {
  const account = useCurrentAccount();
  const dAppKit = useDAppKit();
  // R55 audit fix: wire up a useQueryClient so the
  // success path of every admin card can invalidate
  // the home-page / portfolio / streak / leaderboard
  // caches. Without this, a "Set distribution" or
  // "Resolve dispute" submit only updates the local
  // `lastAction` toast and the on-page LiveStateCard;
  // the home-page leaderboard and /portfolio stay
  // stale for 30s+ until the next manual refresh.
  // The pattern mirrors the
  // `app/vault/page.tsx:50-65` invalidateCrossPageCaches
  // helper.
  const queryClient = useQueryClient();
  // Normalize both sides to lowercase hex. Sui addresses are
  // case-insensitive, but the previous strict-equality check locked
  // the operator out if `NEXT_PUBLIC_ADMIN_ADDRESS` was set with a
  // leading 0x stripped, or with mixed-case hex. The strict form
  // (`0x` + 64 hex chars) is also validated here so a typo doesn't
  // silently fail-closed for the rest of the page.
  const normalizedAdmin = ADMIN_ADDRESS.trim().toLowerCase();
  const isValidAdmin = isValidSuiAddress(ADMIN_ADDRESS);
  const normalizedAccount = (account?.address ?? "").toLowerCase();
  const isAdmin = isValidAdmin && normalizedAccount === normalizedAdmin;
  const walletConnected = !!account;
  const [lastAction, setLastAction] = useState<{
    label: string;
    digest: string;
  } | null>(null);
  // Surface a loud console warning at page load if the env is set
  // but doesn't look like a Sui address — the operator will then
  // know to fix `NEXT_PUBLIC_ADMIN_ADDRESS` instead of clicking
  // through silently disabled forms.
  useEffect(() => {
    if (ADMIN_ADDRESS && !isValidAdmin) {
      console.warn(
        `[admin] NEXT_PUBLIC_ADMIN_ADDRESS=${JSON.stringify(
          ADMIN_ADDRESS,
        )} is not a 0x-prefixed 64-char hex address. Admin actions will be disabled until this is fixed.`,
      );
    }
    // `ADMIN_ADDRESS` is a module-level constant — it can never
    // change at runtime, so it isn't a valid dep. The effect only
    // needs to re-run when `isValidAdmin` flips, which it does on
    // account connect / disconnect (handled by the upstream hooks).
  }, [isValidAdmin]);

  const live = useLiveState();

  // R55 audit fix: invalidate cross-page React Query
  // caches after a successful admin action. The home
  // page reads `["marketsList"]` and `["leaderboard",
  // "week", ...]`; the /portfolio page reads
  // `["portfolio", address]`; the streak panel reads
  // `["userStreakId"]` and `["streakInfo"]`. Without
  // these, an admin who set a new distribution, created
  // a market, or paused a policy from /admin would see
  // stale data on the home page until the leaderboard's
  // 30s staleTime or the markets list's 60s staleTime
  // elapsed. The `type: "active"` flag matches the
  // hook-registered keys (which are 2-tuples / 3-tuples)
  // via TanStack prefix matching.
  useEffect(() => {
    if (!lastAction) return;
    void queryClient.invalidateQueries({ queryKey: ["marketsList"], type: "active" });
    void queryClient.invalidateQueries({ queryKey: ["dailyMarkets"], type: "active" });
    void queryClient.invalidateQueries({ queryKey: ["leaderboard", "week"], type: "active" });
    if (account?.address) {
      void queryClient.invalidateQueries({
        queryKey: ["portfolio", account.address],
        type: "active",
      });
    }
  }, [lastAction, queryClient, account?.address]);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-transparent bg-clip-text bg-gradient-to-r from-rose-300 via-amber-300 to-amber-500">
          Admin
        </h1>
        <p className="mt-2 text-sm text-zinc-400">
          Protocol-gated operations. Each action checks the connected
          wallet against the on-chain authority — if it does not match,
          the on-chain call aborts with an error.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
          <span>Wallet:</span>
          <Badge variant={walletConnected ? "success" : "default"}>
            {walletConnected ? shortAddr(account?.address) : "not connected"}
          </Badge>
          {ADMIN_ADDRESS && (
            <>
              <span>·</span>
              <span>Expected admin:</span>
              <Badge variant={isAdmin ? "success" : "warning"}>
                {shortAddr(ADMIN_ADDRESS)}
              </Badge>
            </>
          )}
        </div>
        {lastAction && (
          <div
            role="status"
            className="mt-3 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200"
          >
            <span className="font-semibold">{lastAction.label}</span> submitted.
            Digest:{" "}
            <a
              href={`${SUIVISION_TX_URL}${lastAction.digest}`}
              target="_blank"
              rel="noreferrer"
              className="font-mono text-emerald-300 underline underline-offset-2"
            >
              {shortAddr(lastAction.digest)}
            </a>
          </div>
        )}
      </div>

      <LiveStateCard
        state={live.state}
        loading={live.loading}
        onRefresh={live.refresh}
      />

      <WithdrawFeesCard
        onSubmit={(d) => setLastAction({ label: "Withdraw fees", digest: d })}
        dAppKit={dAppKit}
        disabled={!walletConnected || !isAdmin}
        vaultBalance={live.state.feeVault?.balance}
      />
      <SetDistributionCard
        onSubmit={(d) =>
          setLastAction({ label: "Set distribution", digest: d })
        }
        dAppKit={dAppKit}
        disabled={!walletConnected || !isAdmin}
      />
      <ResolveDisputeCard
        onSubmit={(d) =>
          setLastAction({ label: "Resolve dispute", digest: d })
        }
        dAppKit={dAppKit}
        disabled={!walletConnected || !isAdmin}
      />
      <CreateMarketCard
        onSubmit={(d) => setLastAction({ label: "Create market", digest: d })}
        dAppKit={dAppKit}
        disabled={!walletConnected || !isAdmin}
      />
      <SetMaxPayoutBpsCard
        onSubmit={(d) =>
          setLastAction({ label: "Set parlay max payout", digest: d })
        }
        dAppKit={dAppKit}
        disabled={!walletConnected || !isAdmin}
      />
      <ParlayAdminCard
        onSubmit={(label, d) => setLastAction({ label, digest: d })}
        dAppKit={dAppKit}
        disabled={!walletConnected || !isAdmin}
        poolBalance={live.state.parlayPool?.balance}
        currentAdmin={live.state.parlayPool?.admin}
      />
      <VaultAdminCard
        onSubmit={(label, d) => setLastAction({ label, digest: d })}
        dAppKit={dAppKit}
        disabled={!walletConnected || !isAdmin}
        available={live.state.protocolVault?.available}
        allocated={live.state.protocolVault?.allocated}
      />
    </div>
  );
}

// ============================================================
// Live state — read all shared objects, surface balances and admins
// so operators can see what they're operating on before submitting
// a tx. Round-26 audit finding C3: the page was previously
// "submit-only" with no live state.
// ============================================================

interface LiveState {
  feeVault: { balance: bigint; admin: string } | null;
  prizePool: {
    balance: bigint;
    weeklyPrize: bigint;
    currentWeek: bigint;
    distribution: number[];
  } | null;
  protocolVault: {
    available: bigint;
    allocated: bigint;
    total: bigint;
    admin: string;
  } | null;
  parlayPool: {
    balance: bigint;
    totalVolume: bigint;
    totalPaidOut: bigint;
    maxPayoutBps: bigint;
    admin: string;
  } | null;
}

const EMPTY_LIVE_STATE: LiveState = {
  feeVault: null,
  prizePool: null,
  protocolVault: null,
  parlayPool: null,
};

function useLiveState(): { state: LiveState; loading: boolean; refresh: () => void } {
  const client = useCurrentClient();
  const [state, setState] = useState<LiveState>(EMPTY_LIVE_STATE);
  const [loading, setLoading] = useState(false);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!client) return;
    // R58.H3 audit fix: own an AbortController at the
    // effect level. The Sui gRPC `core.getObject` API
    // doesn't accept a `signal` argument at the SDK
    // level (the protocol-reads helper at
    // `protocol-reads.ts:23` calls `client.core.getObject`
    // with no signal), so the underlying RPCs can't be
    // cancelled mid-flight. The fix is two-fold:
    //   (a) use the `cancelled` flag below to drop
    //       setState writes from superseded ticks
    //       (the previous code already did this for
    //       the *first* nonce change but the inner
    //       `Promise.all` setStates ran anyway for
    //       the late-arriving responses — those
    //       were the "stale data overwrites fresh
    //       data" race the audit flagged).
    //   (b) store the `cancelled` flag in a ref so
    //       a second effect re-entry (refresh
    //       button, prop change) cancels the prior
    //       tick at the same instant the new tick
    //       starts, not on React's next render
    //       commit. The `cancelled` ref is checked
    //       between every `Promise.all` block.
    const cancelledRef = { current: false };
    setLoading(true);
    (async () => {
      const next: LiveState = {
        feeVault: null,
        prizePool: null,
        protocolVault: null,
        parlayPool: null,
      };
      // Each read is best-effort: a missing env id or a transient
      // RPC failure leaves that slot `null` rather than crashing
      // the whole panel. Operators can see "—" for a slot that
      // failed to load and try the refresh button.
      try {
        if (FEE_VAULT_ID && !cancelledRef.current) {
          const [balance, admin] = await Promise.all([
            readFeeVaultBalance(client, FEE_VAULT_ID),
            readFeeVaultAdmin(client, FEE_VAULT_ID),
          ]);
          if (cancelledRef.current) return;
          next.feeVault = { balance, admin };
        }
      } catch {
        // leave null
      }
      try {
        if (PRIZE_POOL_ID && !cancelledRef.current) {
          const [balance, weeklyPrize, currentWeek, distribution] =
            await Promise.all([
              readPrizePoolBalance(client, PRIZE_POOL_ID),
              readPrizePoolWeeklyPrize(client, PRIZE_POOL_ID),
              readPrizePoolCurrentWeek(client, PRIZE_POOL_ID),
              readPrizePoolDistribution(client, PRIZE_POOL_ID),
            ]);
          if (cancelledRef.current) return;
          next.prizePool = { balance, weeklyPrize, currentWeek, distribution };
        }
      } catch {
        // leave null
      }
      try {
        if (VAULT_OBJECT_ID && !cancelledRef.current) {
          const [available, allocated, total, admin] = await Promise.all([
            readProtocolVaultAvailableBalance(client, VAULT_OBJECT_ID),
            readProtocolVaultAllocated(client, VAULT_OBJECT_ID),
            readProtocolVaultTotalBalance(client, VAULT_OBJECT_ID),
            readProtocolVaultAdmin(client, VAULT_OBJECT_ID),
          ]);
          if (cancelledRef.current) return;
          next.protocolVault = { available, allocated, total, admin };
        }
      } catch {
        // leave null
      }
      try {
        if (PARLAY_POOL_ID && !cancelledRef.current) {
          const [balance, totalVolume, totalPaidOut, maxPayoutBps, admin] =
            await Promise.all([
              readParlayPoolBalance(client, PARLAY_POOL_ID),
              readParlayTotalVolume(client, PARLAY_POOL_ID),
              readParlayTotalPaidOut(client, PARLAY_POOL_ID),
              readParlayMaxPayoutBps(client, PARLAY_POOL_ID),
              readParlayPoolAdmin(client, PARLAY_POOL_ID),
            ]);
          if (cancelledRef.current) return;
          next.parlayPool = {
            balance,
            totalVolume,
            totalPaidOut,
            maxPayoutBps,
            admin,
          };
        }
      } catch {
        // leave null
      }
      if (!cancelledRef.current) {
        setState(next);
        setLoading(false);
      }
    })();
    return () => {
      cancelledRef.current = true;
    };
  }, [client, nonce]);

  return { state, loading, refresh: () => setNonce((n) => n + 1) };
}

function formatDusdc(amount: bigint | undefined, decimals = 6): string {
  if (amount === undefined) return "—";
  // Move balances are in base units (10^decimals). Render as DUSDC
  // with 2 trailing digits for compactness; operators can switch
  // to a "raw" view if they need exact base-unit arithmetic.
  const base = Number(amount) / 10 ** decimals;
  if (!Number.isFinite(base)) return "—";
  return base.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatBps(bps: bigint | undefined): string {
  if (bps === undefined) return "—";
  // 10_000 bps = 1.0x, 50_000 bps = 5.0x. Show both for clarity.
  const bpsNum = Number(bps);
  return `${bpsNum.toLocaleString()} bps (${(bpsNum / 10_000).toFixed(2)}x)`;
}

function LiveStateCard(props: {
  state: LiveState;
  loading: boolean;
  onRefresh: () => void;
}) {
  const { state, loading, onRefresh } = props;
  // Show "— (env unset)" when the env id wasn't set at build time,
  // vs. "—" (no value yet) when the read is in flight. Operators
  // can distinguish "I forgot to deploy this" from "RPC is slow".
  const envLabel = (id: string) => (id ? shortAddr(id) : "(env unset)");

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          Live state
          <button
            type="button"
            onClick={onRefresh}
            disabled={loading}
            className="rounded-md border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-300 transition hover:bg-white/[0.08] disabled:opacity-40"
          >
            {loading ? "Refreshing…" : "Refresh"}
          </button>
        </span>
      }
    >
      <div className="space-y-4">
        <p className="text-xs text-zinc-500">
          Read-only snapshot of every shared object the cards below
          touch. Numbers are in DUSDC base units (10^6) unless noted.
          Click Refresh after a tx to see the new state.
        </p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Stat
            label={`FeeVault ${envLabel(FEE_VAULT_ID)}`}
            value={`${formatDusdc(state.feeVault?.balance)} DUSDC`}
          />
          <Stat
            label="FeeVault admin"
            value={shortAddr(state.feeVault?.admin)}
          />
          <Stat
            label={`PrizePool ${envLabel(PRIZE_POOL_ID)}`}
            value={`${formatDusdc(state.prizePool?.balance)} DUSDC`}
          />
          <Stat
            label="PrizePool week / prize"
            value={
              state.prizePool
                ? `week ${state.prizePool.currentWeek.toString()} / ${formatDusdc(state.prizePool.weeklyPrize)} DUSDC`
                : "—"
            }
          />
          <Stat
            label={`ProtocolVault ${envLabel(VAULT_OBJECT_ID)}`}
            value={
              state.protocolVault
                ? `${formatDusdc(state.protocolVault.available)} avail · ${formatDusdc(state.protocolVault.allocated)} alloc`
                : "—"
            }
          />
          <Stat
            label="ProtocolVault admin"
            value={shortAddr(state.protocolVault?.admin)}
          />
          <Stat
            label={`ParlayPool ${envLabel(PARLAY_POOL_ID)}`}
            value={`${formatDusdc(state.parlayPool?.balance)} DUSDC`}
          />
          <Stat
            label="ParlayPool volume / paid"
            value={
              state.parlayPool
                ? `${formatDusdc(state.parlayPool.totalVolume)} / ${formatDusdc(state.parlayPool.totalPaidOut)}`
                : "—"
            }
          />
          <Stat
            label="Parlay max payout cap"
            value={formatBps(state.parlayPool?.maxPayoutBps)}
          />
          <Stat
            label="ParlayPool admin"
            value={shortAddr(state.parlayPool?.admin)}
          />
        </div>
      </div>
    </Card>
  );
}

// ============================================================
// Withdraw fees
// ============================================================

function WithdrawFeesCard(props: {
  onSubmit: (digest: string) => void;
  dAppKit: ReturnType<typeof useDAppKit>;
  disabled: boolean;
  // Live FeeVault balance in base units, sourced from the LiveStateCard
  // panel. Undefined until the first read returns. The pre-flight
  // check below prevents submitting an amount the vault can't satisfy
  // — without it, the tx would either revert with EInsufficientFunds
  // or leave the on-chain balance negative (depending on the path).
  vaultBalance?: bigint;
}) {
  const [amountDusdc, setAmountDusdc] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [digest, setDigest] = useState<string | null>(null);
  // R55 audit fix: pull the dapp-kit client here (top of
  // component) so `submitAndWait` can call
  // `client.waitForTransaction` from the submit handler.
  // Calling `useCurrentClient()` inside the async submit
  // would violate the Rules of Hooks (hooks must run in
  // the same order on every render). The card
  // subcomponent pattern is uniform across the admin
  // page; every submit handler reads this `client`.
  const client = useCurrentClient();

  const amountBig = (() => {
    const n = Number(amountDusdc);
    if (!Number.isFinite(n) || n <= 0) return null;
    return BigInt(Math.round(n * 1_000_000));
  })();
  // Pre-flight: amount must be positive AND, if we have a live
  // balance, must not exceed it. We surface the comparison as an
  // explicit error so the operator can see "vault only has 12.5k"
  // and adjust before paying gas.
  const overBalance =
    amountBig !== null && props.vaultBalance !== undefined
      ? amountBig > props.vaultBalance
      : false;

  async function submit() {
    setErr(null);
    setDigest(null);
    if (!client) {
      setErr("Wallet client not ready.");
      setBusy(false);
      return;
    }
    // R47 audit fix: confirm before withdrawing.
    // R45 added `window.confirm` to the other
    // admin cards (settle, rotate, allocate)
    // but missed the fee-vault withdraw. The
    // action moves a non-trivial amount of
    // DUSDC from the on-chain `FeeVault` to
    // the operator's wallet — a misclick on a
    // pre-populated amount would silently
    // transfer the wrong value. Surface the
    // exact amount (in DUSDC, not atoms) so
    // the operator has a readable prompt.
    if (
      amountDusdc &&
      !window.confirm(
        `Withdraw ${amountDusdc} DUSDC from the fee vault to the admin wallet?`,
      )
    ) {
      return;
    }
    if (!FEE_VAULT_ID) {
      setErr("FEE_VAULT_ID is not set in this deployment.");
      return;
    }
    const amount = BigInt(Math.round(Number(amountDusdc) * 1_000_000)); // DUSDC has 6 decimals
    if (amount <= BigInt(0)) {
      setErr("Amount must be positive.");
      return;
    }
    if (props.vaultBalance !== undefined && amount > props.vaultBalance) {
      setErr(
        `Amount exceeds live FeeVault balance (${formatDusdc(
          props.vaultBalance,
        )} DUSDC). Click Refresh and try a smaller amount.`,
      );
      return;
    }
    setBusy(true);
    try {
      const tx = buildWithdrawFeesTx(FEE_VAULT_ID, amount);
      // R55 audit fix: route through `submitAndWait`
      // so the post-withdraw `useLiveState` read
      // sees a finalized vault balance. The previous
      // signAndExecuteTransaction returned
      // immediately; the readFeeVaultBalance refetch
      // raced on-chain finalization and briefly
      // showed the pre-withdraw balance.
      const r = await submitAndWait(props.dAppKit, client, tx);
      // R38 audit fix: $kind guard. On a Failed/EffectsCert return
      // (insufficient balance, non-admin caller) `txDigest(r)` is
      // the literal "unknown" — the user would see
      // "Withdraw protocol fees: unknown..." in the toast history
      // and have no idea the withdrawal silently bounced.
      if (r.$kind !== "Transaction" || !r.digest) {
        setErr("Withdraw fees failed on-chain (insufficient balance or non-admin caller).");
        setBusy(false);
        return;
      }
      const d = r.digest;
      setDigest(d);
      props.onSubmit(d);
    } catch (e) {
      setErr(friendlyAdminError(e, "Admin action"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Withdraw protocol fees">
      <div className="space-y-4">
        <p className="text-sm text-zinc-400">
          Drains the requested amount of DUSDC from the shared
          <code className="mx-1 rounded bg-white/5 px-1 py-0.5 text-xs">FeeVault</code>
          to the connected wallet. The wallet must equal
          <code className="mx-1 rounded bg-white/5 px-1 py-0.5 text-xs">vault.admin</code>
          (set at <code className="rounded bg-white/5 px-1 py-0.5 text-xs">init_fee_vault</code>
          time).
        </p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Stat label="Vault" value={shortAddr(FEE_VAULT_ID)} />
          <Stat
            label="Live balance"
            value={
              props.vaultBalance !== undefined
                ? `${formatDusdc(props.vaultBalance)} DUSDC`
                : "— (refresh Live state)"
            }
          />
          <Stat label="Amount" value={amountDusdc ? `${amountDusdc} DUSDC` : "—"} />
        </div>
        <div className="flex gap-2">
          {/* R47 audit fix: wrap the input in a
              <label> with `htmlFor` so screen
              readers announce it as "Amount in
              DUSDC" rather than "numeric text
              input". The previous bare <input>
              had no accessible name. */}
          <label
            htmlFor="withdraw-fees-amount"
            className="flex flex-col text-xs text-zinc-400"
          >
            <span className="sr-only">Amount in DUSDC</span>
            <input
              id="withdraw-fees-amount"
              type="number"
              step="0.000001"
              min="0"
              placeholder="0.0"
              value={amountDusdc}
              // R37 audit fix: allow empty or a non-negative
              // decimal (`0`, `0.5`, `1.234567`). Reject scientific
              // notation (`1e10`) and junk so the user gets
              // feedback here instead of a `BigInt(NaN)` throw at
              // submit. Fractions with up to 6 decimals match the
              // DUSDC scale (1_000_000 atoms = 1 DUSDC).
              //
              // R47 audit fix: cap the integer part
              // at 10 digits. The previous
              // `/^\d+(\.\d{0,6})?$/` allowed
              // `99999999999999999999.999999`,
              // which the BigInt conversion would
              // happily serialize to a u64 — but
              // a mainnet vault with a 9e19
              // atom (9e13 DUSDC) balance
              // would have the input *exceed* the
              // actual `vaultBalance`, and the
              // `overBalance` pre-flight check
              // only fires when `vaultBalance`
              // is loaded. A wallet-less / cold-RPC
              // deploy would silently let the
              // user submit a doomed PTB.
              // Bounding the input to a sane
              // upper limit (10^10 DUSDC =
              // 10 billion, well above any
              // realistic fee-vault balance)
              // surfaces the issue at the
              // input stage.
              onChange={(e) => {
                const v = e.target.value;
                if (v === "" || /^\d{1,10}(\.\d{0,6})?$/.test(v)) {
                  setAmountDusdc(v);
                }
              }}
              className={`w-40 rounded-md border bg-white/[0.04] px-3 py-1.5 text-sm text-white placeholder-zinc-600 focus:outline-none ${
                overBalance
                  ? "border-rose-500/60 focus:border-rose-400"
                  : "border-white/10 focus:border-rose-400"
              }`}
              disabled={props.disabled || busy}
            />
          </label>
          <button
            type="button"
            onClick={submit}
            disabled={props.disabled || busy || !amountDusdc || overBalance}
            className="rounded-md bg-gradient-to-r from-rose-500 to-amber-500 px-4 py-1.5 text-sm font-semibold text-white shadow-lg shadow-rose-500/20 transition hover:from-rose-400 hover:to-amber-400 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? "Submitting…" : "Withdraw"}
          </button>
        </div>
        {overBalance && (
          <p className="text-xs text-rose-400">
            Amount exceeds live FeeVault balance ({formatDusdc(props.vaultBalance)} DUSDC).
          </p>
        )}
        {err && <p className="text-xs text-rose-400">{err}</p>}
        {digest && (
          <p className="break-all text-xs text-emerald-300">✓ {digest}</p>
        )}
      </div>
    </Card>
  );
}

// ============================================================
// Set prize distribution
// ============================================================

function SetDistributionCard(props: {
  onSubmit: (digest: string) => void;
  dAppKit: ReturnType<typeof useDAppKit>;
  disabled: boolean;
}) {
  const [bps, setBps] = useState("5000,3000,1500,500,1000,1000,1000,1000,1000,1000");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [digest, setDigest] = useState<string | null>(null);
  // R55 audit fix: see WithdrawFeesCard for the rationale.
  const client = useCurrentClient();

  const parsed = bps
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((s) => Number(s));
  const sum = parsed.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
  const isValid = parsed.length > 0 && parsed.every((n) => Number.isInteger(n) && n >= 0) && sum === 10_000;

  async function submit() {
    setErr(null);
    setDigest(null);
    if (!client) {
      setErr("Wallet client not ready.");
      setBusy(false);
      return;
    }
    if (!PRIZE_POOL_ID || !PRIZE_ADMIN_ID) {
      setErr("NEXT_PUBLIC_PRIZE_POOL_ID / NEXT_PUBLIC_PRIZE_ADMIN_ID not set.");
      return;
    }
    if (!isValid) {
      setErr("Distribution must be non-negative integers summing to 10_000.");
      return;
    }
    // R48 audit fix: confirm before replacing the distribution.
    // The card description warns "Replaces the rank → bps
    // mapping" but the previous build let a single misclick
    // silently override the on-chain prize curve for all future
    // weeks. The on-chain `set_distribution` requires the vector
    // to sum to 10_000 (already validated above) and to match
    // rank count, but doesn't know whether the new shape is
    // "the curve you actually want" — that's an operator
    // judgment, and a confirm is the right second-chance gate.
    if (
      !window.confirm(
        `Replace the prize distribution with [${parsed.join(", ")}]? ` +
          `This affects all future weeks.`,
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      const tx = buildSetDistributionTx(PRIZE_POOL_ID, PRIZE_ADMIN_ID, parsed);
      // R55 audit fix: route through `submitAndWait` so the
      // post-write `useLiveState` read sees the updated
      // distribution curve. The previous
      // signAndExecuteTransaction returned immediately;
      // the readPrizePoolDistribution refetch raced
      // on-chain finalization and briefly showed the
      // pre-write curve.
      const r = await submitAndWait(props.dAppKit, client, tx);
      // R38 audit fix: $kind guard. EInvalidDistribution (sum !=
      // 10_000 bps, length mismatch) would surface as a move abort
      // — the previous code would still surface a fake
      // "Set prize distribution: unknown..." success and the admin
      // would have no way to tell the new distribution wasn't
      // applied.
      if (r.$kind !== "Transaction" || !r.digest) {
        setErr("Set distribution failed on-chain (vector must sum to 10_000 bps and match rank count).");
        setBusy(false);
        return;
      }
      const d = r.digest;
      setDigest(d);
      props.onSubmit(d);
    } catch (e) {
      setErr(friendlyAdminError(e, "Admin action"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Set prize distribution">
      <div className="space-y-4">
        <p className="text-sm text-zinc-400">
          Replaces the rank → bps mapping used by
          <code className="mx-1 rounded bg-white/5 px-1 py-0.5 text-xs">prize_pool::set_distribution</code>.
          The vector must sum to 10_000. Default is top-heavy
          (50/30/15/5, then 10 each for ranks 5-10).
        </p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Stat label="Pool" value={shortAddr(PRIZE_POOL_ID)} />
          <Stat label="PrizeAdmin" value={shortAddr(PRIZE_ADMIN_ID)} />
          <Stat
            label="Sum (must = 10000)"
            value={sum.toString()}
          />
        </div>
        <textarea
          value={bps}
          onChange={(e) => setBps(e.target.value)}
          rows={2}
          className={`w-full rounded-md border bg-white/[0.04] px-3 py-1.5 font-mono text-xs text-white placeholder-zinc-600 focus:outline-none ${
            isValid ? "border-white/10 focus:border-rose-400" : "border-rose-500/40"
          }`}
          placeholder="5000,3000,1500,500,1000,1000,1000,1000,1000,1000"
          disabled={props.disabled || busy}
        />
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={submit}
            disabled={props.disabled || busy || !isValid}
            className="rounded-md bg-gradient-to-r from-rose-500 to-amber-500 px-4 py-1.5 text-sm font-semibold text-white shadow-lg shadow-rose-500/20 transition hover:from-rose-400 hover:to-amber-400 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? "Submitting…" : "Set distribution"}
          </button>
          <Badge variant={isValid ? "success" : "warning"}>
            {isValid ? "valid" : "invalid"}
          </Badge>
        </div>
        {err && <p className="text-xs text-rose-400">{err}</p>}
        {digest && (
          <p className="break-all text-xs text-emerald-300">✓ {digest}</p>
        )}
      </div>
    </Card>
  );
}

// ============================================================
// Resolve dispute
// ============================================================

function ResolveDisputeCard(props: {
  onSubmit: (digest: string) => void;
  dAppKit: ReturnType<typeof useDAppKit>;
  disabled: boolean;
}) {
  const [marketId, setMarketId] = useState("");
  const [outcome, setOutcome] = useState<"1" | "2">("1"); // 1=YES, 2=NO
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [digest, setDigest] = useState<string | null>(null);
  // R55 audit fix: see WithdrawFeesCard for the rationale.
  const client = useCurrentClient();

  async function submit() {
    setErr(null);
    setDigest(null);
    if (!client) {
      setErr("Wallet client not ready.");
      setBusy(false);
      return;
    }
    if (!marketId.trim()) {
      setErr("Market ID is required.");
      return;
    }
    // R53 audit fix: validate
    // the id is a well-formed
    // Sui address (sibling to the
    // `isValidSuiAddress` check
    // already on `deepCoinId`
    // line ~1012 and `newAdmin`
    // line ~1419). The previous
    // bare trim() check
    // accepted any non-empty
    // string; a wrong-shape id
    // (e.g. an oracle id, a
    // vault id, a tx digest)
    // would build a doomed PTB
    // and the on-chain
    // `resolve_dispute` would
    // abort with an opaque
    // `EMoveAbort` for object
    // type mismatch.
    if (!isValidSuiAddress(marketId.trim())) {
      setErr("Market ID is not a valid Sui object id");
      return;
    }
    // R48 audit fix: confirm before resolving. The card is the
    // "Resolve disputed market" action and locks a market to one
    // of two outcomes irreversibly. A misclick on the YES/NO
    // toggle + Resolve button locks the wrong outcome forever;
    // the on-chain `resolve_dispute` does not allow re-resolution.
    // R45 added `window.confirm` to all the other admin cards
    // (settle, rotate, allocate, return) but `resolveDispute` was
    // missed.
    const outcomeLabel = outcome === "1" ? "YES" : "NO";
    if (
      !window.confirm(
        `Resolve market ${marketId.trim().slice(0, 10)}… as ${outcomeLabel}? ` +
          `This is irreversible.`,
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      const tx = buildResolveDisputeTx(marketId.trim(), outcome === "1" ? 1 : 2);
      // R55 audit fix: route through `submitAndWait` so the
      // post-resolve indexer read sees the new market state.
      // The previous signAndExecuteTransaction returned
      // immediately; the indexer's resolve event was not yet
      // visible to the refetch and the admin would briefly
      // see "disputed" in the markets list.
      const r = await submitAndWait(props.dAppKit, client, tx);
      // R38 audit fix: $kind guard. Resolving a non-disputed market
      // is an EInvalidState abort; the previous code would toast
      // a fake success and the user would be left wondering why
      // the market still showed "disputed" on the indexer.
      if (r.$kind !== "Transaction" || !r.digest) {
        setErr("Resolve dispute failed on-chain (market is not in disputed state, or non-creator caller).");
        setBusy(false);
        return;
      }
      const d = r.digest;
      setDigest(d);
      props.onSubmit(d);
    } catch (e) {
      setErr(friendlyAdminError(e, "Admin action"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Resolve disputed market">
      <div className="space-y-4">
        <p className="text-sm text-zinc-400">
          Settles a market that was previously disputed via
          <code className="mx-1 rounded bg-white/5 px-1 py-0.5 text-xs">dispute_market</code>.
          Only the market&apos;s creator may invoke. Outcome
          <code className="mx-1 rounded bg-white/5 px-1 py-0.5 text-xs">1</code>
          = YES, <code className="rounded bg-white/5 px-1 py-0.5 text-xs">2</code> = NO.
        </p>
        <input
          value={marketId}
          onChange={(e) => setMarketId(e.target.value)}
          placeholder="0x… market object id"
          className="w-full rounded-md border border-white/10 bg-white/[0.04] px-3 py-1.5 font-mono text-xs text-white placeholder-zinc-600 focus:border-rose-400 focus:outline-none"
          disabled={props.disabled || busy}
        />
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex overflow-hidden rounded-md border border-white/10 text-xs">
            {(["1", "2"] as const).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setOutcome(v)}
                className={`px-3 py-1.5 font-semibold transition ${
                  outcome === v
                    ? "bg-white text-zinc-950"
                    : "text-zinc-400 hover:bg-white/10"
                }`}
              >
                {v === "1" ? "YES" : "NO"}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={submit}
            disabled={props.disabled || busy || !marketId.trim()}
            className="rounded-md bg-gradient-to-r from-rose-500 to-amber-500 px-4 py-1.5 text-sm font-semibold text-white shadow-lg shadow-rose-500/20 transition hover:from-rose-400 hover:to-amber-400 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? "Submitting…" : "Resolve"}
          </button>
        </div>
        {err && <p className="text-xs text-rose-400">{err}</p>}
        {digest && (
          <p className="break-all text-xs text-emerald-300">✓ {digest}</p>
        )}
      </div>
    </Card>
  );
}

// ============================================================
// Create market (admin escape hatch — primary path is the
// MarketCreator agent). Useful for one-off demo markets or for
// recovering from a failed agent cron.
// ============================================================

function CreateMarketCard(props: {
  onSubmit: (digest: string) => void;
  dAppKit: ReturnType<typeof useDAppKit>;
  disabled: boolean;
}) {
  const [title, setTitle] = useState("");
  const [resolutionSource, setResolutionSource] = useState("CoinGecko");
  const [expiryDays, setExpiryDays] = useState("7");
  const [category, setCategory] = useState("0");
  const [deepCoinId, setDeepCoinId] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [digest, setDigest] = useState<string | null>(null);
  // R55 audit fix: see WithdrawFeesCard for the rationale.
  const client = useCurrentClient();

  async function submit() {
    setErr(null);
    setDigest(null);
    if (!client) {
      setErr("Wallet client not ready.");
      setBusy(false);
      return;
    }
    if (!title.trim()) {
      setErr("Title is required.");
      return;
    }
    if (!deepCoinId.trim() || !isValidSuiAddress(deepCoinId)) {
      setErr("DEEP coin object id is required (0x-prefixed, 64 hex chars).");
      return;
    }
    const days = Number(expiryDays);
    if (!Number.isFinite(days) || days <= 0) {
      setErr("Expiry must be a positive number of days.");
      return;
    }
    // R50 audit fix: cap `days` at 365. The
    // subsequent `BigInt(Date.now() + Math.round(days
    // * 86_400_000))` overflows the u64 parameter
    // for `days > 7.5e10` (u64 ms max ≈ 5.85e11),
    // and a more realistic `days = 999999999`
    // corrupts the move-side expiry before the
    // wallet sees the tx. The on-chain module has
    // no upper bound but the web should refuse
    // nonsense. Mirror the `SetMaxPayoutBpsCard` cap
    // pattern (line 1011 has the same shape).
    if (days > 365) {
      setErr("Expiry must be ≤ 365 days.");
      return;
    }
    const cat = Number(category);
    if (!Number.isInteger(cat) || cat < 0 || cat > 3) {
      setErr("Category must be 0..3.");
      return;
    }
    // R48 audit fix: confirm before creating. The card burns one
    // DEEP coin (non-refundable) plus gas. The help text already
    // warns "The fee is non-refundable" but the submit button had
    // no second-chance prompt. A misclick here is an irrecoverable
    // ~1 DEEP loss. R45 added `window.confirm` to the other admin
    // cards (settle, rotate, allocate, return); this card was
    // missed.
    if (
      !window.confirm(
        `Create market "${title.trim().slice(0, 60)}" expiring in ${days} days? ` +
          `This burns one DEEP coin (non-refundable).`,
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      const expiryMs = BigInt(Date.now() + Math.round(days * 86_400_000));
      const tx = buildCreateMarketTx({
        title: title.trim(),
        resolutionSource: resolutionSource.trim() || "Manual",
        expiryMs,
        deepCoinId: deepCoinId.trim(),
        category: cat,
      });
      // R55 audit fix: route through `submitAndWait` so the
      // post-create markets-list refetch sees the new
      // market. The previous signAndExecuteTransaction
      // returned immediately; the indexer's
      // MarketCreated event was not yet visible to the
      // refetch and the markets list would briefly omit
      // the new market.
      const r = await submitAndWait(props.dAppKit, client, tx);
      // R38 audit fix: $kind guard. create_market has the largest
      // failure surface (bad DEEP coin, expiry in the past, no
      // admin cap left). A Failed return would previously toast
      // "Create market: unknown..." and the admin would assume
      // the market exists, then call resolve_dispute against a
      // phantom ID.
      if (r.$kind !== "Transaction" || !r.digest) {
        setErr("Create market failed on-chain (bad DEEP coin, expiry in past, or pool-creation budget exhausted).");
        setBusy(false);
        return;
      }
      const d = r.digest;
      setDigest(d);
      props.onSubmit(d);
    } catch (e) {
      setErr(friendlyAdminError(e, "Admin action"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Create market (admin escape hatch)">
      <div className="space-y-4">
        <p className="text-sm text-zinc-400">
          Manually create a new prediction market with its DeepBook pool.
          The primary path is the <code className="rounded bg-white/5 px-1 py-0.5 text-xs">MarketCreator</code>{" "}
          agent; use this card for one-off demos or to recover from a
          failed cron tick. Costs one DEEP coin (pool-creation fee) plus
          gas; the fee is non-refundable.
        </p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="space-y-1 text-xs text-zinc-400">
            Title
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Will BTC exceed $100k by Friday?"
              className="w-full rounded-md border border-white/10 bg-white/[0.04] px-3 py-1.5 text-sm text-white placeholder-zinc-600 focus:border-rose-400 focus:outline-none"
              disabled={props.disabled || busy}
            />
          </label>
          <label className="space-y-1 text-xs text-zinc-400">
            Resolution source
            <input
              type="text"
              value={resolutionSource}
              onChange={(e) => setResolutionSource(e.target.value)}
              placeholder="CoinGecko BTC/USD"
              className="w-full rounded-md border border-white/10 bg-white/[0.04] px-3 py-1.5 text-sm text-white placeholder-zinc-600 focus:border-rose-400 focus:outline-none"
              disabled={props.disabled || busy}
            />
          </label>
          <label className="space-y-1 text-xs text-zinc-400">
            Expiry (days from now)
            <input
              type="number"
              min="1"
              value={expiryDays}
              onChange={(e) => setExpiryDays(e.target.value)}
              className="w-full rounded-md border border-white/10 bg-white/[0.04] px-3 py-1.5 text-sm text-white focus:border-rose-400 focus:outline-none"
              disabled={props.disabled || busy}
            />
          </label>
          <label className="space-y-1 text-xs text-zinc-400">
            Category
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="w-full rounded-md border border-white/10 bg-white/[0.04] px-3 py-1.5 text-sm text-white focus:border-rose-400 focus:outline-none"
              disabled={props.disabled || busy}
            >
              <option value="0">General</option>
              <option value="1">AI</option>
              <option value="2">Crypto</option>
              <option value="3">Other</option>
            </select>
          </label>
          <label className="space-y-1 text-xs text-zinc-400 sm:col-span-2">
            DEEP coin object id (0x…64 hex)
            <input
              type="text"
              value={deepCoinId}
              onChange={(e) => setDeepCoinId(e.target.value)}
              placeholder="0x..."
              className="w-full rounded-md border border-white/10 bg-white/[0.04] px-3 py-1.5 font-mono text-xs text-white placeholder-zinc-600 focus:border-rose-400 focus:outline-none"
              disabled={props.disabled || busy}
            />
          </label>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={submit}
            disabled={props.disabled || busy || !title.trim() || !deepCoinId.trim()}
            className="rounded-md bg-gradient-to-r from-rose-500 to-amber-500 px-4 py-1.5 text-sm font-semibold text-white shadow-lg shadow-rose-500/20 transition hover:from-rose-400 hover:to-amber-400 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? "Submitting…" : "Create market"}
          </button>
        </div>
        {err && <p className="text-xs text-rose-400">{err}</p>}
        {digest && (
          <p className="break-all text-xs text-emerald-300">✓ {digest}</p>
        )}
      </div>
    </Card>
  );
}

// ============================================================
// Set parlay max payout cap
// ============================================================

function SetMaxPayoutBpsCard(props: {
  onSubmit: (digest: string) => void;
  dAppKit: ReturnType<typeof useDAppKit>;
  disabled: boolean;
}) {
  const [bps, setBps] = useState<string>(String(PARLAY_DEFAULT_MAX_BPS));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [digest, setDigest] = useState<string | null>(null);
  // R55 audit fix: see WithdrawFeesCard for the rationale.
  const client = useCurrentClient();

  // Mirror the on-chain guard: `new_max_bps >= BPS` (10_000). 50_000 =
  // 5x is the production default. We render the multiplier in x for
  // human readability but submit bps.
  //
  // R43 audit fix: hard-cap at 1_000_000 bps (100x). The on-chain
  // `set_max_payout_bps` itself has no upper bound — a typo of
  // `999_999_999` (9 digits, fits the regex) would be accepted by
  // the contract and would let a single leg-payout drain the pool
  // in one tx. Cap pre-flight so the operator gets a synchronous
  // error and the SDK never even builds the PTB. The 100x ceiling
  // matches the practical limit discussed in the original R7 audit.
  const parsedBps = Number(bps);
  const isValid =
    Number.isFinite(parsedBps) &&
    Number.isInteger(parsedBps) &&
    parsedBps >= 10_000 &&
    parsedBps <= 1_000_000;
  // The contract has no upper bound, but a 100x cap is a footgun:
  // a single bad tick can drain the pool. Surface a soft warning at
  // > 10x so the operator has to look at the input before clicking
  // through. The submit button stays enabled — this is a hint, not
  // a hard error.
  const isHigh = isValid && parsedBps > 100_000;

  async function submit() {
    setErr(null);
    setDigest(null);
    if (!client) {
      setErr("Wallet client not ready.");
      setBusy(false);
      return;
    }
    if (!PARLAY_POOL_ID) {
      setErr("NEXT_PUBLIC_PARLAY_POOL_ID not set.");
      return;
    }
    if (!isValid) {
      setErr(
        "Max payout must be an integer between 10_000 bps (1.0x) and 1_000_000 bps (100x).",
      );
      return;
    }
    setBusy(true);
    try {
      // The contract is generic over the pool's collateral type. The
      // production pool is `ParlayPool<dUSDC>`; the SDK hard-codes the
      // generic to DUSDC_TYPE on the parlay helpers, which matches the
      // pool bootstrap-parlay creates. If a non-dUSDC pool is ever
      // added the on-chain call would need a different type argument.
      //
      // R43 audit fix: trim the env value to match the R41 SDK
      // guard on DUSDC_PACKAGE_ID. A `.env` line with trailing
      // whitespace (common when a value is pasted from a docs
      // page) silently produces a type tag like
      // `<0x…::dusdc::DUSDC >` with a space, which Sui runtime
      // rejects with "type argument not found" on every set
      // call. Trim once at the read site so the type tag is
      // always well-formed.
      const dusdcPkgId = (process.env.NEXT_PUBLIC_DUSDC_PACKAGE_ID ?? "").trim();
      const tx = buildSetMaxPayoutBpsTx(
        PARLAY_POOL_ID,
        parsedBps,
        dusdcPkgId ? `${dusdcPkgId}::dusdc::DUSDC` : DUSDC_TYPE_FALLBACK,
      );
      // R55 audit fix: route through `submitAndWait` so the
      // post-write parlay-pool cap is observed. The
      // previous signAndExecuteTransaction returned
      // immediately; the /parlay page's
      // `readParlayMaxPayoutBps` refetch raced
      // on-chain finalization and a slow RPC could
      // briefly report the OLD cap.
      const r = await submitAndWait(props.dAppKit, client, tx);
      // R38 audit fix: $kind guard. The cap must be ≥ 10_000 bps
      // (1x); below that the move call aborts with EPayoutTooSmall.
      // A Failed return would previously update `max_payout_bps`
      // in the local cache (no — actually the cache is read-once
      // on mount) but more importantly the operator would see a
      // fake success and the bootstrap-parlay script's
      // read-then-write idempotency would then try to revert
      // to the env value on the next tick, causing oscillation.
      if (r.$kind !== "Transaction" || !r.digest) {
        setErr("Set parlay max payout failed on-chain (cap must be ≥ 10_000 bps and ≤ 1_000_000).");
        setBusy(false);
        return;
      }
      const d = r.digest;
      setDigest(d);
      props.onSubmit(d);
    } catch (e) {
      setErr(friendlyAdminError(e, "Admin action"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Set parlay max payout cap">
      <div className="space-y-4">
        <p className="text-sm text-zinc-400">
          Updates the on-chain
          <code className="mx-1 rounded bg-white/5 px-1 py-0.5 text-xs">max_payout_bps</code>
          cap used by
          <code className="mx-1 rounded bg-white/5 px-1 py-0.5 text-xs">parlay::create_parlay</code>.
          The new value must be <code className="mx-1 rounded bg-white/5 px-1 py-0.5 text-xs">{"≥ 10_000 bps"}</code> (1.0x) and applies to
          future parlays only — open parlays keep the cap they were
          created with. Default 50_000 = 5x.
        </p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Stat label="Pool" value={shortAddr(PARLAY_POOL_ID)} />
          <Stat
            label="Current (bps)"
            value={bps || "—"}
          />
          <Stat
            label="Multiplier"
            value={
              isValid ? `${(parsedBps / 10_000).toFixed(2)}x` : "—"
            }
          />
        </div>
        <label className="block space-y-1 text-xs text-zinc-400">
          New max payout (bps)
          <input
            type="number"
            min="10000"
            step="1000"
            value={bps}
            // R37 audit fix: keep the user's literal input on
            // the field (so the dev-tools numeric caret behaves
            // naturally) but skip any value that would break the
            // `tx.pure.u64` builder — `Number("")` is 0, `Number("1e10")`
            // is 10000000000, `Number("abc")` is NaN. The submit
            // button is already disabled on `!isValid`, so this
            // just surfaces the failure as a typed-but-not-accepted
            // number instead of a silent on-chain abort.
            onChange={(e) => {
              const v = e.target.value;
              if (v === "" || /^\d+$/.test(v)) {
                setBps(v);
              }
            }}
            className={`w-full rounded-md border bg-white/[0.04] px-3 py-1.5 font-mono text-sm text-white focus:outline-none ${
              isValid ? "border-white/10 focus:border-rose-400" : "border-rose-500/40"
            }`}
            disabled={props.disabled || busy}
          />
        </label>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={submit}
            disabled={props.disabled || busy || !isValid}
            className="rounded-md bg-gradient-to-r from-rose-500 to-amber-500 px-4 py-1.5 text-sm font-semibold text-white shadow-lg shadow-rose-500/20 transition hover:from-rose-400 hover:to-amber-400 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? "Submitting…" : "Set max payout"}
          </button>
          <Badge variant={isValid ? "success" : "warning"}>
            {isValid ? "valid" : "invalid"}
          </Badge>
        </div>
        {isHigh && (
          <p className="text-xs text-amber-400">
            Heads up: {(parsedBps / 10_000).toFixed(2)}x is well above the
            production default of 5x. A single bad tick could let one
            parlay drain a large share of the pool.
          </p>
        )}
        {err && <p className="text-xs text-rose-400">{err}</p>}
        {digest && (
          <p className="break-all text-xs text-emerald-300">✓ {digest}</p>
        )}
      </div>
    </Card>
  );
}

// Fallback used when NEXT_PUBLIC_DUSDC_PACKAGE_ID is not set in
// `apps/web/.env.local`. The production default in the SDK is the
// Mysten testnet dUSDC at 0xe9a73…a705. R35 audit fix: previously
// this local literal was a malformed 50-char hex
// (`0xe9a73ee16dabd84dad0a0638a8d4c7d5bf09b76f50a705a705::dusdc::DUSDC`)
// that the Sui runtime rejected on every move call. Use the SDK's
// `DUSDC_TYPE` constant (imported above) instead, which already
// resolves to the canonical 64-char hex on a fresh deploy.
const DUSDC_TYPE_FALLBACK = DUSDC_TYPE;

// Resolved once at module load. Used by every parlay admin card to
// pass the pool's generic type argument. Same fallback pattern as
// the SetMaxPayoutBpsCard above — the production pool is dUSDC.
//
// R50 audit fix: trim the env value. The previous version
// didn't `.trim()` — the sibling `dusdcPkgId` on line 1214
// does. A `.env` line with trailing whitespace produced a
// type tag like `0x…::dusdc::DUSDC ` (trailing space) and
// the Sui runtime aborted "type argument not found" on every
// parlay admin submit. Hoist a single trimmed module-level
// constant so every caller gets the same hygiene.
function dUSDCType(): string {
  const raw = (process.env.NEXT_PUBLIC_DUSDC_PACKAGE_ID ?? "").trim();
  return raw ? `${raw}::dusdc::DUSDC` : DUSDC_TYPE_FALLBACK;
}

// ============================================================
// Parlay admin (withdraw + rotate admin)
// ============================================================

function ParlayAdminCard(props: {
  onSubmit: (label: string, digest: string) => void;
  dAppKit: ReturnType<typeof useDAppKit>;
  disabled: boolean;
  // Live parlay pool balance in dUSDC base units, plus the current
  // admin address. Both are best-effort from the LiveStateCard
  // panel; the pre-flight checks below compare the operator's
  // inputs to the live values to fail fast instead of paying gas
  // for a tx the on-chain guards will reject.
  poolBalance?: bigint;
  currentAdmin?: string;
}) {
  const [withdrawAmount, setWithdrawAmount] = useState<string>("");
  const [newAdmin, setNewAdmin] = useState<string>("");
  const [busy, setBusy] = useState<null | "withdraw" | "rotate">(null);
  const [err, setErr] = useState<string | null>(null);
  const [digest, setDigest] = useState<string | null>(null);
  // R55 audit fix: see WithdrawFeesCard for the rationale.
  const client = useCurrentClient();

  const parsedAmount = Number(withdrawAmount);
  const isWithdrawValid =
    Number.isFinite(parsedAmount) &&
    Number.isInteger(parsedAmount) &&
    parsedAmount > 0;
  // Pre-flight: amount must be positive AND, if we have a live
  // balance, must not exceed it. Withdrawing more than the pool
  // holds would either revert on-chain or (worse) silently drain
  // funds earmarked for open parlays.
  const overBalance =
    isWithdrawValid &&
    props.poolBalance !== undefined &&
    BigInt(parsedAmount) > props.poolBalance;
  // Reject obvious non-address input up front. The Sui runtime
  // rejects malformed addresses anyway, but checking here gives a
  // friendlier error than a Move-abort stack trace.
  const trimmedNewAdmin = newAdmin.trim();
  const isRotateAddress = isValidSuiAddress(trimmedNewAdmin);
  // Catch the operator trying to rotate to themselves. The on-chain
  // call would succeed (it just rewrites the same address) but it's
  // a no-op that wastes gas; we surface it as a warning instead of
  // an error so the operator can confirm "yes, I really mean it".
  const isSameAsCurrent =
    isRotateAddress &&
    props.currentAdmin !== undefined &&
    trimmedNewAdmin.toLowerCase() === props.currentAdmin.toLowerCase();
  const isRotateValid = isRotateAddress && !isSameAsCurrent;

  async function submitWithdraw() {
    setErr(null);
    setDigest(null);
    if (!client) {
      setErr("Wallet client not ready.");
      setBusy(null);
      return;
    }
    if (!PARLAY_POOL_ID) {
      setErr("NEXT_PUBLIC_PARLAY_POOL_ID not set.");
      return;
    }
    if (!isWithdrawValid) {
      setErr("Withdraw amount must be a positive integer (base units of dUSDC).");
      return;
    }
    if (overBalance) {
      setErr(
        `Amount exceeds live parlay pool balance (${formatDusdc(
          props.poolBalance,
        )} DUSDC). Click Refresh and try a smaller amount.`,
      );
      return;
    }
    // R45 audit fix: confirm before submitting. The submit button
    // is a single click with no second-chance prompt — a
    // misclick (or an explorer/tab copy-paste of a stale value)
    // would withdraw the entire pool balance to the operator's
    // wallet and only the operator could put it back. Adding a
    // `window.confirm` with the human-readable amount + DUSDC
    // unit reduces the false-positive rate to near zero. The
    // R44 audit flagged the same gap on the disconnect button
    // and on the other admin cards (rotate, allocate, return);
    // see submitRotate, submitAllocate, submitReturn below for
    // the matching pattern.
    const humanAmount = formatDusdc(BigInt(parsedAmount));
    if (!window.confirm(
      `Withdraw ${humanAmount} DUSDC from the parlay pool to your connected wallet? ` +
        `This is irreversible on-chain.`,
    )) {
      return;
    }
    setBusy("withdraw");
    try {
      const tx = buildParlayAdminWithdrawTx(
        PARLAY_POOL_ID,
        parsedAmount,
        dUSDCType(),
      );
      // R55 audit fix: route through `submitAndWait` so the
      // post-withdraw pool-balance read sees a finalized
      // state. The previous signAndExecuteTransaction
      // returned immediately; the
      // readParlayPoolBalance refetch raced on-chain
      // finalization and briefly showed the pre-withdraw
      // balance.
      const r = await submitAndWait(props.dAppKit, client, tx);
      // R38 audit fix: $kind guard. Withdrawals can fail on
      // EInsufficientBalance, ENotAdmin, or EPoolHalted. The
      // previous "Parlay admin withdraw: unknown..." toast would
      // make the operator think funds left the pool when they
      // were actually still there — and the off-chain indexer
      // reconciliation would then double-count them on the next
      // pool-stats snapshot.
      if (r.$kind !== "Transaction" || !r.digest) {
        setErr("Parlay admin withdraw failed on-chain.");
        setBusy(null);
        return;
      }
      const d = r.digest;
      setDigest(d);
      props.onSubmit("Parlay admin withdraw", d);
    } catch (e) {
      setErr(friendlyAdminError(e, "Admin action"));
    } finally {
      setBusy(null);
    }
  }

  async function submitRotate() {
    setErr(null);
    setDigest(null);
    if (!client) {
      setErr("Wallet client not ready.");
      setBusy(null);
      return;
    }
    if (!PARLAY_POOL_ID) {
      setErr("NEXT_PUBLIC_PARLAY_POOL_ID not set.");
      return;
    }
    if (!isRotateValid) {
      setErr("New admin must be a 0x-prefixed 64-char hex address.");
      return;
    }
    // R45 audit fix: confirm before submitting. rotate_admin is
    // a one-way change — the new admin can immediately sweep
    // the pool with `admin_withdraw`, and there is no path back
    // to the prior admin (who would then see ENotAdmin on
    // every subsequent call). A misclick on the input (a
    // hand-paste of the wrong hex) would brick the operator's
    // own admin access. Show the truncated addresses in the
    // confirm prompt so a mis-typed value is visible.
    const oldAdminShort = props.currentAdmin
      ? `${props.currentAdmin.slice(0, 6)}…${props.currentAdmin.slice(-4)}`
      : "(unknown)";
    // R48 audit fix: trim the new admin before slicing the
    // shortened form shown in the confirm prompt. The previous
    // `newAdmin.slice(0, 6)` read the raw untrimmed input, so a
    // user who typed `"  0xABC…123  "` saw `0xABC…  123` (with
    // the leading whitespace in the start) which is misleading
    // when the operator is checking the on-chain rotation effect.
    const trimmedForPrompt = newAdmin.trim();
    const newAdminShort = `${trimmedForPrompt.slice(0, 6)}…${trimmedForPrompt.slice(-4)}`;
    if (!window.confirm(
      `Rotate parlay pool admin from ${oldAdminShort} to ${newAdminShort}? ` +
        `This is one-way — the new admin takes over immediately.`,
    )) {
      return;
    }
    setBusy("rotate");
    try {
      const tx = buildRotateParlayAdminTx(
        PARLAY_POOL_ID,
        newAdmin.trim(),
        dUSDCType(),
      );
      // R55 audit fix: same `submitAndWait` rationale as
      // the withdraw path above.
      const r = await submitAndWait(props.dAppKit, client, tx);
      // R38 audit fix: $kind guard. rotate_admin is one-way and
      // caller is the CURRENT admin. A Failed return (e.g.
      // address-is-zero abort) would previously look like a
      // success and the new admin's first call would then
      // bounce with ENotAdmin, leaving the pool in a state where
      // nobody could admin-withdraw.
      if (r.$kind !== "Transaction" || !r.digest) {
        setErr("Rotate parlay admin failed on-chain (new admin must be a non-zero address).");
        setBusy(null);
        return;
      }
      const d = r.digest;
      setDigest(d);
      props.onSubmit("Rotate parlay admin", d);
    } catch (e) {
      setErr(friendlyAdminError(e, "Admin action"));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card title="Parlay pool admin">
      <div className="space-y-6">
        <p className="text-sm text-zinc-400">
          Two admin-gated operations on the parlay pool. Both require
          the connected wallet to be
          <code className="mx-1 rounded bg-white/5 px-1 py-0.5 text-xs">pool.admin</code>
          (set at
          <code className="mx-1 rounded bg-white/5 px-1 py-0.5 text-xs">parlay::create_pool</code>
          time). Withdraw pulls dUSDC out of the pool; rotate moves
          admin authority to a new key (one-way — the new admin
          becomes the only address that can call admin functions).
        </p>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="block space-y-1 text-xs text-zinc-400">
            Withdraw amount (dUSDC base units)
            <input
              type="number"
              min="1"
              step="1"
              value={withdrawAmount}
              // R37 audit fix: same numeric filter as the bps
              // input above. Accept only empty or a non-negative
              // integer string; reject scientific notation and
              // junk so the user gets feedback in the field
              // instead of a `BigInt(NaN)` throw at submit time.
              onChange={(e) => {
                const v = e.target.value;
                if (v === "" || /^\d+$/.test(v)) {
                  setWithdrawAmount(v);
                }
              }}
              placeholder="1000000 (= 1 DUSDC)"
              className={`w-full rounded-md border bg-white/[0.04] px-3 py-1.5 font-mono text-sm text-white placeholder-zinc-600 focus:outline-none ${
                overBalance
                  ? "border-rose-500/60 focus:border-rose-400"
                  : isWithdrawValid
                    ? "border-white/10 focus:border-rose-400"
                    : "border-rose-500/40"
              }`}
              disabled={props.disabled || busy !== null}
            />
            {props.poolBalance !== undefined && (
              <span className="mt-1 block text-[10px] text-zinc-500">
                Pool balance: {formatDusdc(props.poolBalance)} DUSDC
              </span>
            )}
          </label>
          <div className="flex items-end">
            <button
              type="button"
              onClick={submitWithdraw}
              disabled={
                props.disabled || busy !== null || !isWithdrawValid || overBalance
              }
              className="rounded-md bg-gradient-to-r from-rose-500 to-amber-500 px-4 py-1.5 text-sm font-semibold text-white shadow-lg shadow-rose-500/20 transition hover:from-rose-400 hover:to-amber-400 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy === "withdraw" ? "Submitting…" : "Withdraw"}
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="block space-y-1 text-xs text-zinc-400">
            New admin address
            <input
              type="text"
              value={newAdmin}
              onChange={(e) => setNewAdmin(e.target.value)}
              placeholder="0x…"
              className={`w-full rounded-md border bg-white/[0.04] px-3 py-1.5 font-mono text-sm text-white placeholder-zinc-600 focus:outline-none ${
                isRotateValid
                  ? "border-white/10 focus:border-rose-400"
                  : "border-rose-500/40"
              }`}
              disabled={props.disabled || busy !== null}
            />
            {isSameAsCurrent && (
              <span className="mt-1 block text-[10px] text-amber-400">
                New admin is the same as the current admin — rotation would
                be a no-op.
              </span>
            )}
          </label>
          <div className="flex items-end">
            <button
              type="button"
              onClick={submitRotate}
              disabled={props.disabled || busy !== null || !isRotateValid}
              className="rounded-md bg-gradient-to-r from-rose-500 to-amber-500 px-4 py-1.5 text-sm font-semibold text-white shadow-lg shadow-rose-500/20 transition hover:from-rose-400 hover:to-amber-400 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy === "rotate" ? "Submitting…" : "Rotate admin"}
            </button>
          </div>
        </div>

        {err && <p className="text-xs text-rose-400">{err}</p>}
        {digest && (
          <p className="break-all text-xs text-emerald-300">✓ {digest}</p>
        )}
      </div>
    </Card>
  );
}

// ============================================================
// Protocol vault admin (allocate_for_mm / return_from_mm)
// ============================================================

function VaultAdminCard(props: {
  onSubmit: (label: string, digest: string) => void;
  dAppKit: ReturnType<typeof useDAppKit>;
  disabled: boolean;
  // Live protocol vault state. Both come from the LiveStateCard
  // panel; without them the on-chain calls would either revert
  // with EInsufficientAvailable (allocate) or just transfer value
  // out of the MM allocation (return). Surfaced as pre-flight
  // checks below.
  available?: bigint;
  allocated?: bigint;
}) {
  const [allocateAmount, setAllocateAmount] = useState<string>("");
  const [returnCoinId, setReturnCoinId] = useState<string>("");
  const [busy, setBusy] = useState<null | "allocate" | "return">(null);
  const [err, setErr] = useState<string | null>(null);
  const [digest, setDigest] = useState<string | null>(null);
  // R55 audit fix: see WithdrawFeesCard for the rationale.
  const client = useCurrentClient();

  const parsedAllocate = Number(allocateAmount);
  const isAllocateValid =
    Number.isFinite(parsedAllocate) &&
    Number.isInteger(parsedAllocate) &&
    parsedAllocate > 0;
  // Pre-flight: amount must be positive AND, if we have a live
  // available balance, must not exceed it. The on-chain guard
  // enforces this with EInsufficientAvailable, but the pre-check
  // saves gas and gives a clearer error message.
  const overAvailable =
    isAllocateValid &&
    props.available !== undefined &&
    BigInt(parsedAllocate) > props.available;
  // return_from_mm just needs a valid object id for the Coin to
  // deposit back into the vault. The on-chain guard rejects zero-
  // value coins with EZeroAmount; the Sui runtime will surface a
  // clear "coin not found" error for a bad id.
  //
  // R45 audit fix: also require the id be a syntactically valid
  // Sui object id (0x + 64 hex chars). A typo (truncation,
  // wrong chain, accidental 0X prefix) would otherwise burn
  // gas on a doomed PTB and surface as a cryptic
  // `invalid input object` move-abort — same class of bug R44
  // caught on the create-market and settings agent-address
  // forms. Use the same `isValidSuiAddress` helper.
  const isReturnValid =
    returnCoinId.trim().length > 0 && isValidSuiAddress(returnCoinId);

  async function submitAllocate() {
    setErr(null);
    setDigest(null);
    if (!client) {
      setErr("Wallet client not ready.");
      setBusy(null);
      return;
    }
    if (!VAULT_OBJECT_ID) {
      setErr("NEXT_PUBLIC_VAULT_OBJECT_ID not set.");
      return;
    }
    if (!isAllocateValid) {
      setErr("Allocate amount must be a positive integer (base units of dUSDC).");
      return;
    }
    if (overAvailable) {
      setErr(
        `Amount exceeds live available balance (${formatDusdc(
          props.available,
        )} DUSDC). Refresh Live state and try a smaller amount.`,
      );
      return;
    }
    // R45 audit fix: confirm before submitting. allocate_for_mm
    // moves DUSDC from `available` to `allocated` — the funds
    // stay on-chain but become unavailable for general
    // withdrawals until the MM returns them via `return_from_mm`.
    // A misclick on the input (e.g. transposed digits, leading
    // zero) would lock the wrong amount for the duration of the
    // MM session with no automatic recovery path. Show the
    // human-readable amount in the confirm prompt so a typo is
    // visible.
    if (!window.confirm(
      `Allocate ${formatDusdc(BigInt(parsedAllocate))} DUSDC from the vault to the market-maker? ` +
        `Funds stay in the vault's "allocated" balance until the MM returns them.`,
    )) {
      return;
    }
    setBusy("allocate");
    try {
      const tx = buildAllocateForMmTx(
        VAULT_OBJECT_ID,
        BigInt(parsedAllocate),
        dUSDCType(),
      );
      // R55 audit fix: route through `submitAndWait` so the
      // post-allocate vault-balance read sees a finalized
      // allocation. The previous
      // signAndExecuteTransaction returned immediately;
      // the readProtocolVaultAvailableBalance refetch
      // raced on-chain finalization and briefly showed
      // the pre-allocate available balance.
      const r = await submitAndWait(props.dAppKit, client, tx);
      // R38 audit fix: $kind guard. allocate_for_mm aborts with
      // EInsufficientAvailable on the available→allocated
      // transfer. A Failed return would previously show
      // "Allocate for MM: unknown..." and the MM agent would
      // then believe it had fresh capital to deploy, pulling
      // orders that the chain would reject one-by-one (more
      // RPC load per minute than the success path).
      if (r.$kind !== "Transaction" || !r.digest) {
        setErr("Allocate for MM failed on-chain (insufficient available balance, or non-admin caller).");
        setBusy(null);
        return;
      }
      const d = r.digest;
      setDigest(d);
      props.onSubmit("Allocate for MM", d);
    } catch (e) {
      setErr(friendlyAdminError(e, "Admin action"));
    } finally {
      setBusy(null);
    }
  }

  async function submitReturn() {
    setErr(null);
    setDigest(null);
    if (!client) {
      setErr("Wallet client not ready.");
      setBusy(null);
      return;
    }
    if (!VAULT_OBJECT_ID) {
      setErr("NEXT_PUBLIC_VAULT_OBJECT_ID not set.");
      return;
    }
    if (!isReturnValid) {
      // R45 audit fix: include the shape requirement in the
      // error message (the isValidSuiAddress check is new in
      // R45). Without this, a user who typed a malformed id
      // would see "Return coin object id is required" (the
      // old, less specific message) and be confused why an
      // empty-looking form is "required".
      setErr(
        "Return coin object id is required and must be a 0x + 64-char hex Sui object id.",
      );
      return;
    }
    // R45 audit fix: confirm before submitting. return_from_mm
    // deposits a Coin<dUSDC> into the vault — submitting the
    // wrong object id (e.g. a SUI coin, a different user's
    // dUSDC coin, or a `Coin<X>` for a different X) would
    // either fail with a move-abort or, worse, succeed and
    // credit the vault with a non-dUSDC asset. Show the
    // truncated id in the confirm prompt so a mis-paste is
    // visible.
    const coinShort = `${returnCoinId.slice(0, 6)}…${returnCoinId.slice(-4)}`;
    if (!window.confirm(
      `Return coin ${coinShort} to the vault (deposits the full balance)? ` +
        `Make sure this is a dUSDC coin owned by your connected wallet.`,
    )) {
      return;
    }
    setBusy("return");
    try {
      const tx = buildReturnFromMmTx(
        VAULT_OBJECT_ID,
        returnCoinId.trim(),
        dUSDCType(),
      );
      // R55 audit fix: same `submitAndWait` rationale as
      // the allocate path above.
      const r = await submitAndWait(props.dAppKit, client, tx);
      // R38 audit fix: $kind guard. return_from_mm aborts if the
      // Coin isn't a dUSDC coin (wrong type) or if the coin has
      // already been consumed by a previous return (object
      // version). The previous code would toast a fake success
      // and the operator's "available" balance would not
      // increase as expected — silently stranded capital.
      if (r.$kind !== "Transaction" || !r.digest) {
        setErr("Return from MM failed on-chain (wrong coin type, or coin already consumed).");
        setBusy(null);
        return;
      }
      const d = r.digest;
      setDigest(d);
      props.onSubmit("Return from MM", d);
    } catch (e) {
      setErr(friendlyAdminError(e, "Admin action"));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card title="Protocol vault admin">
      <div className="space-y-6">
        <p className="text-sm text-zinc-400">
          Two admin-gated operations on the protocol&apos;s
          <code className="mx-1 rounded bg-white/5 px-1 py-0.5 text-xs">ProtocolVault&lt;dUSDC&gt;</code>.
          Both require the connected wallet to be
          <code className="mx-1 rounded bg-white/5 px-1 py-0.5 text-xs">vault.admin</code>.
          Allocate moves dUSDC from the available balance to the
          <code className="mx-1 rounded bg-white/5 px-1 py-0.5 text-xs">allocated</code>
          reserve (for market-making); return moves a Coin back into
          the vault, increasing the available balance and decreasing
          the allocation. Open MM positions are unaffected.
        </p>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="block space-y-1 text-xs text-zinc-400">
            Allocate amount (dUSDC base units)
            <input
              type="number"
              min="1"
              step="1"
              value={allocateAmount}
              // R39 audit fix: mirror the R37 regex filter used
              // by the sibling withdraw input on the same page.
              // `allocateAmount` is the raw string, and a paste
              // of "abc" or "1.2.3" would land in state as-is
              // and then be coerced with `Number(allocateAmount)`
              // → NaN at submit time, throwing on the
              // BigInt round-trip. The withdraw input already
              // uses `.replace(/[^0-9.]/g, "")`; apply the same
              // here for consistency.
              //
              // R40 audit fix: the previous regex still
              // permitted "1.2.3" through (the dot-filter
              // doesn't reject multiple dots). `Number("1.2.3")`
              // is NaN, the submit button correctly disables on
              // `!isAllocateValid`, but the input briefly
              // displays the malformed text. The allocate
              // amount is an integer of micro-units (DUSDC has
              // 6 decimals), so drop the dot entirely and
              // allow only digits — matching the strict
              // `withdrawAmount` path.
              onChange={(e) => setAllocateAmount(e.target.value.replace(/[^0-9]/g, ""))}
              placeholder="1000000 (= 1 DUSDC)"
              className={`w-full rounded-md border bg-white/[0.04] px-3 py-1.5 font-mono text-sm text-white placeholder-zinc-600 focus:outline-none ${
                overAvailable
                  ? "border-rose-500/60 focus:border-rose-400"
                  : isAllocateValid
                    ? "border-white/10 focus:border-rose-400"
                    : "border-rose-500/40"
              }`}
              disabled={props.disabled || busy !== null}
            />
            {props.available !== undefined && (
              <span className="mt-1 block text-[10px] text-zinc-500">
                Available: {formatDusdc(props.available)} DUSDC
                {props.allocated !== undefined &&
                  ` · Allocated: ${formatDusdc(props.allocated)} DUSDC`}
              </span>
            )}
          </label>
          <div className="flex items-end">
            <button
              type="button"
              onClick={submitAllocate}
              disabled={
                props.disabled || busy !== null || !isAllocateValid || overAvailable
              }
              className="rounded-md bg-gradient-to-r from-rose-500 to-amber-500 px-4 py-1.5 text-sm font-semibold text-white shadow-lg shadow-rose-500/20 transition hover:from-rose-400 hover:to-amber-400 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy === "allocate" ? "Submitting…" : "Allocate for MM"}
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="block space-y-1 text-xs text-zinc-400">
            Return coin object id (0x… 64 hex)
            <input
              type="text"
              value={returnCoinId}
              onChange={(e) => setReturnCoinId(e.target.value)}
              placeholder="0x…"
              className={`w-full rounded-md border bg-white/[0.04] px-3 py-1.5 font-mono text-sm text-white placeholder-zinc-600 focus:outline-none ${
                isReturnValid
                  ? "border-white/10 focus:border-rose-400"
                  : "border-rose-500/40"
              }`}
              disabled={props.disabled || busy !== null}
            />
            {props.allocated !== undefined && (
              <span className="mt-1 block text-[10px] text-zinc-500">
                Returned amount must be ≤ Allocated ({formatDusdc(props.allocated)} DUSDC).
              </span>
            )}
          </label>
          <div className="flex items-end">
            <button
              type="button"
              onClick={submitReturn}
              disabled={props.disabled || busy !== null || !isReturnValid}
              className="rounded-md bg-gradient-to-r from-rose-500 to-amber-500 px-4 py-1.5 text-sm font-semibold text-white shadow-lg shadow-rose-500/20 transition hover:from-rose-400 hover:to-amber-400 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy === "return" ? "Submitting…" : "Return from MM"}
            </button>
          </div>
        </div>

        {err && <p className="text-xs text-rose-400">{err}</p>}
        {digest && (
          <p className="break-all text-xs text-emerald-300">✓ {digest}</p>
        )}
      </div>
    </Card>
  );
}
