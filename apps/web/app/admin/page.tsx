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
  FEE_VAULT_ID,
} from "@suipredict/sdk";
import { Card, Stat, Badge } from "@/components/ui";

const PRIZE_POOL_ID = process.env.NEXT_PUBLIC_PRIZE_POOL_ID ?? "";
const PRIZE_ADMIN_ID = process.env.NEXT_PUBLIC_PRIZE_ADMIN_ID ?? "";
const ADMIN_ADDRESS = process.env.NEXT_PUBLIC_ADMIN_ADDRESS ?? "";

// SuiVision is the canonical Sui explorer; the per-network subdomain
// matches the value in `process.env.NEXT_PUBLIC_SUI_NETWORK` (the
// same env the agents use). Mainnet, testnet, and devnet are the only
// three SuiVision indexes — `localnet` and unknown values fall back to
// the testnet URL, which is the most likely to actually resolve for
// dev machines.
const SUI_NETWORK = (process.env.NEXT_PUBLIC_SUI_NETWORK ?? "testnet") as
  | "testnet"
  | "mainnet"
  | "devnet"
  | "localnet";
const SUIVISION_TX_URL = `https://${SUI_NETWORK}.suivision.xyz/txblock/`;

function txDigest(r: { $kind: string; Transaction?: { digest: string } }): string {
  return r.$kind === "Transaction" ? r.Transaction!.digest : "submitted";
}

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
  const isValidAdmin = /^0x[0-9a-f]{64}$/.test(normalizedAdmin);
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
  }, [ADMIN_ADDRESS, isValidAdmin]);

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

      <WithdrawFeesCard
        onSubmit={(d) => setLastAction({ label: "Withdraw fees", digest: d })}
        dAppKit={dAppKit}
        disabled={!walletConnected || !isAdmin}
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
    </div>
  );
}

// ============================================================
// Withdraw fees
// ============================================================

function WithdrawFeesCard(props: {
  onSubmit: (digest: string) => void;
  dAppKit: ReturnType<typeof useDAppKit>;
  disabled: boolean;
}) {
  const [amountDusdc, setAmountDusdc] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [digest, setDigest] = useState<string | null>(null);

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
    setBusy(true);
    try {
      const tx = buildWithdrawFeesTx(FEE_VAULT_ID, amount);
      const r = await props.dAppKit.signAndExecuteTransaction({ transaction: tx });
      const d = txDigest(r);
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
          <Stat label="Amount" value={amountDusdc ? `${amountDusdc} DUSDC` : "—"} />
        </div>
        <div className="flex gap-2">
          <input
            type="number"
            step="0.000001"
            min="0"
            placeholder="0.0"
            value={amountDusdc}
            onChange={(e) => setAmountDusdc(e.target.value)}
            className="w-40 rounded-md border border-white/10 bg-white/[0.04] px-3 py-1.5 text-sm text-white placeholder-zinc-600 focus:border-rose-400 focus:outline-none"
            disabled={props.disabled || busy}
          />
          <button
            type="button"
            onClick={submit}
            disabled={props.disabled || busy || !amountDusdc}
            className="rounded-md bg-gradient-to-r from-rose-500 to-amber-500 px-4 py-1.5 text-sm font-semibold text-white shadow-lg shadow-rose-500/20 transition hover:from-rose-400 hover:to-amber-400 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? "Submitting…" : "Withdraw"}
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
      const d = txDigest(r);
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
      const d = txDigest(r);
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
