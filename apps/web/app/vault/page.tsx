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
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(false);

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
  }, [account, client, status]);

  async function deposit() {
    if (!account || !client || !VAULT_ID) {
      setStatus("Set NEXT_PUBLIC_VAULT_OBJECT_ID for on-chain vault");
      return;
    }
    setLoading(true);
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
      setStatus(`Deposited: ${txDigest(r).slice(0, 16)}…`);
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "Deposit failed");
    } finally {
      setLoading(false);
    }
  }

  async function withdraw() {
    if (!account || !VAULT_ID || !vlpCoinId) return;
    setLoading(true);
    try {
      const tx = buildVaultWithdrawTx(VAULT_ID, vlpCoinId);
      const r = await dAppKit.signAndExecuteTransaction({ transaction: tx });
      setStatus(`Withdrawn: ${txDigest(r).slice(0, 16)}…`);
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "Withdraw failed");
    } finally {
      setLoading(false);
    }
  }

  const total = summary?.total_balance ?? 0;
  const allocated = summary?.allocated ?? 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Vault (VLP)</h1>
        <p className="text-zinc-400">
          Deposit DBUSDC to earn VLP shares. Agents allocate vault capital for
          CLOB market making.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <Stat
            label="TVL"
            value={`$${(total / 1e6).toLocaleString(undefined, { maximumFractionDigits: 2 })}`}
          />
        </Card>
        <Card>
          <Stat
            label="Allocated to MM"
            value={`$${(allocated / 1e6).toLocaleString(undefined, { maximumFractionDigits: 2 })}`}
          />
        </Card>
        <Card>
          <Stat
            label="Your VLP"
            value={`${(vlpBalance / 1e6).toFixed(4)}`}
          />
        </Card>
      </div>

      <Card title="Deposit / Withdraw DBUSDC">
        <label className="text-xs text-zinc-500">Amount (USDC)</label>
        <input
          type="number"
          min="1"
          value={amount}
          onChange={(e) => setAmount(Number(e.target.value))}
          className="mt-1 w-full max-w-xs rounded-lg bg-zinc-800 px-3 py-2 mb-4"
        />
        <div className="flex gap-3">
          <button
            type="button"
            disabled={loading || !account}
            onClick={deposit}
            className="rounded-lg bg-cyan-500 px-5 py-2 text-sm font-medium text-zinc-950"
          >
            Deposit
          </button>
          <button
            type="button"
            disabled={loading || !account || !vlpCoinId}
            onClick={withdraw}
            className="rounded-lg border border-zinc-700 px-5 py-2 text-sm"
          >
            Withdraw
          </button>
        </div>
        {!VAULT_ID && (
          <p className="mt-3 text-xs text-amber-400/90">
            Demo mode: indexer shows simulated TVL. Deploy vault and set
            NEXT_PUBLIC_VAULT_OBJECT_ID for live deposits.
          </p>
        )}
        {status && <p className="mt-3 text-sm text-zinc-400 font-mono">{status}</p>}
      </Card>
    </div>
  );
}
