"use client";

import {
  useCurrentAccount,
  useCurrentClient,
  useDAppKit,
} from "@mysten/dapp-kit-react";
import { Transaction } from "@mysten/sui/transactions";
import { useCallback, useEffect, useState } from "react";
import {
  CLOCK_OBJECT_ID,
  DUSDC_TYPE,
  PLP_TYPE,
  PREDICT_OBJECT_ID,
  PREDICT_PACKAGE_ID,
  getVaultSummary,
  isValidSuiAddress,
  normalizeObjectId,
  type VaultSummary,
} from "@suipredict/sdk";
import { Card, Stat } from "@/components/ui";
import { clampNumberString } from "@/lib/forms";
import { submitAndWait } from "@/lib/dapp-kit";

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

  const refreshPlp = useCallback(async () => {
    if (!account || !client) return;
    // R52 audit fix: normalize the
    // owner address. `listCoins` is
    // case-sensitive on the wire;
    // a mixed-case Enoki zkLogin
    // session would otherwise
    // silently return `{ objects: [] }`
    // and the PLP-balance display
    // would always read 0.
    const { objects } = await client.core.listCoins({
      owner: normalizeObjectId(account.address),
      coinType: PLP_TYPE,
      // R53 audit fix: bump default
      // 50-coin page to 100. PLP
      // shares fragment fast (every
      // supply/withdraw creates a
      // new coin), and a dust-heavy
      // user's balance display is
      // silently truncated.
      limit: 100,
    });
    const total = objects.reduce((s, c) => s + Number(c.balance), 0);
    setPlpBalance(total);
    setPlpCoinId(objects[0]?.objectId ?? "");
  }, [account, client]);

  useEffect(() => {
    refreshVault().catch(console.error);
    const id = setInterval(() => {
      // R45 audit fix: pause the 10s `refreshVault` poll when the
      // tab is hidden. R42 added this guard to the modern
      // `apps/web/app/vault/page.tsx`; this legacy PLP vault
      // page was the survivor. A 1h backgrounded tab previously
      // fired 360 `getVaultSummary` calls per hour against
      // Mysten's predict-server, wasting bandwidth and
      // competing with indexer recovery. The other tick effect
      // on this page (`refreshPlp` on `[account, client,
      // refreshPlp]`) only runs on dep change so it doesn't
      // need the guard.
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      refreshVault().catch(console.error);
    }, 10000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!account || !client) return;
    refreshPlp().catch(console.error);
  }, [account, client, refreshPlp]);

  async function supplyPLP() {
    if (!account || !client) return;
    // R49 audit fix: confirm the fund-locking supply before
    // signing. `withdrawPLP` (line 110) already prompts; the
    // supply side was the asymmetric survivor. A misclick
    // costs the user a real PTB fee and locks the DUSDC for
    // the vault's lockup period.
    if (
      !window.confirm(
        `Supply ${amount} DUSDC to the PLP vault?`,
      )
    ) {
      return;
    }
    setLoading(true);
    setStatus("Supplying to PLP vault...");
    try {
      const tx = new Transaction();
      const supplyAmount = BigInt(amount) * BigInt(1_000_000);
      // R52 audit fix: normalize the
      // owner address (see comment on
      // `refreshPlp`).
      const coins = await client.core.listCoins({
        owner: normalizeObjectId(account.address),
        coinType: DUSDC_TYPE,
        // R53 audit fix: same
        // `limit: 100` rationale as
        // `refreshPlp` above. A
        // dust-heavy user is silently
        // told they have no DUSDC.
        limit: 100,
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
      tx.transferObjects([lpCoin], tx.pure.address(normalizeObjectId(account.address)));
      // R55 audit fix: route through `submitAndWait` so
      // the `Promise.all([refreshVault(), refreshPlp()])`
      // refetches hit a node that has already finalized
      // the supply tx. The previous signAndExecuteTransaction
      // returned immediately after signing; the refresh
      // PLP-coin list call raced on-chain finalization and
      // a slow RPC would briefly show the user the OLD
      // balance even though the new supply was accepted.
      const result = await submitAndWait(dAppKit, client, tx);
      // R34 audit fix: same R30/R32 pattern. The literal `"unknown"`
      // fallback on Failed / EffectsCert silently toasts a fake
      // success, telling the LP that a deposit happened when the
      // chain rejected it. Bail with a clear error before reading
      // the digest.
      if (result.$kind !== "Transaction" || !result.digest) {
        setStatus("Supply failed on-chain");
        return;
      }
      const digest = result.digest;
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
    // R54 audit fix: validate `plpCoinId` is a syntactically
    // valid Sui object id before passing it to `tx.object()`.
    // The `!plpCoinId` guard above blocks the empty-string
    // case, but a *malformed-but-non-empty* string (e.g. an
    // Ethereum address pasted from a tutorial) passes the
    // truthiness check and crashes the PTB builder with an
    // opaque `invalid input object` abort. R44 added the
    // equivalent `isValidSuiAddress(managerId)` check to the
    // legacy trade page; the legacy PLP vault was missed.
    if (!isValidSuiAddress(plpCoinId)) {
      setStatus("PLP coin id is not a valid Sui object id");
      return;
    }
    // R47 audit fix: confirm before withdrawing. The
    // R45 audit pass added `window.confirm` to the
    // admin cards but missed the legacy PLP vault
    // page — a user with several million PLP shares
    // can mis-click the "Withdraw" button and the
    // entire balance is consumed by a single
    // `tx.splitCoins` with no second-chance prompt.
    // The supplied `withdrawAmount` may be only a
    // fraction of the wallet's PLP, but a zero-amount
    // submit (operator left the field blank) would
    // still issue a PTB that splits the *whole coin*
    // on the move side because the contract treats
    // 0 atoms as a no-op only at the deposit path.
    if (
      !window.confirm(
        `Withdraw ${withdrawAmount} dUSDC from the PLP vault?`,
      )
    ) {
      return;
    }
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
      tx.transferObjects([plpCoin], tx.pure.address(normalizeObjectId(account.address)));
      // R55 audit fix: same `submitAndWait` rationale as
      // the supply path above. The previous
      // signAndExecuteTransaction returned before
      // finalization, so the user briefly saw their
      // OLD PLP balance after the "Withdrew" toast.
      const result = await submitAndWait(dAppKit, client, tx);
      // R34 audit fix: same R30/R32 pattern as supply() above.
      // Failed / EffectsCert results carry no digest; the previous
      // fallback to "unknown" lied about the withdrawal. Bail with
      // a clear error before reading the digest.
      if (result.$kind !== "Transaction" || !result.digest) {
        setStatus("Withdraw failed on-chain");
        return;
      }
      const digest = result.digest;
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
                // R38 audit fix: regex-bounded parse. The
                // supply_plp builder takes amount as base atoms
                // (BigInt(Math.round(amount * 1_000_000))) so a
                // NaN would TypeError in the render path before
                // the try/catch in supplyPLP runs.
                onChange={(e) => setAmount(clampNumberString(e.target.value, 1, 1, 1_000_000))}
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
                // R38 audit fix: same regex-bounded parse for
                // the withdraw amount — symmetry with supply so
                // both code paths handle malformed input the
                // same way.
                onChange={(e) => setWithdrawAmount(clampNumberString(e.target.value, 1, 1, 1_000_000))}
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
