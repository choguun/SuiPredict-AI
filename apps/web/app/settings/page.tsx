"use client";

import { useCurrentAccount, useDAppKit } from "@mysten/dapp-kit-react";
import { useState } from "react";
import {
  AGENT_POLICY_PACKAGE_ID,
  buildCreatePolicyTx,
  buildRevokePolicyTx,
} from "@suipredict/sdk";
import { Card } from "@/components/ui";

export default function SettingsPage() {
  const account = useCurrentAccount();
  const dAppKit = useDAppKit();
  const [agentAddress, setAgentAddress] = useState("");
  const [budget, setBudget] = useState(50);
  const [policyId, setPolicyId] = useState("");
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(false);

  async function createPolicy() {
    if (!account || !agentAddress) return;
    setLoading(true);
    setStatus("Creating agent policy...");
    try {
      const expiry = BigInt(Date.now() + 7 * 24 * 60 * 60 * 1000);
      const tx = buildCreatePolicyTx(agentAddress, budget, expiry);
      const result = await dAppKit.signAndExecuteTransaction({ transaction: tx });
      const digest =
        result.$kind === "Transaction"
          ? result.Transaction.digest
          : "unknown";
      setStatus(`Policy created! Tx: ${digest.slice(0, 16)}...`);
    } catch (e) {
      setStatus(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoading(false);
    }
  }

  async function revokePolicy() {
    if (!account || !policyId) return;
    setLoading(true);
    setStatus("Revoking policy...");
    try {
      const tx = buildRevokePolicyTx(policyId);
      const result = await dAppKit.signAndExecuteTransaction({ transaction: tx });
      const digest =
        result.$kind === "Transaction"
          ? result.Transaction.digest
          : "unknown";
      setStatus(`Revoked! Tx: ${digest.slice(0, 16)}...`);
    } catch (e) {
      setStatus(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Agent Policy</h1>
        <p className="text-zinc-400">
          Create and revoke on-chain agent wallets with budget caps
        </p>
      </div>

      <Card title="Create Policy">
        {!account ? (
          <p className="text-zinc-400">Connect wallet as policy owner</p>
        ) : (
          <div className="space-y-3 max-w-md">
            <div>
              <label className="text-xs text-zinc-500">Agent Address</label>
              <input
                className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm font-mono"
                value={agentAddress}
                onChange={(e) => setAgentAddress(e.target.value)}
                placeholder="0x..."
              />
            </div>
            <div>
              <label className="text-xs text-zink-500">Max Budget (dUSDC)</label>
              <input
                type="number"
                className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm"
                value={budget}
                onChange={(e) => setBudget(Number(e.target.value))}
              />
            </div>
            <button
              onClick={createPolicy}
              disabled={loading || !agentAddress}
              className="rounded-lg bg-cyan-500 px-4 py-2 text-sm font-medium text-zinc-950 hover:bg-cyan-400 disabled:opacity-50"
            >
              Create Policy
            </button>
          </div>
        )}
      </Card>

      <Card title="Revoke Policy (Demo)">
        <div className="space-y-3 max-w-md">
          <div>
            <label className="text-xs text-zinc-500">Policy Object ID</label>
            <input
              className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm font-mono"
              value={policyId}
              onChange={(e) => setPolicyId(e.target.value)}
              placeholder="0x..."
            />
          </div>
          <button
            onClick={revokePolicy}
            disabled={loading || !policyId || !account}
            className="rounded-lg bg-red-500/80 px-4 py-2 text-sm font-medium text-white hover:bg-red-500 disabled:opacity-50"
          >
            Revoke Agent Access
          </button>
        </div>
      </Card>

      <Card title="Contract Info">
        <p className="text-xs font-mono text-zinc-400 break-all">
          Agent Policy Package: {AGENT_POLICY_PACKAGE_ID}
        </p>
      </Card>

      {status && (
        <p className="text-xs font-mono text-zinc-400 break-all">{status}</p>
      )}
    </div>
  );
}
