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
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    getVaultSummary()
      .then(setVault)
      .catch(console.error);
    const id = setInterval(() => {
      getVaultSummary().then(setVault).catch(console.error);
    }, 10000);
    return () => clearInterval(id);
  }, []);

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
      getVaultSummary().then(setVault);
    } catch (e) {
      setStatus(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">PLP Vault</h1>
        <p className="text-zinc-400">
          Supply dUSDC to earn PLP liquidity provider shares
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <Stat
            label="Vault Value"
            value={
              vault
                ? `$${(vault.vault_value / 1e6).toLocaleString(undefined, { maximumFractionDigits: 0 })}`
                : "—"
            }
          />
        </Card>
        <Card>
          <Stat
            label="Utilization"
            value={
              vault ? `${((vault.utilization ?? 0) * 100).toFixed(1)}%` : "—"
            }
          />
        </Card>
        <Card>
          <Stat
            label="PLP Supply"
            value={
              vault
                ? `$${(vault.plp_supply / 1e6).toLocaleString(undefined, { maximumFractionDigits: 0 })}`
                : "—"
            }
          />
        </Card>
      </div>

      <Card title="Supply Liquidity">
        {!account ? (
          <p className="text-zinc-400">Connect wallet to supply</p>
        ) : (
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label className="text-xs text-zinc-500">Amount (dUSDC)</label>
              <input
                type="number"
                min={1}
                className="mt-1 block w-32 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm"
                value={amount}
                onChange={(e) => setAmount(Number(e.target.value))}
              />
            </div>
            <button
              onClick={supplyPLP}
              disabled={loading}
              className="rounded-lg bg-cyan-500 px-5 py-2 text-sm font-medium text-zinc-950 hover:bg-cyan-400 disabled:opacity-50"
            >
              {loading ? "Supplying..." : "Supply PLP"}
            </button>
          </div>
        )}
        {status && (
          <p className="mt-3 text-xs font-mono text-zinc-400">{status}</p>
        )}
      </Card>
    </div>
  );
}
