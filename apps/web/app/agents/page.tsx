"use client";

import { useEffect, useRef, useState } from "react";
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
  // R39 audit fix: `"legacy"` was a dead variant — the
  // /agents/manifest endpoint no longer emits it. Tightening
  // the type here surfaces any stale usage at compile time.
  kind: "primary";
}

interface HealthEnvelope {
  package_id?: string;
  deepbook_registry_id?: string;
  vault_id?: string;
  prize_pool_id?: string;
  parlay_pool_id?: string;
  streak_registry_id?: string;
  // R40 audit fix: the web bundle bakes
  // NEXT_PUBLIC_FEE_VAULT_ID into every mint/redeem PTB. The
  // agents /health payload now echoes `fee_vault_id`; the
  // drift detector surfaces a mismatch instead of silently
  // misrouting collateral to a non-existent fee vault.
  fee_vault_id?: string;
  // R39 audit fix: surface the resolved network, gRPC URL, and
  // referral-treasury address from the agents /health payload.
  // Without these the operator has no way to confirm the
  // agents service is talking to the cluster they expect (R34
  // fixed the gRPC client but the /health envelope never echoed
  // the resolved value) or that the referral-sweep destination
  // matches the web's expectation.
  network?: string;
  grpc_url?: string;
  referral_treasury_address?: string;
  // R46 audit fix: the agents /health payload now echoes
  // six more env-driven ids the web bundle consumes
  // (PRIZE_ADMIN_ID, PROFILE_REGISTRY_ID, ADMIN_ADDRESS,
  // PARLAY_ADMIN_ID, DEEPBOOK_POOL_ID, DEEPBOOK_POOL_KEY).
  // Without these on the envelope the drift detector
  // can't see a mismatch — a mainnet web bundle that
  // baked one NEXT_PUBLIC_* value but whose agents
  // service was deployed with a different runtime env
  // would silently break the corresponding PTB and the
  // operator dashboard would have no signal.
  prize_admin_id?: string;
  profile_registry_id?: string;
  admin_address?: string;
  parlay_admin_id?: string;
  deepbook_pool_id?: string;
  deepbook_pool_key?: string;
  ts_ms?: number;
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
  // R39 audit fix: the MarketStrategist/PLPManager/RedeemKeeper
  // entries were dead — the agents service's /agents/manifest
  // only registers primary agents, so the `kind: "legacy"`
  // branch in the UI never matched. Drop the legacy entries
  // (and the legacy filter / card further down) so a future
  // reader doesn't waste time looking for a path that wires
  // them up. The legacy Predict code under
  // `apps/web/app/legacy/predict/` is reachable directly and
  // is documented separately.
};

// Env-side ID values, used to detect drift between the web bundle and
// the agents runtime. The web inlines NEXT_PUBLIC_* values at build
// time, so a deploy that changes one but not the other bricks every
// PTB the web submits.
// R50 audit fix: validate SUI_NETWORK against the admin
// page's allowlist. The previous `?? "testnet"`
// fallback produced a malformed `https://.suivision.xyz/`
// URL when the env was set-but-empty, and a 404 for
// `localnet` (which isn't a valid SuiVision host). Mirror
// `app/admin/page.tsx:101-107`.
const SUI_NETWORKS = ["testnet", "mainnet", "devnet", "localnet"] as const;
type SuiNetwork = (typeof SUI_NETWORKS)[number];
const _rawNetwork = process.env.NEXT_PUBLIC_SUI_NETWORK ?? "testnet";
const SUI_NETWORK: SuiNetwork = (SUI_NETWORKS as readonly string[]).includes(
  _rawNetwork,
)
  ? (_rawNetwork as SuiNetwork)
  : "testnet";
const SUIVISION_TX_URL = `https://${SUI_NETWORK}.suivision.xyz/txblock/`;
const ENV_IDS: Array<{ env: string; label: string; runtimeKey: keyof HealthEnvelope }> = [
  { env: "NEXT_PUBLIC_AGENT_POLICY_PACKAGE_ID", label: "AGENT_POLICY_PACKAGE_ID", runtimeKey: "package_id" },
  { env: "NEXT_PUBLIC_DEEPBOOK_REGISTRY_ID", label: "DEEPBOOK_REGISTRY_ID", runtimeKey: "deepbook_registry_id" },
  { env: "NEXT_PUBLIC_VAULT_OBJECT_ID", label: "VAULT_OBJECT_ID", runtimeKey: "vault_id" },
  { env: "NEXT_PUBLIC_PRIZE_POOL_ID", label: "PRIZE_POOL_ID", runtimeKey: "prize_pool_id" },
  // R38 audit fix: track the parlay pool id as well. The agents
  // /health payload now returns `parlay_pool_id`; without this
  // ENV_IDS entry the drift detector would silently skip
  // mismatches between the web bundle's
  // `NEXT_PUBLIC_PARLAY_POOL_ID` and the agents runtime's
  // `PARLAY_POOL_ID` env, and a deploy that changes only one
  // would surface as a `parlay pool not found` move abort with
  // no operator visibility.
  { env: "NEXT_PUBLIC_PARLAY_POOL_ID", label: "PARLAY_POOL_ID", runtimeKey: "parlay_pool_id" },
  { env: "NEXT_PUBLIC_STREAK_REGISTRY_ID", label: "STREAK_REGISTRY_ID", runtimeKey: "streak_registry_id" },
  // R40 audit fix: track the fee vault id as well. The agents
  // /health payload now returns `fee_vault_id`; without this
  // ENV_IDS entry the drift detector would silently skip a
  // mismatch between the web bundle's
  // `NEXT_PUBLIC_FEE_VAULT_ID` and the agents runtime's
  // `FEE_VAULT_ID` env, and a deploy that changes only one
  // would surface as an `EPackageObjectNotFound` move abort
  // on every mint/redeem.
  { env: "NEXT_PUBLIC_FEE_VAULT_ID", label: "FEE_VAULT_ID", runtimeKey: "fee_vault_id" },
  // R39 audit fix: track the referral-treasury address so a
  // drift between the web bundle and the agents runtime
  // destination would surface here instead of silently
  // mis-routing the keeper's DeepBook-fee sweeps. The
  // `network` and `grpc_url` are surfaced separately below
  // because they have no env-key counterpart in the web
  // bundle — Next.js inlines the value of
  // `process.env.NEXT_PUBLIC_SUI_NETWORK` directly into the
  // dAppKit config (see `lib/dapp-kit.ts`).
  { env: "NEXT_PUBLIC_REFERRAL_TREASURY_ADDRESS", label: "REFERRAL_TREASURY_ADDRESS", runtimeKey: "referral_treasury_address" },
  // R46 audit fix: track the prize admin id (used by
  // `prize_pool::claim_with_signature` PTBs the
  // ClaimPrizeButton builds) and the profile registry id
  // (used by every `user_profile::*` PTB the settings
  // page builds). The agents /health payload now returns
  // both — without these ENV_IDS entries the drift
  // detector would silently skip a mismatch and a
  // deploy that changed one env but not the other
  // would surface as `object not found` move aborts
  // with no operator visibility.
  { env: "NEXT_PUBLIC_PRIZE_ADMIN_ID", label: "PRIZE_ADMIN_ID", runtimeKey: "prize_admin_id" },
  { env: "NEXT_PUBLIC_PROFILE_REGISTRY_ID", label: "PROFILE_REGISTRY_ID", runtimeKey: "profile_registry_id" },
  // R47 audit fix: R46 added the /health payload
  // entries for `admin_address`, `parlay_admin_id`,
  // `deepbook_pool_id`, and `deepbook_pool_key`
  // but only the first two of the six new
  // `ENV_IDS` entries were added here. The
  // remaining four are still consumed by web
  // pages (the parlay admin rotate / claim flows
  // use `parlay_admin_id`; the market maker
  // buttons and the /vault page use
  // `deepbook_pool_id` / `deepbook_pool_key`;
  // `admin_address` is the operator's
  // wallet) and a drift on any of them
  // would silently break the corresponding
  // PTB with `object not found`. Add the
  // four missing entries so the drift
  // detector surfaces the mismatch.
  { env: "NEXT_PUBLIC_ADMIN_ADDRESS", label: "ADMIN_ADDRESS", runtimeKey: "admin_address" },
  { env: "NEXT_PUBLIC_PARLAY_ADMIN_ID", label: "PARLAY_ADMIN_ID", runtimeKey: "parlay_admin_id" },
  { env: "NEXT_PUBLIC_DEEPBOOK_POOL_ID", label: "DEEPBOOK_POOL_ID", runtimeKey: "deepbook_pool_id" },
  { env: "NEXT_PUBLIC_DEEPBOOK_POOL_KEY", label: "DEEPBOOK_POOL_KEY", runtimeKey: "deepbook_pool_key" },
];

function driftLinesFor(h: HealthEnvelope): string[] {
  const lines: string[] = [];
  for (const { env, label, runtimeKey } of ENV_IDS) {
    const envVal = process.env[env] ?? "";
    const runtimeVal = String(h[runtimeKey] ?? "");
    // `AGENT_POLICY_PACKAGE_ID` comes from the SDK constant rather than
    // a raw env read because the SDK normalizes it across web/agents
    // (see packages/sdk/src/constants.ts).
    const localVal = label === "AGENT_POLICY_PACKAGE_ID" ? AGENT_POLICY_PACKAGE_ID : envVal;
    // R46 audit fix: don't silently skip rows where one
    // side is empty. The previous "skip on empty" guard
    // meant a missing runtime value (the agents service
    // crashed mid-`/health` write and emitted a partial
    // payload) would never surface as a drift — the
    // operator would just see "no drift detected" on
    // the dashboard while the web bundle submitted PTBs
    // against a runtime pool that no longer existed.
    // Surface an explicit "runtime value missing" line
    // so the operator can chase the agents service's
    // crashed boot.
    if (!runtimeVal) {
      lines.push(`${label}: runtime value missing from /health`);
      continue;
    }
    if (!localVal) {
      // Local-empty is a dev / mis-configured bundle,
      // not a runtime crash, but still worth surfacing
      // because it means the corresponding PTB is going
      // to a zero-id sentinel.
      lines.push(`${label}: web bundle has no ${env} set`);
      continue;
    }
    // R46 audit fix: case-insensitive comparison. Sui
    // addresses / object ids are case-sensitive on the
    // wire, but the on-chain runtime is happy to accept
    // any case mix when BCS-decoding. A web bundle
    // that baked `NEXT_PUBLIC_PRIZE_POOL_ID=0xAbC…` and
    // an agents runtime that read `PRIZE_POOL_ID=0xabc…`
    // from .env would have appeared as "drift detected"
    // here even though the on-chain PTB would have
    // succeeded. Normalize to lowercase before the
    // equality check so the dashboard only surfaces
    // *real* drift.
    if (runtimeVal.toLowerCase() !== localVal.toLowerCase()) {
      lines.push(
        `${label}: web=${localVal.slice(0, 10)}… runtime=${runtimeVal.slice(0, 10)}…`,
      );
    }
  }
  return lines;
}

export default function AgentsPage() {
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [manifest, setManifest] = useState<AgentManifestEntry[]>([]);
  const [error, setError] = useState("");
  const [drift, setDrift] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const base =
        process.env.NEXT_PUBLIC_AGENTS_URL ?? "http://localhost:3001";
      // Decouple the three fetches: a /decisions 5xx no longer hides
      // the manifest or the package-drift check (round-17 audit
      // finding #22). Each fetch is independently error-tolerant.
      const [decisionsRes, manifestRes, healthRes] = await Promise.allSettled([
        fetch(`${base}/decisions`),
        fetch(`${base}/agents/manifest`),
        fetch(`${base}/health`),
      ]);
      if (cancelled) return;

      if (decisionsRes.status === "fulfilled" && decisionsRes.value.ok) {
        setDecisions(await decisionsRes.value.json());
        setError("");
      } else if (decisionsRes.status === "rejected" || (decisionsRes.status === "fulfilled" && !decisionsRes.value.ok)) {
        setError("Start the agents service: `pnpm --filter @suipredict/agents dev`");
      }

      // Manifest may 404 on older agents builds; tolerate it by
      // falling back to an empty list (the page then shows a
      // "manifest unavailable" hint instead of crashing).
      if (manifestRes.status === "fulfilled" && manifestRes.value.ok) {
        setManifest(await manifestRes.value.json());
      }

      // /health returns the agents runtime's package id; if any of
      // the five baked-in IDs differ from the value in the web
      // bundle, every PTB the web submits will fail with `package
      // object not found` (or, for vault/registry ids, "object
      // not found"). Surface a per-id banner so the operator can
      // rebuild with the right NEXT_PUBLIC_* values.
      if (healthRes.status === "fulfilled" && healthRes.value.ok) {
        const h = (await healthRes.value.json()) as HealthEnvelope;
        setDrift(driftLinesFor(h));
      }
    }
    void load();
    // R41 audit fix: backoff the poll when the agents service is
    // unreachable. Hammering at 8s during a 5xx storm wastes the
    // user's battery, fills the agents log with retries, and
    // competes with the indexer's own recovery once the service
    // comes back. After a 5xx we slow the next poll to 30s; on
    // a successful response we resume 8s polling.
    //
    // R43 audit fix: pause the tick entirely when the tab is
    // hidden. A backgrounded tab previously fired an 8s poll
    // per `tick()` against the agents service (the visibility
    // guard that R42 added to markets/[id], vault, and parlay
    // was not applied to this setInterval). Skipping the load
    // when the tab is hidden means a 1h backgrounded tab fires
    // zero agents requests, and the next `load()` runs the
    // instant the user switches back.
    let backoffMs = 8000;
    const tick = () => {
      if (cancelled) return;
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      void load();
      // Adjust the next poll based on what the just-finished
      // load() saw. `error` is read via the `errorRef` so the
      // tick closure observes the latest value without the
      // effect re-binding on every error change (R46 audit).
      const next = errorRef.current ? 30_000 : 8_000;
      if (next !== backoffMs) {
        backoffMs = next;
        clearInterval(id);
        if (!cancelled) {
          id = setInterval(tick, backoffMs);
        }
      }
    };
    let id: ReturnType<typeof setInterval> = setInterval(tick, backoffMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
    // The effect intentionally re-runs on `error` changes so
    // the next interval restart can pick up the new backoff
    // value. `error` is the only state-derived dependency
    // needed for the tick closure.
    //
    // R46 audit fix: capture `error` in a ref so the
    // effect doesn't re-bind the interval on every
    // `error` change. The previous effect had
    // `[error]` in its dep array, which meant a
    // transient 5xx (or a successful response
    // clearing the error string) would tear down the
    // interval, clear the backoff, and re-create the
    // interval from scratch — losing the
    // already-elapsed time and (worse) clobbering any
    // in-flight fetch from the previous tick. The
    // ref-based read lets the effect re-mount exactly
    // once and the tick closure observe the latest
    // `error` value via `errorRef.current` without
    // the interval itself being rebound.
  }, []);
  const errorRef = useRef(error);
  useEffect(() => {
    errorRef.current = error;
  }, [error]);

  const primary = manifest.filter((a) => a.kind === "primary");
  // R39 audit fix: drop the `legacy` filter and the dead card
  // below. The agents service's /agents/manifest never emits
  // `kind: "legacy"` entries, so this was always `[]`. See
  // `apps/agents/src/index.ts:345` (the manifest handler) for
  // the corresponding agents-side cleanup.

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-transparent bg-clip-text bg-gradient-to-r from-white to-cyan-200">Agent Dashboard</h1>
        <p className="mt-2 text-zinc-400">
          Autonomous CLOB agents (creator, maker, resolver) plus optional legacy
          DeepBook Predict agents
        </p>
      </div>

      {drift.length > 0 && (
        <div
          role="alert"
          className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-4 text-sm text-rose-200"
        >
          <p className="font-semibold">Config id drift detected</p>
          <ul className="mt-1 list-disc pl-5 text-rose-300/80">
            {drift.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-rose-300/70">
            Redeploy the web bundle (run <code>pnpm build</code> after
            setting the matching <code>NEXT_PUBLIC_*</code> env) so the
            bundled ids match the agents runtime.
          </p>
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
                  // R34 audit fix: hard-coded testnet explorer link
                  // broke on mainnet. Reuse the same env-driven
                  // SUI_NETWORK pattern as admin/page.tsx so the
                  // link tracks the rest of the stack. SuiVision is
                  // the explorer the admin page uses; matches its
                  // txblock path. Fall back to testnet for local dev
                  // to preserve the pre-R34 default.
                  href={`${SUIVISION_TX_URL}${d.txDigest}`}
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
