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
  buildRedeemTx,
  getManagerForOwner,
  getActiveOracles,
  getManagerPositions,
  getOracles,
  pickAtmStrike,
  strikeToDollars,
  type OracleInfo,
  type PositionSummary,
} from "@suipredict/sdk";
import { Card } from "@/components/ui";

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
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(false);
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
  }, [managerId, status]);

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
    setStatus("Creating PredictManager...");
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
          setStatus(`Manager: ${id.slice(0, 12)}...`);
        }
      }
    } catch (e) {
      setStatus(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoading(false);
    }
  }

  async function mintPosition() {
    if (!account || !client || !managerId || !oracle) return;
    setLoading(true);
    setStatus("Building mint transaction...");
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
      const digest =
        result.$kind === "Transaction"
          ? result.Transaction.digest
          : "unknown";
      setStatus(`Minted! Tx: ${digest.slice(0, 16)}...`);
    } catch (e) {
      setStatus(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoading(false);
    }
  }

  async function redeemPosition(pos: PositionSummary) {
    if (!account || !managerId) return;
    setLoading(true);
    setStatus("Redeeming settled position...");
    try {
      const strikeDollars = strikeToDollars(BigInt(pos.strike));
      const quantityDollars = pos.quantity / 1e6;
      const tx = buildRedeemTx({
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
      setStatus(`Redeemed! Tx: ${digest.slice(0, 16)}...`);
    } catch (e) {
      setStatus(`Error: ${e instanceof Error ? e.message : String(e)}`);
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
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Trade BTC Binaries</h1>
        <p className="text-zinc-400">Mint UP/DOWN positions on DeepBook Predict</p>
      </div>

      {!account && (
        <Card>
          <p className="text-zinc-400">Connect wallet to trade</p>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Setup">
          <div className="space-y-4">
            <div>
              <label className="text-xs text-zinc-500">PredictManager ID</label>
              <div className="mt-1 flex gap-2">
                <input
                  className="flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm font-mono"
                  value={managerId}
                  onChange={(e) => setManagerId(e.target.value)}
                  placeholder="0x..."
                />
                <button
                  onClick={createManager}
                  disabled={!account || loading}
                  className="rounded-lg bg-zinc-800 px-3 py-2 text-sm hover:bg-zinc-700 disabled:opacity-50"
                >
                  Create
                </button>
              </div>
            </div>
            <div>
              <label className="text-xs text-zinc-500">Oracle</label>
              <select
                className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm"
                value={selectedOracle}
                onChange={(e) => setSelectedOracle(e.target.value)}
              >
                {oracles.map((o) => (
                  <option key={o.oracle_id} value={o.oracle_id}>
                    {o.underlying_asset} · {new Date(o.expiry).toLocaleString()}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </Card>

        <Card title="Position">
          <div className="space-y-4">
            <div className="flex gap-2">
              {(["up", "down"] as const).map((d) => (
                <button
                  key={d}
                  onClick={() => setDirection(d)}
                  className={`flex-1 rounded-lg py-2 text-sm font-medium ${
                    direction === d
                      ? d === "up"
                        ? "bg-emerald-500/30 text-emerald-300"
                        : "bg-red-500/30 text-red-300"
                      : "bg-zinc-800 text-zinc-400"
                  }`}
                >
                  {d.toUpperCase()}
                </button>
              ))}
            </div>
            <div>
              <label className="text-xs text-zinc-500">Strike ($)</label>
              <input
                type="number"
                className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm"
                value={strike}
                onChange={(e) => setStrike(Number(e.target.value))}
              />
            </div>
            <div>
              <label className="text-xs text-zinc-500">Quantity ($ face)</label>
              <input
                type="number"
                min={1}
                className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm"
                value={quantity}
                onChange={(e) => setQuantity(Number(e.target.value))}
              />
            </div>
            <button
              onClick={mintPosition}
              disabled={!account || !managerId || !oracle || loading}
              className="w-full rounded-lg bg-cyan-500 py-2.5 text-sm font-medium text-zinc-950 hover:bg-cyan-400 disabled:opacity-50"
            >
              {loading ? "Submitting..." : "Mint Position"}
            </button>
            {status && (
              <p className="text-xs text-zinc-400 font-mono break-all">{status}</p>
            )}
          </div>
        </Card>
      </div>

      {managerId && positions.length > 0 && (
        <Card title="Open Positions">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-zinc-500">
                  <th className="pb-2 pr-4">Direction</th>
                  <th className="pb-2 pr-4">Strike</th>
                  <th className="pb-2 pr-4">Qty ($)</th>
                  <th className="pb-2 pr-4">Expiry</th>
                  <th className="pb-2">Action</th>
                </tr>
              </thead>
              <tbody>
                {positions.map((pos) => {
                  const settled = settledOracleIds.has(pos.oracle_id);
                  return (
                    <tr key={`${pos.oracle_id}-${pos.strike}-${pos.is_up}`} className="border-t border-zinc-800">
                      <td className="py-2 pr-4">{pos.is_up ? "UP" : "DOWN"}</td>
                      <td className="py-2 pr-4">${strikeToDollars(BigInt(pos.strike)).toLocaleString()}</td>
                      <td className="py-2 pr-4">${(pos.quantity / 1e6).toFixed(2)}</td>
                      <td className="py-2 pr-4">{new Date(pos.expiry).toLocaleString()}</td>
                      <td className="py-2">
                        {settled ? (
                          <button
                            onClick={() => redeemPosition(pos)}
                            disabled={loading || !account}
                            className="rounded bg-emerald-500/20 px-2 py-1 text-xs text-emerald-300 hover:bg-emerald-500/30 disabled:opacity-50"
                          >
                            Redeem
                          </button>
                        ) : (
                          <span className="text-xs text-zinc-500">Active</span>
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
