"use client";

import {
  useCurrentAccount,
  useCurrentClient,
  useDAppKit,
} from "@mysten/dapp-kit-react";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import {
  buildVaultDepositTx,
  buildVaultWithdrawTx,
  DUSDC_TYPE,
  getVaultSummaryClob,
  normalizeObjectId,
  VLP_TYPE,
} from "@suipredict/sdk";
import { Card, Stat } from "@/components/ui";
import { EmptyState, openConnectModal } from "@/components/EmptyState";
import { clampNumberString } from "@/lib/forms";
import { submitAndWait } from "@/lib/dapp-kit";
import { toast } from "sonner";

const VAULT_ID = process.env.NEXT_PUBLIC_VAULT_OBJECT_ID ?? "";

// R62 audit fix: per-page "How the vault
// works" callout. Page-scoped localStorage
// (no per-market id). Mounted-ref guard
// avoids a flash of the callout for users
// who already dismissed it on a previous
// visit.
const VAULT_HOW_IT_WORKS_KEY = "suipredict.vault.howItWorks.dismissed";
function readVaultHowItWorksDismissed(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(VAULT_HOW_IT_WORKS_KEY) === "1";
  } catch {
    return false;
  }
}
function dismissVaultHowItWorks(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(VAULT_HOW_IT_WORKS_KEY, "1");
  } catch {
    /* private mode etc. */
  }
}
function HowItWorksCallout() {
  const [mounted, setMounted] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    setMounted(true);
    setDismissed(readVaultHowItWorksDismissed());
  }, []);
  if (!mounted || dismissed) return null;
  return (
    <div className="rounded-2xl border border-cyan-500/20 bg-cyan-500/5 p-4 sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-bold text-cyan-200">How the vault works</h3>
          <p className="mt-1 text-xs text-cyan-300/80">
            Deposit DUSDC, earn a share of the agents&apos; market-making yield. Withdraw any time.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            dismissVaultHowItWorks();
            setDismissed(true);
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
            Deposit
          </div>
          <p className="mt-1 text-cyan-200/80">
            Mint VLP shares 1-for-1 with DUSDC. VLP is a transferable receipt of your vault stake.
          </p>
        </li>
        <li className="rounded-lg border border-cyan-500/15 bg-panel p-3">
          <div className="flex items-center gap-2 text-cyan-300 font-bold">
            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-cyan-500/20 text-[10px]">2</span>
            Earn
          </div>
          <p className="mt-1 text-cyan-200/80">
            Agents quote bid/ask spreads on the CLOB. The spread profit flows back to the vault pro-rata.
          </p>
        </li>
        <li className="rounded-lg border border-cyan-500/15 bg-panel p-3">
          <div className="flex items-center gap-2 text-cyan-300 font-bold">
            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-cyan-500/20 text-[10px]">3</span>
            Withdraw
          </div>
          <p className="mt-1 text-cyan-200/80">
            Burn VLP to receive your proportional DUSDC. No lock-up, no penalty for withdrawing.
          </p>
        </li>
      </ol>
    </div>
  );
}

export default function VaultPage() {
  const account = useCurrentAccount();
  const client = useCurrentClient();
  const dAppKit = useDAppKit();
  const queryClient = useQueryClient();
  // R56.9 audit fix: the `VaultSummaryClob` type now uses
  // `string` (bigint-as-string) for the three balance
  // fields. The local mirror here matches. The arithmetic
  // `s.total_balance - s.allocated` is done in BigInt and
  // re-stringified so the display formatter doesn't lose
  // precision above 2^53 - 1.
  //
  // R57.L1 audit fix: drop the unused `available` field.
  // `refresh()` (line 80) computed
  // `(total_balance - allocated).toString()` and stuffed it
  // into `summary.available`, but the JSX only reads
  // `total` and `allocated`. The field was dead state that
  // triggered an extra re-render on every refresh.
  const [summary, setSummary] = useState<{
    vault_id: string;
    total_balance: string;
    allocated: string;
  } | null>(null);
  const [amount, setAmount] = useState(10);
  const [vlpBalance, setVlpBalance] = useState(0);
  const [vlpCoinId, setVlpCoinId] = useState("");
  const [loading, setLoading] = useState(false);
  const [refreshCounter, setRefreshCounter] = useState(0);

  // R49 audit fix: a vault deposit/withdraw changes the user's
  // free DUSDC balance and (for a deposit) the position-indexer
  // mirrors a `VaultDeposited` row into the `positions` table.
  // Without invalidating the portfolio + markets list queries
  // the home page subtitle ("X active markets") and the
  // /portfolio positions stay stale for up to 60s after the user
  // returns from this page. Mirrors the
  // `DailyPredictionCard.tsx:198-206` pattern.
  const invalidateCrossPageCaches = useCallback(() => {
    if (!account?.address) return;
    // R51 audit fix: also invalidate the streak
    // queries. A vault deposit / withdraw advances
    // the user's daily streak (the agents
    // `streak-sweeper` keys off "did the user do
    // anything today" and a vault tx is one of the
    // signals) so the home-page streak badge and
    // the `/profile` page need to refresh too.
    // R50 added marketsList / portfolio; the
    // streak layer was missed.
    void queryClient.invalidateQueries({ queryKey: ["marketsList"], type: "active" });
    void queryClient.invalidateQueries({ queryKey: ["portfolio", account.address], type: "active" });
    void queryClient.invalidateQueries({ queryKey: ["userStreakId"], type: "active" });
    void queryClient.invalidateQueries({ queryKey: ["streakInfo"], type: "active" });
  }, [queryClient, account?.address]);

  async function refresh() {
    const s = await getVaultSummaryClob();
    setSummary({
      vault_id: s.vault_id,
      total_balance: s.total_balance,
      allocated: s.allocated,
    });
  }

  useEffect(() => {
    // R57.L7 audit fix: gate the in-flight `refresh()` with a
    // `cancelled` flag so an unmount between
    // `await getVaultSummaryClob()` and `setSummary(...)`
    // doesn't fire a setState-after-unmount warning. The
    // setInterval cleanup only stops the next tick; the
    // in-flight fetch needs the same pattern.
    let cancelled = false;
    const safeRefresh = () => {
      if (cancelled) return;
      refresh().catch(console.error);
    };
    safeRefresh();
    // R42 audit fix: skip the 10s refresh when the tab is
    // backgrounded. A 1h+ backgrounded tab would otherwise
    // fire 360 `getVaultSummaryClob` calls on resume; gating
    // on `document.visibilityState === "visible"` drops the
    // resume burst to a single initial fetch when the user
    // switches back. The initial `refresh()` above is not
    // gated so the first paint after mount always sees data.
    //
    // R56.15 audit fix: skip the next 30s of ticks after
    // a `refresh()` failure. A 5xx storm on
    // `getVaultSummaryClob` would otherwise keep
    // hammering the agents endpoint every 10s, filling
    // the agents log with retries. The same backoff
    // pattern was applied to the agents page in R45.
    let backoffUntil = 0;
    const t = setInterval(() => {
      if (cancelled) return;
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      if (Date.now() < backoffUntil) return;
      refresh().catch((err) => {
        console.error("getVaultSummaryClob failed, backing off 30s:", err);
        backoffUntil = Date.now() + 30_000;
      });
    }, 10_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  useEffect(() => {
    if (!account || !client) return;
    // R51 audit fix: normalize the owner
    // address. `listCoins` is case-sensitive
    // on the wire — a mixed-case Enoki
    // zkLogin session would otherwise
    // silently return `{ objects: [] }`,
    // leaving `vlpBalance` at 0 and
    // `vlpCoinId` empty. The "No VLP
    // coin to withdraw" toast would
    // then fire even when the user
    // holds VLP from a prior deposit.
    client.core
      .listCoins({
        owner: normalizeObjectId(account.address),
        coinType: VLP_TYPE,
        // R53 audit fix: bump default
        // 50-coin page to 100. The
        // "Withdraw" button's pre-flight
        // guard `if (!vlpCoinId)` is
        // tied to this effect's result.
        limit: 100,
      })
      .then(({ objects }) => {
        // R58.M6 audit fix: accumulate in BigInt
        // before coercing to number. The previous
        // `s + Number(c.balance)` lost precision
        // for sums above 2^53 - 1. Today's wallets
        // are nowhere near that (a 9 PB VLP
        // position), but the fix is a 1-line
        // change and removes a silent-corruption
        // trap for an admin user whose test
        // account is seeded with a multi-billion
        // VLP balance.
        const totalAtoms = objects.reduce(
          (s, c) => s + BigInt(c.balance),
          BigInt(0),
        );
        setVlpBalance(Number(totalAtoms));
        // R56.2 audit fix: sort the VLP-coin list by balance
        // and pick the largest. The withdraw handler passes
        // `vlpCoinId` to `buildVaultWithdrawTx` → `tx.object(...)`
        // and the on-chain `vault::withdraw` consumes the
        // whole input coin — a user with 5 VLP coins (typical
        // after several deposits) would withdraw from the
        // smallest, which on the withdraw path triggers
        // `EInsufficientBalance` for any withdraw > smallest-
        // coin-balance. R53 raised the page-size limit to 100
        // but missed the largest-coin sort.
        const sortedVlp = [...objects].sort((a, b) =>
          BigInt(b.balance) > BigInt(a.balance) ? 1 : -1,
        );
        setVlpCoinId(sortedVlp[0]?.objectId ?? "");
      })
      .catch(() => {});
  }, [account, client, refreshCounter]);

  async function deposit() {
    if (!account || !client) {
      toast.error("Connect a wallet to deposit");
      return;
    }
    if (!VAULT_ID) {
      toast.error("Set NEXT_PUBLIC_VAULT_OBJECT_ID for on-chain vault");
      return;
    }
    setLoading(true);
    const toastId = toast.loading("Depositing...");
    try {
      // R51 audit fix: normalize the owner
      // address. `listCoins` is case-sensitive
      // on the wire — a mixed-case Enoki
      // zkLogin session would otherwise
      // silently return `{ objects: [] }`
      // and the "No DUSDC" branch would
      // fire even when the user holds
      // DUSDC from a faucet or prior
      // redeem.
      const { objects } = await client.core.listCoins({
        owner: normalizeObjectId(account.address),
        coinType: DUSDC_TYPE,
        // R53 audit fix: bump default
        // 50-coin page to 100, and
        // pick the largest coin. A
        // dust-heavy user was getting
        // `objects[0]` (likely a tiny
        // dust coin), the PTB would
        // then try to split more than
        // the chosen coin held, and
        // the chain would abort
        // opaquely.
        limit: 100,
      });
      const sorted = [...objects].sort((a, b) =>
        BigInt(b.balance) > BigInt(a.balance) ? 1 : -1,
      );
      const coin = sorted[0];
      if (!coin) throw new Error("No DUSDC");
      // R38 audit fix: pass the user-supplied `amount` (in dUSDC
      // units) converted to base atoms so the builder splits that
      // much off the source coin. The previous call would have
      // drained the entire DUSDC coin regardless of the amount
      // field, leaving the user with an empty wallet after every
      // deposit.
      const amountAtoms = BigInt(Math.round(amount * 1_000_000));
      if (amountAtoms <= BigInt(0)) {
        throw new Error("Amount must be > 0 DUSDC");
      }
      const tx = buildVaultDepositTx(
        VAULT_ID,
        coin.objectId,
        amountAtoms,
        DUSDC_TYPE,
        account.address,
      );
      // R55 audit fix: route through `submitAndWait` so the
      // `setRefreshCounter` + `invalidateCrossPageCaches`
      // refetches hit a node that has already finalized the
      // deposit. The previous signAndExecuteTransaction
      // returned immediately after signing and the position-
      // indexer's "VaultDeposited" event was not yet visible
      // to the React Query refetch — a 1-2s window where the
      // user's VLP balance was still 0.
      const r = await submitAndWait(dAppKit, client, tx);
      // $kind guard: avoid toasting a fake "Deposited: unknown" on
      // Failed / EffectsCert results. The string "unknown" was a label
      // for non-Transaction results — never a real digest.
      if (r.$kind !== "Transaction" || !r.digest) {
        toast.error("Deposit failed", { id: toastId });
        return;
      }
      toast.success(`Deposited: ${r.digest.slice(0, 16)}…`, { id: toastId });
      setRefreshCounter(c => c + 1);
      invalidateCrossPageCaches();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Deposit failed", { id: toastId });
    } finally {
      setLoading(false);
    }
  }

  async function withdraw() {
    if (!account) {
      toast.error("Connect a wallet to withdraw");
      return;
    }
    if (!VAULT_ID) {
      toast.error("Set NEXT_PUBLIC_VAULT_OBJECT_ID for on-chain vault");
      return;
    }
    if (!vlpCoinId) {
      toast.error("No VLP coin to withdraw — deposit first or wait for indexer");
      return;
    }
    setLoading(true);
    const toastId = toast.loading("Withdrawing...");
    try {
      // R55 audit fix: same `submitAndWait` rationale as
      // the deposit path above. The signAndExecuteTransaction
      // return-before-finalize race left the "Withdrawn"
      // toast pointing at a VLP balance the indexer hadn't
      // seen the VaultWithdrawn event for yet.
      const tx = buildVaultWithdrawTx(VAULT_ID, vlpCoinId);
      const r = await submitAndWait(dAppKit, client, tx);
      // Same $kind guard as deposit: surface a real error for Failed
      // / EffectsCert variants instead of a "Withdrawn: unknown" toast.
      if (r.$kind !== "Transaction" || !r.digest) {
        toast.error("Withdraw failed", { id: toastId });
        return;
      }
      toast.success(`Withdrawn: ${r.digest.slice(0, 16)}…`, { id: toastId });
      setRefreshCounter(c => c + 1);
      invalidateCrossPageCaches();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Withdraw failed", { id: toastId });
    } finally {
      setLoading(false);
    }
  }

  const total = Number(summary?.total_balance ?? 0);
  const allocated = Number(summary?.allocated ?? 0);

  if (!account) {
    return (
      <div className="space-y-6 sm:space-y-8">
        <div>
          <h1 className="text-3xl font-extrabold tracking-tight text-transparent bg-clip-text bg-gradient-to-r from-white to-cyan-200 sm:text-5xl mb-2">
            Liquidity Vault
          </h1>
          <p className="text-zinc-400">
            Deposit DUSDC to earn yield from autonomous market-making agents.
          </p>
        </div>
        <EmptyState
          icon="vault"
          title="Wallet Disconnected"
          description="Connect your Sui wallet to view and manage your vault allocations. Your deposit powers the autonomous market-making agents that earn the protocol's spread."
          actionLabel="Connect Wallet"
          onAction={openConnectModal}
          previews={[
            "Deposit DUSDC → mint VLP at the current share price",
            "Agents market-make across all CLOB markets",
            "Realized yield from maker fees, rebated to VLP holders",
            "Withdraw burns VLP for the proportional DUSDC",
          ]}
        />
      </div>
    );
  }

  return (
    <div className="space-y-6 sm:space-y-8">
      {/* Header Section */}
      <div className="relative overflow-hidden rounded-3xl border border-white/10 bg-panel-strong p-6 sm:p-10 shadow-2xl shadow-black/40">
        <div className="absolute -top-40 -right-40 h-[400px] w-[400px] rounded-full bg-cyan-600/10 blur-[80px] pointer-events-none" />
        <div className="absolute -bottom-40 -left-40 h-[400px] w-[400px] rounded-full bg-violet-600/10 blur-[80px] pointer-events-none" />

        <div className="relative z-10">
          <h1 className="text-3xl font-extrabold tracking-tight text-transparent bg-clip-text bg-gradient-to-r from-white to-cyan-200 sm:text-5xl mb-4">
            Liquidity Vault
          </h1>
          <p className="max-w-2xl text-base leading-relaxed text-zinc-400">
            Deposit DUSDC to mint VLP shares. Your capital is actively managed by SuiPredict&apos;s
            autonomous AI agents to provide liquidity (CLOB market making) across prediction markets.
          </p>
        </div>
      </div>

      {/* R62 audit fix: dismissible "How the
         vault works" callout for first-time
         users. The previous build dropped the
         user straight into the deposit form
         with no context for what VLP is or
         where the yield comes from. The
         callout explains (a) deposit DUSDC
         mints VLP at the current share price,
         (b) agents market-make and earn fees
         that flow back to VLP holders, (c)
         withdraw burns VLP for the
         proportional DUSDC. Dismissed-once
         via localStorage (mounted-ref guard
         to avoid SSR/CSR flash; same R61
         pattern the markets/[id] page
         uses). */}
      <HowItWorksCallout />

      {/* Stats Section */}
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="group relative overflow-hidden rounded-2xl border border-emerald-500/20 bg-panel-strong p-6 shadow-xl shadow-black/40 transition-all hover:-translate-y-1 hover:border-emerald-500/40 hover:shadow-[0_0_30px_rgba(16,185,129,0.15)]">
          <div className="absolute inset-0 bg-gradient-to-b from-emerald-500/5 to-transparent pointer-events-none" />
          <div className="relative z-10">
            <Stat
              label="Total Value Locked"
              value={`$${(total / 1e6).toLocaleString(undefined, { maximumFractionDigits: 2 })}`}
            />
          </div>
        </div>
        <div className="group relative overflow-hidden rounded-2xl border border-cyan-500/20 bg-panel-strong p-6 shadow-xl shadow-black/40 transition-all hover:-translate-y-1 hover:border-cyan-500/40 hover:shadow-[0_0_30px_rgba(6,182,212,0.15)]">
          <div className="absolute inset-0 bg-gradient-to-b from-cyan-500/5 to-transparent pointer-events-none" />
          <div className="relative z-10">
            <Stat
              label="Allocated to MM"
              value={`$${(allocated / 1e6).toLocaleString(undefined, { maximumFractionDigits: 2 })}`}
            />
          </div>
        </div>
        <div className="group relative overflow-hidden rounded-2xl border border-violet-500/20 bg-panel-strong p-6 shadow-xl shadow-black/40 transition-all hover:-translate-y-1 hover:border-violet-500/40 hover:shadow-[0_0_30px_rgba(139,92,246,0.15)]">
          <div className="absolute inset-0 bg-gradient-to-b from-violet-500/5 to-transparent pointer-events-none" />
          <div className="relative z-10">
            <Stat
              label="Your VLP Balance"
              value={`${(vlpBalance / 1e6).toFixed(4)}`}
            />
          </div>
        </div>
      </div>

      {/* Action Section */}
      <Card title="Manage Position" className="max-w-2xl border-white/10">
        <label htmlFor="vault-amount" className="block text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-2 mt-2">Amount (DUSDC)</label>
        <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4 mb-6">
          <input
            id="vault-amount"
            type="number"
            min="1"
            value={amount}
            aria-invalid={amount <= 0}
            // R39 audit fix: route through clampNumberString so a
            // paste of "abc", "1.2.3", "1e10", or "-5" can't land
            // `amount` in NaN. The `deposit` handler immediately
            // does `BigInt(Math.round(amount * 1_000_000))` which
            // throws `TypeError: Cannot mix BigInt and other
            // types` on NaN — caught by the try/catch but toasted
            // as a generic "Deposit failed" with no actionable
            // detail. R37 added this pattern to the legacy
            // `legacy/predict/vault` page but missed the new
            // top-level vault page.
            onChange={(e) => setAmount(clampNumberString(e.target.value, 1, 1, 1_000_000))}
            className={`w-full sm:w-64 rounded-xl border bg-black/20 px-4 py-3 text-sm text-white focus:outline-none focus:ring-1 transition-all ${
              amount <= 0
                ? "border-rose-500/50 focus:border-rose-500/70 focus:ring-rose-500/40"
                : "border-white/10 focus:border-cyan-500/50 focus:ring-cyan-500/50"
            }`}
          />
          <div className="flex w-full sm:w-auto gap-3">
            <button
              type="button"
              disabled={loading || !account || !VAULT_ID || amount <= 0}
              onClick={deposit}
              className="flex-1 sm:flex-none rounded-xl bg-gradient-to-r from-emerald-500 to-teal-400 px-8 py-3 text-sm font-bold text-white shadow-lg shadow-emerald-900/30 transition-all hover:scale-[1.02] hover:shadow-emerald-900/50 disabled:opacity-50 disabled:scale-100 disabled:cursor-not-allowed"
            >
              Deposit
            </button>
            <button
              type="button"
              disabled={loading || !account || !vlpCoinId || !VAULT_ID || amount <= 0}
              onClick={withdraw}
              className="flex-1 sm:flex-none rounded-xl border border-white/10 bg-white/5 px-8 py-3 text-sm font-bold text-white backdrop-blur-md transition-all hover:bg-white/10 hover:border-white/20 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Withdraw
            </button>
          </div>
        </div>
        {amount <= 0 && (
          <p className="-mt-4 mb-4 text-xs text-rose-300">
            Enter an amount greater than 0 DUSDC.
          </p>
        )}
        {!VAULT_ID && (
          <div className="rounded-xl border border-amber-500/20 bg-amber-500/10 p-4">
            <p className="text-sm font-medium text-amber-400/90 flex items-center gap-2">
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              Demo mode
            </p>
            <p className="mt-1 text-xs leading-5 text-amber-400/80">
              The indexer shows simulated TVL. Deploy the vault contract and set NEXT_PUBLIC_VAULT_OBJECT_ID for live deposits.
            </p>
          </div>
        )}
      </Card>
    </div>
  );
}
