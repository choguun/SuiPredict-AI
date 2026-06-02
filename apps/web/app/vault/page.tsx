"use client";

import {
  useCurrentAccount,
  useCurrentClient,
  useDAppKit,
} from "@mysten/dapp-kit-react";
import { useEffect, useState } from "react";
import {
  buildVaultDepositTx,
  buildVaultWithdrawTx,
  DUSDC_TYPE,
  getVaultSummaryClob,
  VLP_TYPE,
} from "@suipredict/sdk";
import { Card, Stat } from "@/components/ui";
import { EmptyState } from "@/components/EmptyState";
import { toast } from "sonner";

function txDigest(r: { $kind: string; Transaction?: { digest: string } }): string {
  return r.$kind === "Transaction" ? r.Transaction!.digest : "unknown";
}

const VAULT_ID = process.env.NEXT_PUBLIC_VAULT_OBJECT_ID ?? "";

export default function VaultPage() {
  const account = useCurrentAccount();
  const client = useCurrentClient();
  const dAppKit = useDAppKit();
  const [summary, setSummary] = useState<{
    vault_id: string;
    total_balance: number;
    allocated: number;
    available?: number;
  } | null>(null);
  const [amount, setAmount] = useState(10);
  const [vlpBalance, setVlpBalance] = useState(0);
  const [vlpCoinId, setVlpCoinId] = useState("");
  const [loading, setLoading] = useState(false);
  const [refreshCounter, setRefreshCounter] = useState(0);

  async function refresh() {
    const s = await getVaultSummaryClob();
    setSummary({ ...s, available: s.total_balance - s.allocated });
  }

  useEffect(() => {
    refresh().catch(console.error);
    const t = setInterval(() => refresh().catch(console.error), 10_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!account || !client) return;
    client.core
      .listCoins({ owner: account.address, coinType: VLP_TYPE })
      .then(({ objects }) => {
        setVlpBalance(objects.reduce((s, c) => s + Number(c.balance), 0));
        setVlpCoinId(objects[0]?.objectId ?? "");
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
      const { objects } = await client.core.listCoins({
        owner: account.address,
        coinType: DUSDC_TYPE,
      });
      const coin = objects[0];
      if (!coin) throw new Error("No DUSDC");
      const tx = buildVaultDepositTx(
        VAULT_ID,
        coin.objectId,
        DUSDC_TYPE,
        account.address,
      );
      const r = await dAppKit.signAndExecuteTransaction({ transaction: tx });
      // $kind guard: avoid toasting a fake "Deposited: unknown" on
      // Failed / EffectsCert results. The string "unknown" was a label
      // for non-Transaction results — never a real digest.
      if (r.$kind !== "Transaction") {
        toast.error("Deposit failed", { id: toastId });
        return;
      }
      toast.success(`Deposited: ${r.Transaction.digest.slice(0, 16)}…`, { id: toastId });
      setRefreshCounter(c => c + 1);
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
      const tx = buildVaultWithdrawTx(VAULT_ID, vlpCoinId);
      const r = await dAppKit.signAndExecuteTransaction({ transaction: tx });
      // Same $kind guard as deposit: surface a real error for Failed
      // / EffectsCert variants instead of a "Withdrawn: unknown" toast.
      if (r.$kind !== "Transaction") {
        toast.error("Withdraw failed", { id: toastId });
        return;
      }
      toast.success(`Withdrawn: ${r.Transaction.digest.slice(0, 16)}…`, { id: toastId });
      setRefreshCounter(c => c + 1);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Withdraw failed", { id: toastId });
    } finally {
      setLoading(false);
    }
  }

  const total = summary?.total_balance ?? 0;
  const allocated = summary?.allocated ?? 0;

  if (!account) {
    return (
      <EmptyState
        title="Wallet Disconnected"
        description="Connect your Sui wallet to view and manage your vault allocations."
      />
    );
  }

  return (
    <div className="space-y-6 sm:space-y-8">
      {/* Header Section */}
      <div className="relative overflow-hidden rounded-3xl border border-white/10 bg-[#11141d] p-6 sm:p-10 shadow-2xl shadow-black/40">
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

      {/* Stats Section */}
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="group relative overflow-hidden rounded-2xl border border-emerald-500/20 bg-[#11141d] p-6 shadow-xl shadow-black/40 transition-all hover:-translate-y-1 hover:border-emerald-500/40 hover:shadow-[0_0_30px_rgba(16,185,129,0.15)]">
          <div className="absolute inset-0 bg-gradient-to-b from-emerald-500/5 to-transparent pointer-events-none" />
          <div className="relative z-10">
            <Stat
              label="Total Value Locked"
              value={`$${(total / 1e6).toLocaleString(undefined, { maximumFractionDigits: 2 })}`}
            />
          </div>
        </div>
        <div className="group relative overflow-hidden rounded-2xl border border-cyan-500/20 bg-[#11141d] p-6 shadow-xl shadow-black/40 transition-all hover:-translate-y-1 hover:border-cyan-500/40 hover:shadow-[0_0_30px_rgba(6,182,212,0.15)]">
          <div className="absolute inset-0 bg-gradient-to-b from-cyan-500/5 to-transparent pointer-events-none" />
          <div className="relative z-10">
            <Stat
              label="Allocated to MM"
              value={`$${(allocated / 1e6).toLocaleString(undefined, { maximumFractionDigits: 2 })}`}
            />
          </div>
        </div>
        <div className="group relative overflow-hidden rounded-2xl border border-violet-500/20 bg-[#11141d] p-6 shadow-xl shadow-black/40 transition-all hover:-translate-y-1 hover:border-violet-500/40 hover:shadow-[0_0_30px_rgba(139,92,246,0.15)]">
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
        <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-2 mt-2">Amount (DUSDC)</label>
        <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4 mb-6">
          <input
            type="number"
            min="1"
            value={amount}
            onChange={(e) => setAmount(Number(e.target.value))}
            className="w-full sm:w-64 rounded-xl border border-white/10 bg-black/20 px-4 py-3 text-sm text-white focus:border-cyan-500/50 focus:outline-none focus:ring-1 focus:ring-cyan-500/50 transition-all"
          />
          <div className="flex w-full sm:w-auto gap-3">
            <button
              type="button"
              disabled={loading || !account || !VAULT_ID}
              onClick={deposit}
              className="flex-1 sm:flex-none rounded-xl bg-gradient-to-r from-emerald-500 to-teal-400 px-8 py-3 text-sm font-bold text-white shadow-lg shadow-emerald-900/30 transition-all hover:scale-[1.02] hover:shadow-emerald-900/50 disabled:opacity-50 disabled:scale-100"
            >
              Deposit
            </button>
            <button
              type="button"
              disabled={loading || !account || !vlpCoinId || !VAULT_ID}
              onClick={withdraw}
              className="flex-1 sm:flex-none rounded-xl border border-white/10 bg-white/5 px-8 py-3 text-sm font-bold text-white backdrop-blur-md transition-all hover:bg-white/10 hover:border-white/20 disabled:opacity-50"
            >
              Withdraw
            </button>
          </div>
        </div>
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
