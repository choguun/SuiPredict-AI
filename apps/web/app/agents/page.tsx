"use client";

import { useEffect, useState } from "react";
import { Badge, Card } from "@/components/ui";

interface Decision {
  id: string;
  agent: string;
  action: string;
  reasoning: string;
  confidence?: number;
  txDigest?: string;
  timestamp: number;
}

const AGENTS = [
  {
    name: "MarketCreator",
    desc: "Proposes and creates binary markets (LLM + rules)",
  },
  {
    name: "MarketMaker",
    desc: "Quotes YES bid/ask from vault allocation on CLOB",
  },
  {
    name: "MarketResolver",
    desc: "Resolves expired markets via oracle + LLM confidence",
  },
  {
    name: "RiskMonitor",
    desc: "Pauses agent policy on critical utilization",
  },
];

const LEGACY = [
  { name: "MarketStrategist", desc: "Legacy Predict BTC mints" },
  { name: "PLPManager", desc: "Legacy dUSDC PLP supply" },
  { name: "RedeemKeeper", desc: "Legacy permissionless redeem" },
];

export default function AgentsPage() {
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    async function load() {
      try {
        const base =
          process.env.NEXT_PUBLIC_AGENTS_URL ?? "http://localhost:3001";
        const res = await fetch(`${base}/decisions`);
        if (!res.ok) throw new Error("Agent service unavailable");
        setDecisions(await res.json());
        setError("");
      } catch {
        setError("Start agents with: pnpm dev:agents");
      }
    }
    load();
    const id = setInterval(load, 8000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Agent Dashboard</h1>
        <p className="text-zinc-400">
          Autonomous CLOB agents (creator, maker, resolver) plus optional legacy
          DeepBook Predict agents
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {AGENTS.map((a) => (
          <Card key={a.name}>
            <div className="flex items-center justify-between">
              <h3 className="font-medium text-cyan-300">{a.name}</h3>
              <Badge variant="success">Primary</Badge>
            </div>
            <p className="mt-2 text-sm text-zinc-400">{a.desc}</p>
          </Card>
        ))}
      </div>

      <Card title="Legacy Predict agents (optional)">
        <p className="text-xs text-zinc-500 mb-3">
          Enable with ENABLE_LEGACY_PREDICT_AGENTS=true
        </p>
        <div className="grid gap-3 sm:grid-cols-3">
          {LEGACY.map((a) => (
            <div key={a.name} className="text-sm">
              <span className="text-zinc-300">{a.name}</span>
              <p className="text-zinc-500">{a.desc}</p>
            </div>
          ))}
        </div>
      </Card>

      <Card title="Recent Decisions">
        {error && <p className="text-sm text-amber-400">{error}</p>}
        {decisions.length === 0 && !error && (
          <p className="text-sm text-zinc-500">No agent decisions yet.</p>
        )}
        <div className="space-y-3 max-h-96 overflow-y-auto">
          {decisions.map((d) => (
            <div
              key={d.id}
              className="rounded-lg border border-zinc-800 bg-zinc-950/50 p-3"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium text-cyan-400">
                  {d.agent}
                </span>
                <span className="text-xs text-zinc-500">
                  {new Date(d.timestamp).toLocaleTimeString()}
                </span>
              </div>
              <p className="mt-1 text-xs text-zinc-500">{d.action}</p>
              <p className="mt-1 text-sm text-zinc-300">{d.reasoning}</p>
              {d.txDigest && (
                <a
                  href={`https://suiscan.xyz/testnet/tx/${d.txDigest}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-1 block text-xs text-cyan-500 hover:underline font-mono"
                >
                  {d.txDigest.slice(0, 20)}...
                </a>
              )}
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
