"use client";

import {
  useCurrentAccount,
  useCurrentClient,
  useDAppKit,
} from "@mysten/dapp-kit-react";
import { Transaction } from "@mysten/sui/transactions";
import { useEffect, useState } from "react";
import {
  CLOCK_OBJECT_ID,
  DUSDC_TYPE,
  PLP_TYPE,
  PREDICT_OBJECT_ID,
  PREDICT_PACKAGE_ID,
  getVaultSummary,
  type VaultSummary,
} from "@suipredict/sdk";
import { Card, Stat } from "@/components/ui";

export default function VaultPage() {
  const account = useCurrentAccount();
  const client = useCurrentClient();
  const dAppKit = useDAppKit();
  const [vault, setVault] = useState<VaultSummary | null>(null);
  const [amount, setAmount] = useState(1);
  const [withdrawAmount, setWithdrawAmount] = useState(1);
  const [plpBalance, setPlpBalance] = useState(0);
  const [plpCoinId, setPlpCoinId] = useState("");
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(false);

  async function refreshVault() {
    const summary = await getVaultSummary();
    setVault(summary);
  }

  async function refreshPlp() {
    if (!account || !client) return;
    const { objects } = await client.core.listCoins({
      owner: account.address,
      coinType: PLP_TYPE,
    });
    const total = objects.reduce((s, c) => s + Number(c.balance), 0);
    setPlpBalance(total);
    setPlpCoinId(objects[0]?.objectId ?? "");
  }

  useEffect(() => {
    refreshVault().catch(console.error);
    const id = setInterval(() => refreshVault().catch(console.error), 10000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!account || !client) return;
    refreshPlp().catch(console.error);
  }, [account, client]);

  async function supplyPLP() {
    if (!account || !client) return;
    setLoading(true);
    setStatus("Supplying to PLP vault...");
    try {
      const tx = new Transaction();
      const supplyAmount = BigInt(amount) * BigInt(1_000_000);
      const coins = await client.core.listCoins({
        owner: account.address,
        coinType: DUSDC_TYPE,
      });
      if (coins.objects.length === 0) throw new Error("No dUSDC in wallet");
      const primary = tx.object(coins.objects[0]!.objectId);
      if (coins.objects.length > 1) {
        tx.mergeCoins(
          primary,
          coins.objects.slice(1).map((c) => tx.object(c.objectId)),
        );
      }
      const [supplyCoin] = tx.splitCoins(primary, [tx.pure.u64(supplyAmount)]);
      const lpCoin = tx.moveCall({
        target: `${PREDICT_PACKAGE_ID}::predict::supply`,
        typeArguments: [DUSDC_TYPE],
        arguments: [
          tx.object(PREDICT_OBJECT_ID),
          supplyCoin,
          tx.object(CLOCK_OBJECT_ID),
        ],
      });
      tx.transferObjects([lpCoin], tx.pure.address(account.address));
      const result = await dAppKit.signAndExecuteTransaction({ transaction: tx });
      const digest =
        result.$kind === "Transaction"
          ? result.Transaction.digest
          : "unknown";
      setStatus(`Supplied $${amount} dUSDC. Tx: ${digest.slice(0, 16)}...`);
      await Promise.all([refreshVault(), refreshPlp()]);
    } catch (e) {
      setStatus(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoading(false);
    }
  }

  async function withdrawPLP() {
    if (!account || !client || !plpCoinId) return;
    setLoading(true);
    setStatus("Withdrawing from PLP vault...");
    try {
      const tx = new Transaction();
      const withdrawAmt = BigInt(withdrawAmount) * BigInt(1_000_000);
      const plpCoin = tx.object(plpCoinId);
      const [splitCoin] = tx.splitCoins(plpCoin, [tx.pure.u64(withdrawAmt)]);
      tx.moveCall({
        target: `${PREDICT_PACKAGE_ID}::predict::withdraw`,
        typeArguments: [DUSDC_TYPE],
        arguments: [
          tx.object(PREDICT_OBJECT_ID),
          splitCoin,
          tx.object(CLOCK_OBJECT_ID),
        ],
      });
      tx.transferObjects([plpCoin], tx.pure.address(account.address));
      const result = await dAppKit.signAndExecuteTransaction({ transaction: tx });
      const digest =
        result.$kind === "Transaction"
          ? result.Transaction.digest
          : "unknown";
      setStatus(`Withdrew $${withdrawAmount} dUSDC. Tx: ${digest.slice(0, 16)}...`);
      await Promise.all([refreshVault(), refreshPlp()]);
    } catch (e) {
      setStatus(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-transparent bg-clip-text bg-gradient-to-r from-white to-cyan-200">PLP Vault</h1>
        <p className="mt-2 text-zinc-400">
          Supply dUSDC to earn PLP liquidity provider shares
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card className="border-emerald-500/20 bg-emerald-500/5 shadow-[0_0_15px_rgba(16,185,129,0.05)]">
          <Stat
            label="Vault Value"
            value={
              vault
                ? `$${(vault.vault_value / 1e6).toLocaleString(undefined, { maximumFractionDigits: 0 })}`
                : "—"
            }
          />
        </Card>
        <Card className="border-cyan-500/20 bg-cyan-500/5 shadow-[0_0_15px_rgba(6,182,212,0.05)]">
          <Stat
            label="Utilization"
            value={
              vault ? `${((vault.utilization ?? 0) * 100).toFixed(2)}%` : "—"
            }
          />
        </Card>
        <Card className="border-blue-500/20 bg-blue-500/5 shadow-[0_0_15px_rgba(59,130,246,0.05)]">
          <Stat
            label="PLP Supply"
            value={
              vault
                ? `$${(vault.plp_supply / 1e6).toLocaleString(undefined, { maximumFractionDigits: 0 })}`
                : "—"
            }
          />
        </Card>
        <Card className="border-violet-500/20 bg-violet-500/5 shadow-[0_0_15px_rgba(139,92,246,0.05)]">
          <Stat
            label="Your PLP"
            value={
              account
                ? `$${(plpBalance / 1e6).toLocaleString(undefined, { maximumFractionDigits: 2 })}`
                : "—"
            }
          />
        </Card>
      </div>

      <Card title="Supply Liquidity" className="border-white/10">
        {!account ? (
          <p className="text-zinc-400">Connect wallet to supply</p>
        ) : (
          <div className="flex flex-wrap items-end gap-4 mt-2">
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-1.5">Amount (dUSDC)</label>
              <input
                type="number"
                min={1}
                className="mt-1 block w-32 rounded-lg border border-white/10 bg-black/20 px-3 py-2.5 text-sm text-white focus:border-cyan-500/50 focus:outline-none transition-colors"
                value={amount}
                onChange={(e) => setAmount(Number(e.target.value))}
              />
            </div>
            <button
              onClick={supplyPLP}
              disabled={loading}
              className="rounded-lg bg-gradient-to-r from-violet-600 to-cyan-600 px-6 py-2.5 text-sm font-semibold text-white shadow-lg shadow-cyan-900/30 transition-all hover:scale-[1.02] hover:shadow-cyan-900/50 disabled:opacity-50 disabled:scale-100"
            >
              {loading ? "Supplying..." : "Supply PLP"}
            </button>
          </div>
        )}
      </Card>

      <Card title="Withdraw Liquidity" className="border-white/10">
        {!account ? (
          <p className="text-zinc-400">Connect wallet to withdraw</p>
        ) : !plpCoinId ? (
          <p className="text-zinc-400">No PLP tokens in wallet</p>
        ) : (
          <div className="flex flex-wrap items-end gap-4 mt-2">
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-1.5">Withdraw (dUSDC face)</label>
              <input
                type="number"
                min={1}
                className="mt-1 block w-32 rounded-lg border border-white/10 bg-black/20 px-3 py-2.5 text-sm text-white focus:border-cyan-500/50 focus:outline-none transition-colors"
                value={withdrawAmount}
                onChange={(e) => setWithdrawAmount(Number(e.target.value))}
              />
            </div>
            <button
              onClick={withdrawPLP}
              disabled={loading}
              className="rounded-lg border border-white/10 bg-white/5 px-6 py-2.5 text-sm font-medium text-white transition-all hover:bg-white/10 hover:border-white/20 disabled:opacity-50"
            >
              {loading ? "Withdrawing..." : "Withdraw PLP"}
            </button>
          </div>
        )}
      </Card>

      {status && (
        <div className="rounded-lg border border-white/10 bg-black/20 p-4 backdrop-blur-sm inline-block">
          <p className="text-xs font-mono text-cyan-400">{status}</p>
        </div>
      )}
    </div>
  );
}
