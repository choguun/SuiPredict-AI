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
  buildCreateManagerTx,
  getManagerForOwner,
  getActiveOracles,
  getManagerPositions,
  getOracles,
  pickAtmStrike,
  strikeToDollars,
  type OracleInfo,
  type PositionSummary,
  predict,
} from "@suipredict/sdk";
import { Card } from "@/components/ui";
import { toast } from "sonner";

export default function TradePage() {
  const account = useCurrentAccount();
  const client = useCurrentClient();
  const dAppKit = useDAppKit();
  const [oracles, setOracles] = useState<OracleInfo[]>([]);
  const [selectedOracle, setSelectedOracle] = useState<string>("");
  const [strike, setStrike] = useState(75000);
  const [direction, setDirection] = useState<"up" | "down">("up");
  const [quantity, setQuantity] = useState(1);
  const [managerId, setManagerId] = useState("");
  const [loading, setLoading] = useState(false);
  const [refreshCounter, setRefreshCounter] = useState(0);
  const [positions, setPositions] = useState<PositionSummary[]>([]);
  const [settledOracleIds, setSettledOracleIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!managerId) return;
    getManagerPositions(managerId)
      .then(setPositions)
      .catch(console.error);
    getOracles()
      .then((list) =>
        setSettledOracleIds(
          new Set(list.filter((o) => o.status === "settled").map((o) => o.oracle_id)),
        ),
      )
      .catch(console.error);
  }, [managerId, refreshCounter]);

  useEffect(() => {
    getActiveOracles()
      .then((list) => {
        setOracles(list.filter((o) => o.expiry > Date.now()).slice(0, 10));
        if (list[0]) setSelectedOracle(list[0].oracle_id);
      })
      .catch(console.error);
  }, []);

  useEffect(() => {
    if (!selectedOracle) return;
    const oracle = oracles.find((o) => o.oracle_id === selectedOracle);
    if (!oracle) return;
    pickAtmStrike(oracle.oracle_id, oracle.min_strike, oracle.tick_size).then(
      setStrike,
    );
  }, [selectedOracle, oracles]);

  const oracle = oracles.find((o) => o.oracle_id === selectedOracle);

  async function createManager() {
    if (!account || !client) return;
    setLoading(true);
    const toastId = toast.loading("Creating PredictManager...");
    try {
      const tx = buildCreateManagerTx();
      const result = await dAppKit.signAndExecuteTransaction({ transaction: tx });
      const digest =
        result.$kind === "Transaction"
          ? result.Transaction.digest
          : result.FailedTransaction?.digest;
      if (digest) {
        await client.waitForTransaction({ digest });
      }
      if (account) {
        const id = await getManagerForOwner(account.address);
        if (id) {
          setManagerId(id);
          toast.success(`Manager created: ${id.slice(0, 12)}...`, { id: toastId });
        }
      }
    } catch (e) {
      toast.error(`Error: ${e instanceof Error ? e.message : String(e)}`, { id: toastId });
    } finally {
      setLoading(false);
    }
  }

  async function mintPosition() {
    if (!account || !client || !managerId || !oracle) return;
    setLoading(true);
    const toastId = toast.loading("Building mint transaction...");
    try {
      const tx = new Transaction();
      const coins = await client.core.listCoins({
        owner: account.address,
        coinType: DUSDC_TYPE,
      });
      const topup = BigInt(quantity + 1) * BigInt(1_000_000);
      if (coins.objects.length > 0) {
        const primary = tx.object(coins.objects[0]!.objectId);
        if (coins.objects.length > 1) {
          tx.mergeCoins(
            primary,
            coins.objects.slice(1).map((c) => tx.object(c.objectId)),
          );
        }
        const [depositCoin] = tx.splitCoins(primary, [tx.pure.u64(topup)]);
        tx.moveCall({
          target: `${PREDICT_PACKAGE_ID}::predict_manager::deposit`,
          typeArguments: [DUSDC_TYPE],
          arguments: [tx.object(managerId), depositCoin],
        });
      }

      const strikeScaled = BigInt(strike) * BigInt(1_000_000_000);
      const keyFn = direction === "up" ? "up" : "down";
      const key = tx.moveCall({
        target: `${PREDICT_PACKAGE_ID}::market_key::${keyFn}`,
        arguments: [
          tx.pure.id(oracle.oracle_id),
          tx.pure.u64(BigInt(oracle.expiry)),
          tx.pure.u64(strikeScaled),
        ],
      });
      tx.moveCall({
        target: `${PREDICT_PACKAGE_ID}::predict::mint`,
        typeArguments: [DUSDC_TYPE],
        arguments: [
          tx.object(PREDICT_OBJECT_ID),
          tx.object(managerId),
          tx.object(oracle.oracle_id),
          key,
          tx.pure.u64(BigInt(quantity) * BigInt(1_000_000)),
          tx.object(CLOCK_OBJECT_ID),
        ],
      });

      const result = await dAppKit.signAndExecuteTransaction({ transaction: tx });
      // R34 audit fix: same R30/R32 pattern — Failed / EffectsCert
      // variants carry no digest. The previous code fell through to
      // the literal string "unknown" and toasted it as a success,
      // lying to the user that a position was minted when the tx
      // had failed. Bail with a clear error toast before reading
      // the digest.
      if (result.$kind !== "Transaction") {
        toast.error("Mint failed on-chain", { id: toastId });
        return;
      }
      const digest = result.Transaction.digest;
      toast.success(`Minted! Tx: ${digest.slice(0, 16)}...`, { id: toastId });
      setRefreshCounter(c => c + 1);
    } catch (e) {
      toast.error(`Error: ${e instanceof Error ? e.message : String(e)}`, { id: toastId });
    } finally {
      setLoading(false);
    }
  }

  async function redeemPosition(pos: PositionSummary) {
    if (!account || !managerId) return;
    setLoading(true);
    const toastId = toast.loading("Redeeming settled position...");
    try {
      const strikeDollars = strikeToDollars(BigInt(pos.strike));
      const quantityDollars = pos.quantity / 1e6;
      const tx = predict.buildRedeemTx({
        managerId,
        oracleId: pos.oracle_id,
        expiry: BigInt(pos.expiry),
        strikeDollars,
        direction: pos.is_up ? "up" : "down",
        quantityDollars,
        permissionless: settledOracleIds.has(pos.oracle_id),
      });
      const result = await dAppKit.signAndExecuteTransaction({ transaction: tx });
      const digest =
        result.$kind === "Transaction"
          ? result.Transaction.digest
          : "unknown";
      toast.success(`Redeemed! Tx: ${digest.slice(0, 16)}...`, { id: toastId });
      setRefreshCounter(c => c + 1);
    } catch (e) {
      toast.error(`Error: ${e instanceof Error ? e.message : String(e)}`, { id: toastId });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!account) return;
    getManagerForOwner(account.address)
      .then((id) => {
        if (id) setManagerId(id);
      })
      .catch(console.error);
  }, [account]);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-transparent bg-clip-text bg-gradient-to-r from-white to-cyan-200">Trade BTC Binaries</h1>
        <p className="mt-2 text-zinc-400">Mint UP/DOWN positions on DeepBook Predict</p>
      </div>

      {!account && (
        <Card className="border-white/10">
          <p className="text-zinc-400">Connect wallet to trade</p>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Setup" className="border-white/10">
          <div className="space-y-5 mt-2">
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-1.5">PredictManager ID</label>
              <div className="mt-1 flex gap-3">
                <input
                  className="flex-1 rounded-lg border border-white/10 bg-black/20 px-3 py-2.5 text-sm font-mono text-white focus:border-cyan-500/50 focus:outline-none transition-colors"
                  value={managerId}
                  onChange={(e) => setManagerId(e.target.value)}
                  placeholder="0x..."
                />
                <button
                  onClick={createManager}
                  disabled={!account || loading}
                  className="rounded-lg border border-white/10 bg-white/5 px-4 py-2.5 text-sm font-medium text-white transition-all hover:bg-white/10 hover:border-white/20 disabled:opacity-50"
                >
                  Create
                </button>
              </div>
            </div>
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-1.5">Oracle</label>
              <select
                className="mt-1 w-full rounded-lg border border-white/10 bg-black/20 px-3 py-2.5 text-sm text-white focus:border-cyan-500/50 focus:outline-none transition-colors appearance-none"
                value={selectedOracle}
                onChange={(e) => setSelectedOracle(e.target.value)}
              >
                {oracles.map((o) => (
                  <option key={o.oracle_id} value={o.oracle_id} className="bg-zinc-900">
                    {o.underlying_asset} · {new Date(o.expiry).toLocaleString()}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </Card>

        <Card title="Position" className="border-white/10">
          <div className="space-y-5 mt-2">
            <div className="flex gap-3">
              {(["up", "down"] as const).map((d) => (
                <button
                  key={d}
                  onClick={() => setDirection(d)}
                  className={`flex-1 rounded-lg py-2.5 text-sm font-semibold transition-all duration-300 ${
                    direction === d
                      ? d === "up"
                        ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 shadow-[0_0_15px_rgba(16,185,129,0.15)]"
                        : "bg-rose-500/20 text-rose-300 border border-rose-500/30 shadow-[0_0_15px_rgba(244,63,94,0.15)]"
                      : "bg-white/5 text-zinc-400 hover:text-white hover:bg-white/10 border border-transparent"
                  }`}
                >
                  {d.toUpperCase()}
                </button>
              ))}
            </div>
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-1.5">Strike ($)</label>
              <input
                type="number"
                className="w-full rounded-lg border border-white/10 bg-black/20 px-3 py-2.5 text-sm text-white focus:border-cyan-500/50 focus:outline-none transition-colors"
                value={strike}
                onChange={(e) => setStrike(Number(e.target.value))}
              />
            </div>
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-1.5">Quantity ($ face)</label>
              <input
                type="number"
                min={1}
                className="w-full rounded-lg border border-white/10 bg-black/20 px-3 py-2.5 text-sm text-white focus:border-cyan-500/50 focus:outline-none transition-colors"
                value={quantity}
                onChange={(e) => setQuantity(Number(e.target.value))}
              />
            </div>
            <button
              onClick={mintPosition}
              disabled={!account || !managerId || !oracle || loading}
              className="mt-2 w-full rounded-lg bg-gradient-to-r from-violet-600 to-cyan-600 py-3 text-sm font-semibold text-white shadow-lg shadow-cyan-900/30 transition-all hover:scale-[1.02] hover:shadow-cyan-900/50 disabled:opacity-50 disabled:scale-100"
            >
              {loading ? "Submitting..." : "Mint Position"}
            </button>
          </div>
        </Card>
      </div>

      {managerId && positions.length > 0 && (
        <Card title="Open Positions" className="border-white/10">
          <div className="overflow-x-auto mt-2">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/10 text-left text-zinc-400">
                  <th className="pb-3 pr-4 font-semibold uppercase tracking-wider text-xs">Direction</th>
                  <th className="pb-3 pr-4 font-semibold uppercase tracking-wider text-xs">Strike</th>
                  <th className="pb-3 pr-4 font-semibold uppercase tracking-wider text-xs">Qty ($)</th>
                  <th className="pb-3 pr-4 font-semibold uppercase tracking-wider text-xs">Expiry</th>
                  <th className="pb-3 font-semibold uppercase tracking-wider text-xs">Action</th>
                </tr>
              </thead>
              <tbody>
                {positions.map((pos) => {
                  const settled = settledOracleIds.has(pos.oracle_id);
                  return (
                    <tr key={`${pos.oracle_id}-${pos.strike}-${pos.is_up}`} className="border-b border-white/5 transition-colors hover:bg-white/5 last:border-0">
                      <td className="py-3 pr-4 font-medium">
                        <span className={pos.is_up ? "text-emerald-400" : "text-rose-400"}>
                          {pos.is_up ? "UP" : "DOWN"}
                        </span>
                      </td>
                      <td className="py-3 pr-4 text-white">${strikeToDollars(BigInt(pos.strike)).toLocaleString()}</td>
                      <td className="py-3 pr-4 text-zinc-300">${(pos.quantity / 1e6).toFixed(2)}</td>
                      <td className="py-3 pr-4 text-zinc-400">{new Date(pos.expiry).toLocaleString()}</td>
                      <td className="py-3">
                        {settled ? (
                          <button
                            onClick={() => redeemPosition(pos)}
                            disabled={loading || !account}
                            className="rounded-md bg-emerald-500/20 px-3 py-1.5 text-xs font-medium text-emerald-300 hover:bg-emerald-500/30 transition-colors disabled:opacity-50 border border-emerald-500/30 shadow-[0_0_10px_rgba(16,185,129,0.1)]"
                          >
                            Redeem
                          </button>
                        ) : (
                          <span className="text-xs text-cyan-500/70 font-medium px-2 py-1 bg-cyan-500/10 rounded-md">Active</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
