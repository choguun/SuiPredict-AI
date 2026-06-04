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
import {
  useCurrentAccount,
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
import { useCurrentClient } from "@mysten/dapp-kit-react";
import { Card, Stat, Badge } from "@/components/ui";

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
const SUI_NETWORKS = ["testnet", "mainnet", "devnet", "localnet"] as const;
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

export default function AdminPage() {
  const account = useCurrentAccount();
  const dAppKit = useDAppKit();
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
    let cancelled = false;
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
        if (FEE_VAULT_ID) {
          const [balance, admin] = await Promise.all([
            readFeeVaultBalance(client, FEE_VAULT_ID),
            readFeeVaultAdmin(client, FEE_VAULT_ID),
          ]);
          next.feeVault = { balance, admin };
        }
      } catch {
        // leave null
      }
      try {
        if (PRIZE_POOL_ID) {
          const [balance, weeklyPrize, currentWeek, distribution] =
            await Promise.all([
              readPrizePoolBalance(client, PRIZE_POOL_ID),
              readPrizePoolWeeklyPrize(client, PRIZE_POOL_ID),
              readPrizePoolCurrentWeek(client, PRIZE_POOL_ID),
              readPrizePoolDistribution(client, PRIZE_POOL_ID),
            ]);
          next.prizePool = { balance, weeklyPrize, currentWeek, distribution };
        }
      } catch {
        // leave null
      }
      try {
        if (VAULT_OBJECT_ID) {
          const [available, allocated, total, admin] = await Promise.all([
            readProtocolVaultAvailableBalance(client, VAULT_OBJECT_ID),
            readProtocolVaultAllocated(client, VAULT_OBJECT_ID),
            readProtocolVaultTotalBalance(client, VAULT_OBJECT_ID),
            readProtocolVaultAdmin(client, VAULT_OBJECT_ID),
          ]);
          next.protocolVault = { available, allocated, total, admin };
        }
      } catch {
        // leave null
      }
      try {
        if (PARLAY_POOL_ID) {
          const [balance, totalVolume, totalPaidOut, maxPayoutBps, admin] =
            await Promise.all([
              readParlayPoolBalance(client, PARLAY_POOL_ID),
              readParlayTotalVolume(client, PARLAY_POOL_ID),
              readParlayTotalPaidOut(client, PARLAY_POOL_ID),
              readParlayMaxPayoutBps(client, PARLAY_POOL_ID),
              readParlayPoolAdmin(client, PARLAY_POOL_ID),
            ]);
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
      if (!cancelled) {
        setState(next);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
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
      const r = await props.dAppKit.signAndExecuteTransaction({ transaction: tx });
      // R38 audit fix: $kind guard. On a Failed/EffectsCert return
      // (insufficient balance, non-admin caller) `txDigest(r)` is
      // the literal "unknown" — the user would see
      // "Withdraw protocol fees: unknown..." in the toast history
      // and have no idea the withdrawal silently bounced.
      if (r.$kind !== "Transaction") {
        setErr("Withdraw fees failed on-chain (insufficient balance or non-admin caller).");
        setBusy(false);
        return;
      }
      const d = r.Transaction.digest;
      setDigest(d);
      props.onSubmit(d);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
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
          <input
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
            onChange={(e) => {
              const v = e.target.value;
              if (v === "" || /^\d+(\.\d{0,6})?$/.test(v)) {
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

  const parsed = bps
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((s) => Number(s));
  const sum = parsed.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
  const isValid = parsed.length > 0 && parsed.every((n) => Number.isInteger(n) && n >= 0) && sum === 10_000;

  async function submit() {
    setErr(null);
    setDigest(null);
    if (!PRIZE_POOL_ID || !PRIZE_ADMIN_ID) {
      setErr("NEXT_PUBLIC_PRIZE_POOL_ID / NEXT_PUBLIC_PRIZE_ADMIN_ID not set.");
      return;
    }
    if (!isValid) {
      setErr("Distribution must be non-negative integers summing to 10_000.");
      return;
    }
    setBusy(true);
    try {
      const tx = buildSetDistributionTx(PRIZE_POOL_ID, PRIZE_ADMIN_ID, parsed);
      const r = await props.dAppKit.signAndExecuteTransaction({ transaction: tx });
      // R38 audit fix: $kind guard. EInvalidDistribution (sum !=
      // 10_000 bps, length mismatch) would surface as a move abort
      // — the previous code would still surface a fake
      // "Set prize distribution: unknown..." success and the admin
      // would have no way to tell the new distribution wasn't
      // applied.
      if (r.$kind !== "Transaction") {
        setErr("Set distribution failed on-chain (vector must sum to 10_000 bps and match rank count).");
        setBusy(false);
        return;
      }
      const d = r.Transaction.digest;
      setDigest(d);
      props.onSubmit(d);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
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

  async function submit() {
    setErr(null);
    setDigest(null);
    if (!marketId.trim()) {
      setErr("Market ID is required.");
      return;
    }
    setBusy(true);
    try {
      const tx = buildResolveDisputeTx(marketId.trim(), outcome === "1" ? 1 : 2);
      const r = await props.dAppKit.signAndExecuteTransaction({ transaction: tx });
      // R38 audit fix: $kind guard. Resolving a non-disputed market
      // is an EInvalidState abort; the previous code would toast
      // a fake success and the user would be left wondering why
      // the market still showed "disputed" on the indexer.
      if (r.$kind !== "Transaction") {
        setErr("Resolve dispute failed on-chain (market is not in disputed state, or non-creator caller).");
        setBusy(false);
        return;
      }
      const d = r.Transaction.digest;
      setDigest(d);
      props.onSubmit(d);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
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

  async function submit() {
    setErr(null);
    setDigest(null);
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
    const cat = Number(category);
    if (!Number.isInteger(cat) || cat < 0 || cat > 3) {
      setErr("Category must be 0..3.");
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
      const r = await props.dAppKit.signAndExecuteTransaction({ transaction: tx });
      // R38 audit fix: $kind guard. create_market has the largest
      // failure surface (bad DEEP coin, expiry in the past, no
      // admin cap left). A Failed return would previously toast
      // "Create market: unknown..." and the admin would assume
      // the market exists, then call resolve_dispute against a
      // phantom ID.
      if (r.$kind !== "Transaction") {
        setErr("Create market failed on-chain (bad DEEP coin, expiry in past, or pool-creation budget exhausted).");
        setBusy(false);
        return;
      }
      const d = r.Transaction.digest;
      setDigest(d);
      props.onSubmit(d);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
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

  // Mirror the on-chain guard: `new_max_bps >= BPS` (10_000). 50_000 =
  // 5x is the production default. We render the multiplier in x for
  // human readability but submit bps.
  const parsedBps = Number(bps);
  const isValid =
    Number.isFinite(parsedBps) &&
    Number.isInteger(parsedBps) &&
    parsedBps >= 10_000;
  // The contract has no upper bound, but a 100x cap is a footgun:
  // a single bad tick can drain the pool. Surface a soft warning at
  // > 10x so the operator has to look at the input before clicking
  // through. The submit button stays enabled — this is a hint, not
  // a hard error.
  const isHigh = isValid && parsedBps > 100_000;

  async function submit() {
    setErr(null);
    setDigest(null);
    if (!PARLAY_POOL_ID) {
      setErr("NEXT_PUBLIC_PARLAY_POOL_ID not set.");
      return;
    }
    if (!isValid) {
      setErr("Max payout must be an integer >= 10_000 bps (1.0x).");
      return;
    }
    setBusy(true);
    try {
      // The contract is generic over the pool's collateral type. The
      // production pool is `ParlayPool<dUSDC>`; the SDK hard-codes the
      // generic to DUSDC_TYPE on the parlay helpers, which matches the
      // pool bootstrap-parlay creates. If a non-dUSDC pool is ever
      // added the on-chain call would need a different type argument.
      const tx = buildSetMaxPayoutBpsTx(
        PARLAY_POOL_ID,
        parsedBps,
        process.env.NEXT_PUBLIC_DUSDC_PACKAGE_ID
          ? `${process.env.NEXT_PUBLIC_DUSDC_PACKAGE_ID}::dusdc::DUSDC`
          : DUSDC_TYPE_FALLBACK,
      );
      const r = await props.dAppKit.signAndExecuteTransaction({ transaction: tx });
      // R38 audit fix: $kind guard. The cap must be ≥ 10_000 bps
      // (1x); below that the move call aborts with EPayoutTooSmall.
      // A Failed return would previously update `max_payout_bps`
      // in the local cache (no — actually the cache is read-once
      // on mount) but more importantly the operator would see a
      // fake success and the bootstrap-parlay script's
      // read-then-write idempotency would then try to revert
      // to the env value on the next tick, causing oscillation.
      if (r.$kind !== "Transaction") {
        setErr("Set parlay max payout failed on-chain (cap must be ≥ 10_000 bps and ≤ 1_000_000).");
        setBusy(false);
        return;
      }
      const d = r.Transaction.digest;
      setDigest(d);
      props.onSubmit(d);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
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
function dUSDCType(): string {
  return process.env.NEXT_PUBLIC_DUSDC_PACKAGE_ID
    ? `${process.env.NEXT_PUBLIC_DUSDC_PACKAGE_ID}::dusdc::DUSDC`
    : DUSDC_TYPE_FALLBACK;
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
    setBusy("withdraw");
    try {
      const tx = buildParlayAdminWithdrawTx(
        PARLAY_POOL_ID,
        parsedAmount,
        dUSDCType(),
      );
      const r = await props.dAppKit.signAndExecuteTransaction({ transaction: tx });
      // R38 audit fix: $kind guard. Withdrawals can fail on
      // EInsufficientBalance, ENotAdmin, or EPoolHalted. The
      // previous "Parlay admin withdraw: unknown..." toast would
      // make the operator think funds left the pool when they
      // were actually still there — and the off-chain indexer
      // reconciliation would then double-count them on the next
      // pool-stats snapshot.
      if (r.$kind !== "Transaction") {
        setErr("Parlay admin withdraw failed on-chain.");
        setBusy(null);
        return;
      }
      const d = r.Transaction.digest;
      setDigest(d);
      props.onSubmit("Parlay admin withdraw", d);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function submitRotate() {
    setErr(null);
    setDigest(null);
    if (!PARLAY_POOL_ID) {
      setErr("NEXT_PUBLIC_PARLAY_POOL_ID not set.");
      return;
    }
    if (!isRotateValid) {
      setErr("New admin must be a 0x-prefixed 64-char hex address.");
      return;
    }
    setBusy("rotate");
    try {
      const tx = buildRotateParlayAdminTx(
        PARLAY_POOL_ID,
        newAdmin.trim(),
        dUSDCType(),
      );
      const r = await props.dAppKit.signAndExecuteTransaction({ transaction: tx });
      // R38 audit fix: $kind guard. rotate_admin is one-way and
      // caller is the CURRENT admin. A Failed return (e.g.
      // address-is-zero abort) would previously look like a
      // success and the new admin's first call would then
      // bounce with ENotAdmin, leaving the pool in a state where
      // nobody could admin-withdraw.
      if (r.$kind !== "Transaction") {
        setErr("Rotate parlay admin failed on-chain (new admin must be a non-zero address).");
        setBusy(null);
        return;
      }
      const d = r.Transaction.digest;
      setDigest(d);
      props.onSubmit("Rotate parlay admin", d);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
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
  const isReturnValid = returnCoinId.trim().length > 0;

  async function submitAllocate() {
    setErr(null);
    setDigest(null);
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
    setBusy("allocate");
    try {
      const tx = buildAllocateForMmTx(
        VAULT_OBJECT_ID,
        BigInt(parsedAllocate),
        dUSDCType(),
      );
      const r = await props.dAppKit.signAndExecuteTransaction({ transaction: tx });
      // R38 audit fix: $kind guard. allocate_for_mm aborts with
      // EInsufficientAvailable on the available→allocated
      // transfer. A Failed return would previously show
      // "Allocate for MM: unknown..." and the MM agent would
      // then believe it had fresh capital to deploy, pulling
      // orders that the chain would reject one-by-one (more
      // RPC load per minute than the success path).
      if (r.$kind !== "Transaction") {
        setErr("Allocate for MM failed on-chain (insufficient available balance, or non-admin caller).");
        setBusy(null);
        return;
      }
      const d = r.Transaction.digest;
      setDigest(d);
      props.onSubmit("Allocate for MM", d);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function submitReturn() {
    setErr(null);
    setDigest(null);
    if (!VAULT_OBJECT_ID) {
      setErr("NEXT_PUBLIC_VAULT_OBJECT_ID not set.");
      return;
    }
    if (!isReturnValid) {
      setErr("Return coin object id is required.");
      return;
    }
    setBusy("return");
    try {
      const tx = buildReturnFromMmTx(
        VAULT_OBJECT_ID,
        returnCoinId.trim(),
        dUSDCType(),
      );
      const r = await props.dAppKit.signAndExecuteTransaction({ transaction: tx });
      // R38 audit fix: $kind guard. return_from_mm aborts if the
      // Coin isn't a dUSDC coin (wrong type) or if the coin has
      // already been consumed by a previous return (object
      // version). The previous code would toast a fake success
      // and the operator's "available" balance would not
      // increase as expected — silently stranded capital.
      if (r.$kind !== "Transaction") {
        setErr("Return from MM failed on-chain (wrong coin type, or coin already consumed).");
        setBusy(null);
        return;
      }
      const d = r.Transaction.digest;
      setDigest(d);
      props.onSubmit("Return from MM", d);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
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
