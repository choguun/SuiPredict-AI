"use client";

import { useCurrentAccount, useCurrentClient, useDAppKit } from "@mysten/dapp-kit-react";
import { useState } from "react";
import {
  AGENT_POLICY_PACKAGE_ID,
  buildCreatePolicyTx,
  buildPausePolicyTx,
  buildRevokePolicyTx,
  buildUnpausePolicyTx,
  extractCreatedObjectId,
  getPolicyState,
  dusdcToDollars,
  type AgentPolicyState,
} from "@suipredict/sdk";
import { Card } from "@/components/ui";

export default function SettingsPage() {
  const account = useCurrentAccount();
  const client = useCurrentClient();
  const dAppKit = useDAppKit();
  const [agentAddress, setAgentAddress] = useState("");
  const [budget, setBudget] = useState(50);
  const [policyId, setPolicyId] = useState("");
  const [policyInfo, setPolicyInfo] = useState<string>("");
  const [policyState, setPolicyState] = useState<AgentPolicyState | null>(null);
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(false);

  async function loadPolicyInfo(id: string) {
    if (!client || !id) return;
    const policy = await getPolicyState(client, id);
    if (!policy) {
      setPolicyInfo("Policy not found or invalid ID.");
      setPolicyState(null);
      return;
    }
    setPolicyState(policy);
    setPolicyInfo(
      `Owner: ${policy.owner.slice(0, 10)}… · Agent: ${policy.agent.slice(0, 10)}… · Spent $${dusdcToDollars(BigInt(policy.spent)).toFixed(2)} / $${dusdcToDollars(BigInt(policy.max_budget)).toFixed(2)} · ${policy.revoked ? "REVOKED" : policy.paused ? "PAUSED" : "ACTIVE"}`,
    );
  }

  async function createPolicy() {
    if (!account || !client || !agentAddress) return;
    setLoading(true);
    setStatus("Creating agent policy...");
    try {
      const expiry = BigInt(Date.now() + 7 * 24 * 60 * 60 * 1000);
      const tx = buildCreatePolicyTx(agentAddress, budget, expiry);
      const result = await dAppKit.signAndExecuteTransaction({ transaction: tx });
      const digest =
        result.$kind === "Transaction"
          ? result.Transaction.digest
          : null;
      if (!digest) throw new Error("Transaction failed");

      const createdId = await extractCreatedObjectId(
        client,
        digest,
        "::agent_policy::AgentPolicy",
      );
      if (createdId) {
        setPolicyId(createdId);
        await loadPolicyInfo(createdId);
        setStatus(`Policy created! ID: ${createdId} — set AGENT_POLICY_ID in .env`);
      } else {
        setStatus(`Policy created! Tx: ${digest.slice(0, 16)}… (fetch object ID from Suiscan)`);
      }
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
      setStatus(`Revoked! Tx: ${digest.slice(0, 16)}…`);
      await loadPolicyInfo(policyId);
    } catch (e) {
      setStatus(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoading(false);
    }
  }

  async function setPaused(pause: boolean) {
    if (!account || !policyId) return;
    setLoading(true);
    setStatus(pause ? "Pausing policy..." : "Unpausing policy...");
    try {
      // The on-chain `pause` allows either owner or agent, but `unpause`
      // is owner-only — when pausing-as-agent, use the agent wallet;
      // when unpausing, the owner must sign.
      const tx = pause
        ? buildPausePolicyTx(policyId)
        : buildUnpausePolicyTx(policyId);
      const result = await dAppKit.signAndExecuteTransaction({ transaction: tx });
      const digest =
        result.$kind === "Transaction"
          ? result.Transaction.digest
          : "unknown";
      setStatus(`${pause ? "Paused" : "Unpaused"}! Tx: ${digest.slice(0, 16)}…`);
      await loadPolicyInfo(policyId);
    } catch (e) {
      setStatus(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-transparent bg-clip-text bg-gradient-to-r from-white to-cyan-200">Agent Policy</h1>
        <p className="mt-2 text-zinc-400">
          Create and revoke on-chain agent wallets with budget caps (shared policy object)
        </p>
      </div>

      <Card title="Create Policy" className="border-white/10">
        {!account ? (
          <p className="text-zinc-400">Connect wallet as policy owner</p>
        ) : (
          <div className="space-y-4 max-w-md mt-2">
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-1.5">Agent Address</label>
              <input
                className="w-full rounded-lg border border-white/10 bg-black/20 px-3 py-2.5 text-sm font-mono text-white focus:border-cyan-500/50 focus:outline-none transition-colors"
                value={agentAddress}
                onChange={(e) => setAgentAddress(e.target.value)}
                placeholder="0x..."
              />
            </div>
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-1.5">Max Budget (dUSDC)</label>
              <input
                type="number"
                className="w-full rounded-lg border border-white/10 bg-black/20 px-3 py-2.5 text-sm text-white focus:border-cyan-500/50 focus:outline-none transition-colors"
                value={budget}
                onChange={(e) => setBudget(Number(e.target.value))}
              />
            </div>
            <button
              onClick={createPolicy}
              disabled={loading || !agentAddress}
              className="mt-2 w-full rounded-lg bg-gradient-to-r from-violet-600 to-cyan-600 py-3 text-sm font-semibold text-white shadow-lg shadow-cyan-900/30 transition-all hover:scale-[1.02] hover:shadow-cyan-900/50 disabled:opacity-50 disabled:scale-100"
            >
              Create Policy
            </button>
          </div>
        )}
      </Card>

      <Card title="Manage Policy" className="border-white/10">
        <div className="space-y-4 max-w-md mt-2">
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-1.5">Policy Object ID</label>
            <input
              className="w-full rounded-lg border border-white/10 bg-black/20 px-3 py-2.5 text-sm font-mono text-white focus:border-cyan-500/50 focus:outline-none transition-colors"
              value={policyId}
              onChange={(e) => setPolicyId(e.target.value)}
              onBlur={() => loadPolicyInfo(policyId)}
              placeholder="0x..."
            />
          </div>
          {policyInfo && (
            <p className="text-xs text-zinc-400 bg-white/5 p-3 rounded-lg border border-white/5">{policyInfo}</p>
          )}
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <button
              onClick={() => setPaused(true)}
              disabled={
                loading ||
                !policyId ||
                !account ||
                !policyState ||
                policyState.paused ||
                policyState.revoked
              }
              className="rounded-lg bg-amber-500/20 border border-amber-500/30 py-3 text-sm font-semibold text-amber-200 shadow-[0_0_15px_rgba(245,158,11,0.15)] transition-all hover:bg-amber-500/30 disabled:opacity-50"
            >
              Pause
            </button>
            <button
              onClick={() => setPaused(false)}
              disabled={
                loading ||
                !policyId ||
                !account ||
                !policyState ||
                !policyState.paused ||
                policyState.revoked
              }
              className="rounded-lg bg-emerald-500/20 border border-emerald-500/30 py-3 text-sm font-semibold text-emerald-200 shadow-[0_0_15px_rgba(16,185,129,0.15)] transition-all hover:bg-emerald-500/30 disabled:opacity-50"
            >
              Unpause
            </button>
            <button
              onClick={revokePolicy}
              disabled={loading || !policyId || !account || policyState?.revoked}
              className="rounded-lg bg-rose-500/20 border border-rose-500/30 py-3 text-sm font-semibold text-rose-300 shadow-[0_0_15px_rgba(244,63,94,0.15)] transition-all hover:bg-rose-500/30 disabled:opacity-50"
            >
              Revoke
            </button>
          </div>
          <p className="text-xs text-zinc-500">
            Pause/unpause: only the policy owner can <em>unpause</em>;
            either owner or agent can pause. Revoke permanently disables
            the policy — irreversible.
          </p>
        </div>
      </Card>

      <Card title="Contract Info" className="border-white/10">
        <p className="text-xs font-mono text-zinc-400 break-all bg-black/20 p-3 rounded-lg border border-white/5">
          Agent Policy Package: {AGENT_POLICY_PACKAGE_ID}
        </p>
        <p className="mt-4 text-xs text-zinc-400">
          After create, copy the policy ID into <code className="text-zinc-300 bg-white/10 px-1 rounded">AGENT_POLICY_ID</code> in your agents <code className="text-zinc-300 bg-white/10 px-1 rounded">.env</code>.
        </p>
      </Card>

      {status && (
        <div className="rounded-lg border border-white/10 bg-black/20 p-4 backdrop-blur-sm inline-block">
          <p className="text-xs font-mono text-cyan-400 break-all">{status}</p>
        </div>
      )}
    </div>
  );
}
