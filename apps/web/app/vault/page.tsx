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
  getVaultSummaryClob,
  VLP_TYPE,
} from "@suipredict/sdk";
import { Card, Stat } from "@/components/ui";
import { EmptyState } from "@/components/EmptyState";
import { toast } from "sonner";

function txDigest(r: { $kind: string; Transaction?: { digest: string } }): string {
  return r.$kind === "Transaction" ? r.Transaction!.digest : "unknown";
}

const VAULT_ID = process.env.NEXT_PUBLIC_VAULT_OBJECT_ID;
const DBUSDC =
  "0xf7152c05930480cd740d7311b5b8b45c6f488e3a53a11c3f74a6fac36a52e0d7::DBUSDC::DBUSDC";

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
    if (!account || !client || !VAULT_ID) {
      toast.error("Set NEXT_PUBLIC_VAULT_OBJECT_ID for on-chain vault");
      return;
    }
    setLoading(true);
    const toastId = toast.loading("Depositing...");
    try {
      const { objects } = await client.core.listCoins({
        owner: account.address,
        coinType: DBUSDC,
      });
      const coin = objects[0];
      if (!coin) throw new Error("No DBUSDC");
      const tx = buildVaultDepositTx(
        VAULT_ID,
        coin.objectId,
        account.address,
      );
      const r = await dAppKit.signAndExecuteTransaction({ transaction: tx });
      toast.success(`Deposited: ${txDigest(r).slice(0, 16)}…`, { id: toastId });
      setRefreshCounter(c => c + 1);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Deposit failed", { id: toastId });
    } finally {
      setLoading(false);
    }
  }

  async function withdraw() {
    if (!account || !VAULT_ID || !vlpCoinId) return;
    setLoading(true);
    const toastId = toast.loading("Withdrawing...");
    try {
      const tx = buildVaultWithdrawTx(VAULT_ID, vlpCoinId);
      const r = await dAppKit.signAndExecuteTransaction({ transaction: tx });
      toast.success(`Withdrawn: ${txDigest(r).slice(0, 16)}…`, { id: toastId });
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
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-transparent bg-clip-text bg-gradient-to-r from-white to-cyan-200">Vault (VLP)</h1>
        <p className="mt-2 text-zinc-400">
          Deposit DBUSDC to earn VLP shares. Agents allocate vault capital for
          CLOB market making.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Card className="border-emerald-500/20 bg-emerald-500/5 shadow-[0_0_15px_rgba(16,185,129,0.05)]">
          <Stat
            label="TVL"
            value={`$${(total / 1e6).toLocaleString(undefined, { maximumFractionDigits: 2 })}`}
          />
        </Card>
        <Card className="border-cyan-500/20 bg-cyan-500/5 shadow-[0_0_15px_rgba(6,182,212,0.05)]">
          <Stat
            label="Allocated to MM"
            value={`$${(allocated / 1e6).toLocaleString(undefined, { maximumFractionDigits: 2 })}`}
          />
        </Card>
        <Card className="border-violet-500/20 bg-violet-500/5 shadow-[0_0_15px_rgba(139,92,246,0.05)]">
          <Stat
            label="Your VLP"
            value={`${(vlpBalance / 1e6).toFixed(4)}`}
          />
        </Card>
      </div>

      <Card title="Deposit / Withdraw DBUSDC" className="border-white/10">
        <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-1.5 mt-2">Amount (USDC)</label>
        <input
          type="number"
          min="1"
          value={amount}
          onChange={(e) => setAmount(Number(e.target.value))}
          className="block w-full max-w-xs rounded-lg border border-white/10 bg-black/20 px-3 py-2.5 mb-5 text-sm text-white focus:border-cyan-500/50 focus:outline-none transition-colors"
        />
        <div className="flex gap-3">
          <button
            type="button"
            disabled={loading || !account}
            onClick={deposit}
            className="rounded-lg bg-gradient-to-r from-violet-600 to-cyan-600 px-6 py-2.5 text-sm font-semibold text-white shadow-lg shadow-cyan-900/30 transition-all hover:scale-[1.02] hover:shadow-cyan-900/50 disabled:opacity-50 disabled:scale-100"
          >
            Deposit
          </button>
          <button
            type="button"
            disabled={loading || !account || !vlpCoinId}
            onClick={withdraw}
            className="rounded-lg border border-white/10 bg-white/5 px-6 py-2.5 text-sm font-medium text-white transition-all hover:bg-white/10 hover:border-white/20 disabled:opacity-50"
          >
            Withdraw
          </button>
        </div>
        {!VAULT_ID && (
          <div className="mt-4 rounded-lg border border-amber-500/20 bg-amber-500/10 p-3">
            <p className="text-xs text-amber-400/90">
              Demo mode: indexer shows simulated TVL. Deploy vault and set
              NEXT_PUBLIC_VAULT_OBJECT_ID for live deposits.
            </p>
          </div>
        )}
      </Card>
    </div>
  );
}
