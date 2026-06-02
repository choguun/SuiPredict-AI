"use client";

import { useEffect, useState } from "react";
import { AGENT_POLICY_PACKAGE_ID } from "@suipredict/sdk";
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

interface AgentManifestEntry {
  name: string;
  cron: string;
  kind: "primary" | "legacy";
}

/** Short description for an agent, shown on the manifest card. Falls
 *  back to a generic line for agents added after the r15 wiring. */
const AGENT_DESCRIPTIONS: Record<string, string> = {
  MarketCreator: "Proposes and creates binary markets (LLM + rules)",
  MarketMaker: "Quotes YES bid/ask from vault allocation on CLOB",
  MarketResolver: "Resolves expired markets via oracle + LLM confidence",
  RiskMonitor: "Pauses agent policy on critical utilization",
  ReferralKeeper: "Sweeps DeepBook trading-fee rebates to treasury",
  PositionIndexer: "Polls on-chain events into the off-chain SQLite",
  StreakSweeper: "Records daily participation for streak tracking",
  LeaderboardWorker: "Weekly rollup of daily scores to weekly archive",
  PrizeAdmin: "Funds the weekly prize pool and signs claim payloads",
  PrizeDistributor: "Auto-claims top-10 prizes for the prior week",
  MarketStrategist: "Legacy Predict BTC mints",
  PLPManager: "Legacy dUSDC PLP supply",
  RedeemKeeper: "Legacy permissionless redeem",
};

export default function AgentsPage() {
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [manifest, setManifest] = useState<AgentManifestEntry[]>([]);
  const [error, setError] = useState("");
  const [drift, setDrift] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const base =
          process.env.NEXT_PUBLIC_AGENTS_URL ?? "http://localhost:3001";
        const [decisionsRes, manifestRes, healthRes] = await Promise.all([
          fetch(`${base}/decisions`),
          fetch(`${base}/agents/manifest`),
          fetch(`${base}/health`),
        ]);
        if (!decisionsRes.ok) throw new Error("Agent service unavailable");
        setDecisions(await decisionsRes.json());
        // Manifest may 404 on older agents builds; tolerate it by
        // falling back to an empty list (the page then shows a
        // "manifest unavailable" hint instead of crashing).
        if (manifestRes.ok) {
          setManifest(await manifestRes.json());
        }
        // /health returns the agents runtime's package id; if it
        // differs from the value baked into the web bundle at build
        // time, every PTB the web submits will fail with
        // `package object not found`. Surface a banner so the
        // operator redeploys the web bundle after a package update.
        if (healthRes.ok) {
          const h = (await healthRes.json()) as { package_id?: string };
          const runtime = h.package_id ?? "";
          if (
            runtime &&
            AGENT_POLICY_PACKAGE_ID &&
            runtime !== AGENT_POLICY_PACKAGE_ID
          ) {
            setDrift(
              `Web bundle package id ${AGENT_POLICY_PACKAGE_ID.slice(0, 10)}… ` +
                `differs from agents runtime ${runtime.slice(0, 10)}… . ` +
                "Redeploy the web bundle (run `pnpm build` after `NEXT_PUBLIC_AGENT_POLICY_PACKAGE_ID` is set).",
            );
          } else {
            setDrift(null);
          }
        }
        setError("");
      } catch {
        setError("Start agents with: pnpm dev:agents");
      }
    }
    load();
    const id = setInterval(load, 8000);
    return () => clearInterval(id);
  }, []);

  const primary = manifest.filter((a) => a.kind === "primary");
  const legacy = manifest.filter((a) => a.kind === "legacy");

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-transparent bg-clip-text bg-gradient-to-r from-white to-cyan-200">Agent Dashboard</h1>
        <p className="mt-2 text-zinc-400">
          Autonomous CLOB agents (creator, maker, resolver) plus optional legacy
          DeepBook Predict agents
        </p>
      </div>

      {drift && (
        <div
          role="alert"
          className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-4 text-sm text-rose-200"
        >
          <p className="font-semibold">Package id drift detected</p>
          <p className="mt-1 text-rose-300/80">{drift}</p>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        {primary.length === 0 && !error && (
          <Card className="border-white/10 sm:col-span-2">
            <p className="text-sm text-zinc-500">
              No agent manifest yet — the agents service is still starting, or
              it predates the r15 /agents/manifest endpoint.
            </p>
          </Card>
        )}
        {primary.map((a) => (
          <Card key={a.name} className="border-white/10">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-cyan-300 drop-shadow-sm">{a.name}</h3>
              <Badge variant="success">Primary</Badge>
            </div>
            <p className="mt-2 text-sm text-zinc-400">
              {AGENT_DESCRIPTIONS[a.name] ?? "Autonomous SuiPredict agent."}
            </p>
            <p className="mt-2 text-xs font-mono text-zinc-600">
              cron: <span className="text-zinc-400">{a.cron}</span> (UTC)
            </p>
          </Card>
        ))}
      </div>

      {legacy.length > 0 && (
        <Card title="Legacy Predict agents (optional)" className="border-white/10">
          <p className="text-xs text-zinc-500 mb-4">
            Enable with ENABLE_LEGACY_PREDICT_AGENTS=true
          </p>
          <div className="grid gap-4 sm:grid-cols-3">
            {legacy.map((a) => (
              <div key={a.name} className="text-sm rounded-xl border border-white/5 bg-black/20 p-3">
                <span className="font-medium text-zinc-300 block mb-1">{a.name}</span>
                <p className="text-zinc-500 text-xs">
                  {AGENT_DESCRIPTIONS[a.name] ?? "Legacy Predict agent."}
                </p>
                <p className="mt-1 text-[10px] font-mono text-zinc-700">
                  cron: {a.cron}
                </p>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card title="Recent Decisions" className="border-white/10">
        {error && <p className="text-sm text-amber-400 mb-3">{error}</p>}
        {decisions.length === 0 && !error && (
          <p className="text-sm text-zinc-500">No agent decisions yet.</p>
        )}
        <div className="space-y-3 max-h-96 overflow-y-auto pr-2 custom-scrollbar">
          {decisions.map((d) => (
            <div
              key={d.id}
              className="rounded-xl border border-white/10 bg-black/20 p-4 backdrop-blur-sm transition-all hover:bg-white/5"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-semibold text-cyan-400">
                  {d.agent}
                </span>
                <span className="text-xs text-zinc-500">
                  {new Date(d.timestamp).toLocaleTimeString()}
                </span>
              </div>
              <p className="mt-1.5 text-xs font-mono text-zinc-500">{d.action}</p>
              <p className="mt-2 text-sm text-zinc-300 leading-relaxed">{d.reasoning}</p>
              {d.txDigest && (
                <a
                  href={`https://suiscan.xyz/testnet/tx/${d.txDigest}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-3 inline-block rounded-md bg-cyan-500/10 px-2 py-1 text-xs font-mono text-cyan-400 hover:bg-cyan-500/20 transition-colors"
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
