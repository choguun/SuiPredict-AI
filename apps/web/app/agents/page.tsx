"use client";

import { useEffect, useRef, useState } from "react";
import { AGENT_POLICY_PACKAGE_ID } from "@suipredict/sdk";
import { toast } from "sonner";
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
  // R-WC-1.3 fix: deepbook_package_id is the
  // source-of-truth DEEPBOOK_PACKAGE_ID for the
  // SDK's createDeepBookClient. Pre-fix this was
  // missing from the agents /health payload, so the
  // web bundle's drift detector couldn't catch a
  // missing NEXT_PUBLIC_DEEPBOOK_PACKAGE_ID.
  deepbook_package_id?: string;
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

// R-WC-1.2 fix: type the wc-creator's
// CoinRegistry circuit-breaker state so the
// /agents page can render a "Registry FULL"
// banner + first-error details + a manual
// reset button. Source of truth:
// apps/agents/src/agents/wc-creator-circuit-breaker.ts
interface CircuitBreakerState {
  coinRegistryFull: boolean;
  firstErrorAt: number | null;
  firstErrorMarket: string | null;
  resetAt: number | null;
  resetReason: string | null;
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
  ParlayWorker: "Builds multi-leg parlays within the agent-policy budget",
  WorldCupCreator: "Scrapes Wikipedia → drops YES/NO markets for upcoming WC fixtures",
  WorldCupResolver: "Scrapes per-group Wikipedia pages → resolves expired WC markets",
  WorldCupMaker: "Elo-based mid-price + time-decay spread on upcoming matches",
  WebExtractor: "LLM-powered web scraper → cross-source verification (Wikipedia, ESPN, BBC, …)",
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
//
// R51 audit fix: drop "localnet" from the allowlist so
// the membership check now falls through to the
// "testnet" default. See admin/page.tsx for the
// rationale.
const SUI_NETWORKS = ["testnet", "mainnet", "devnet"] as const;
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
  // R-WC-1.3 fix: track DEEPBOOK_PACKAGE_ID. Pre-fix,
  // this env var was missing from the web's
  // `.env.local` and the SDK silently passed an empty
  // string into the moveCall `typeArguments` for
  // `shareBalanceManager`, which the on-chain BCS
  // resolver rejected with the cryptic
  // "Encountered unexpected token when parsing type
  // args for ::balance_manager::BalanceManager"
  // error every time a user clicked "Setup Trading
  // Account". The new ENV_IDS entry surfaces a
  // missing/empty `NEXT_PUBLIC_DEEPBOOK_PACKAGE_ID`
  // in the `/agents` drift panel so a fresh deploy
  // catches the omission before the user hits the
  // wallet spinner.
  { env: "NEXT_PUBLIC_DEEPBOOK_PACKAGE_ID", label: "DEEPBOOK_PACKAGE_ID", runtimeKey: "deepbook_package_id" },
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

// Server-resolved env values. The drift detector runs in a
// "use client" component where `process.env.NEXT_PUBLIC_X`
// is `undefined` (Next.js inlines these at build time and
// the browser has no `process`). We fetch the server-side
// values from `/api/web-config` and use the SDK constant
// for `AGENT_POLICY_PACKAGE_ID` (which the SDK normalizes
// across web/agents). The fetch is initiated on first
// mount of the page; if it fails, the page falls back to
// an empty object (and every entry is reported as
// "web bundle has no X set" — same behaviour as the
// pre-fix build).
type WebConfig = Partial<Record<keyof HealthEnvelope | "package_id" | "referral_treasury_address" | "admin_address" | "parlay_admin_id" | "deepbook_pool_id" | "deepbook_pool_key" | "prize_admin_id" | "profile_registry_id", string>>;

const WEB_CONFIG: WebConfig = {
  // `process.env` is `undefined` in the browser, so this
  // object is effectively `{ ...all empty strings }` when
  // the page is hydrated in the browser. The
  // `load()` effect below fetches the real values from
  // `/api/web-config` and overwrites this with the
  // server-side resolution.
  package_id: "",
  deepbook_registry_id: "",
  vault_id: "",
  prize_pool_id: "",
  parlay_pool_id: "",
  streak_registry_id: "",
  fee_vault_id: "",
  referral_treasury_address: "",
  prize_admin_id: "",
  profile_registry_id: "",
  admin_address: "",
  parlay_admin_id: "",
  deepbook_pool_id: "",
  deepbook_pool_key: "",
};

// Re-implement driftLinesFor to use WEB_CONFIG instead of
// `process.env[env]` (which is `undefined` in the browser).
// Same semantics: a row is a drift when (a) the runtime
// is empty (agents crashed mid-`/health` write), (b) the
// web bundle is empty (the corresponding PTB sends a
// zero-id sentinel), or (c) the case-insensitive values
// differ.
function driftLinesForWebConfig(h: HealthEnvelope, web: WebConfig): string[] {
  const lines: string[] = [];
  for (const { env, label, runtimeKey } of ENV_IDS) {
    const runtimeVal = String(h[runtimeKey as keyof HealthEnvelope] ?? "");
    const localVal = label === "AGENT_POLICY_PACKAGE_ID" ? AGENT_POLICY_PACKAGE_ID : (web[runtimeKey as keyof WebConfig] ?? "");
    if (!runtimeVal) {
      lines.push(`${label}: runtime value missing from /health`);
      continue;
    }
    if (!localVal) {
      lines.push(`${label}: web bundle has no ${env} set`);
      continue;
    }
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
  // UAT-FN-02 fix: keep the most recent health
  // envelope and web-config snapshot in state so the
  // DriftDetails component can render structured
  // key/value rows (one per drifted env) and a
  // "Copy .env line" button per row. Without this
  // state the disclosure would only see the
  // pre-formatted drift strings and could not
  // surface the env var name + the runtime value
  // (the env var name is the only key the operator
  // needs to paste into `.env.local`).
  const [healthSnapshot, setHealthSnapshot] = useState<HealthEnvelope | null>(null);
  const [webConfigSnapshot, setWebConfigSnapshot] = useState<WebConfig | null>(null);
  // R-WC-1.2 fix: persist the wc-creator
  // circuit-breaker state. When `coinRegistryFull`
  // is true the wc-creator is short-circuiting (no
  // PTB calls, no gas spend) — a much better UX
  // than spamming 44 identical MoveAborts every
  // 15 min. The page renders a banner explaining
  // the trip + a one-click reset.
  const [circuitBreaker, setCircuitBreaker] = useState<CircuitBreakerState | null>(null);
  const [resetting, setResetting] = useState(false);

  // R-WC-1.2 fix: refresh the circuit-breaker
  // state on demand (called from the "Reset"
  // button below the trip banner). The /agents
  // page re-fetches on every navigation, but
  // the reset action needs a way to update the
  // local state without a full page reload.
  const refreshCircuitBreaker = async () => {
    const base = process.env.NEXT_PUBLIC_AGENTS_URL ?? "http://localhost:3001";
    try {
      const r = await fetch(`${base}/wc/circuit-breaker`);
      if (r.ok) {
        setCircuitBreaker((await r.json()) as CircuitBreakerState);
      }
    } catch {
      // ignore
    }
  };

  const resetCircuitBreaker = async () => {
    if (resetting) return;
    setResetting(true);
    const base = process.env.NEXT_PUBLIC_AGENTS_URL ?? "http://localhost:3001";
    try {
      const r = await fetch(`${base}/wc/circuit-breaker`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reset" }),
      });
      if (r.ok) {
        setCircuitBreaker((await r.json()) as CircuitBreakerState);
        toast.success("CoinRegistry circuit-breaker reset. wc-creator will retry on the next tick.");
      } else {
        toast.error(`Reset failed: HTTP ${r.status}`);
      }
    } catch (e) {
      toast.error("Reset failed: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setResetting(false);
    }
  };

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
      } else if (decisionsRes.status === "fulfilled" && !decisionsRes.value.ok) {
        // R56.21 audit fix: distinguish "service is up but
        // the endpoint errored" from "service is down". A
        // 5xx from `/decisions` (e.g. an empty `decisions`
        // table joining against a missing market id) was
        // previously shown as "Start the agents service…"
        // — misleading when the service is actually
        // running. 4xx is the same path (bad URL or
        // schema migration); the operator is best served
        // by the agents log either way.
        setError(
          `Agents service is up but /decisions returned HTTP ${decisionsRes.value.status}. ` +
            "Check the agents log for the underlying error.",
        );
      } else if (decisionsRes.status === "rejected") {
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
        // Fetch the web bundle's NEXT_PUBLIC_* values from
        // the server-side `/api/web-config` route. The page
        // is a "use client" component, so `process.env` is
        // unavailable; the constant `WEB_CONFIG` is the
        // server-rendered substitute. Fall back to it
        // gracefully if the API route 5xx's.
        //
        // The API returns keys prefixed with `NEXT_PUBLIC_`
        // (matching the env var names). Translate them to
        // the runtime keys the drift detector looks up
        // (e.g. `NEXT_PUBLIC_DEEPBOOK_REGISTRY_ID` →
        // `deepbook_registry_id`). The translation map
        // is the same `ENV_IDS` array we already iterate.
        let webCfg: WebConfig = WEB_CONFIG;
        try {
          const cfgRes = await fetch("/api/web-config", { cache: "no-store" });
          if (cfgRes.ok) {
            const raw = (await cfgRes.json()) as Record<string, string>;
            const mapped: WebConfig = {};
            for (const { env, runtimeKey } of ENV_IDS) {
              const v = raw[env];
              if (v != null) {
                (mapped as Record<string, string>)[runtimeKey] = v;
              }
            }
            webCfg = mapped;
          }
        } catch {
          /* keep WEB_CONFIG fallback */
        }
        // UAT-FN-02 fix: stash the latest
        // health envelope + web config in
        // state so the DriftDetails
        // component (rendered inside the
        // disclosure) can show structured
        // rows with copy buttons. The
        // existing `setDrift(...)` still
        // drives the row count and the
        // "out of sync" header copy.
        setHealthSnapshot(h);
        setWebConfigSnapshot(webCfg);
        setDrift(driftLinesForWebConfig(h, webCfg));
      }
      // R-WC-1.2 fix: also fetch the wc-creator
      // circuit-breaker state. Independent from
      // /health (a 5xx on /health shouldn't
      // hide the circuit-breaker banner; the
      // operator may be debugging exactly that
      // case).
      void refreshCircuitBreaker();
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
    //
    // R57.M7 audit fix: revert to setTimeout-chained polling.
    // The R56.19 migration to `setInterval` + re-arm had two
    // residual issues:
    //   (a) The `let id = setInterval(tick, backoffMs)` on the
    //       last line is hoisted; the `clearInterval(id)` inside
    //       `tick` reads `undefined` on the first tick and
    //       silently no-ops.
    //   (b) The cleanup only stops the next tick — the
    //       in-flight `load()` continues and its setState is
    //       a setState-after-unmount warning.
    // The setTimeout-chained form is cleaner about both: the
    // timer id is local to each tick, and the in-flight fetch
    // is aborted via the same `cancelled` flag pattern.
    let backoffMs = 8000;
    const tick = () => {
      if (cancelled) return;
      if (typeof document !== "undefined" && document.visibilityState !== "visible") {
        // Hidden tab — re-schedule without firing `load()`.
        // The browser fires the `visibilitychange` event when
        // the tab flips back, but `load()` is cheap and
        // re-arming on the next visibility-flip is a one-line
        // event listener that's omitted here for symmetry with
        // the R42 setInterval pattern. The user re-focusing
        // the tab is the only signal we need; the next
        // setTimeout fires it.
        setTimeout(tick, 1000);
        return;
      }
      void load().finally(() => {
        if (cancelled) return;
        backoffMs = errorRef.current ? 30_000 : 8_000;
        setTimeout(tick, backoffMs);
      });
    };
    setTimeout(tick, backoffMs);
    return () => {
      cancelled = true;
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
      {/* R30 sweep fix: gradient hero header
          consistent with /worldcup, /markets,
          /friends, /vault, etc. The previous
          build was a bare 1-line h1 with no
          visual weight. The new hero names the
          "autonomous fleet" as the platform's
          key differentiator, surfaces the live
          count of registered agents (the
          manifest length), and includes a
          short blurb on what the agents
          actually do. */}
      <div className="relative overflow-hidden rounded-3xl border border-white/10 bg-panel-strong p-6 sm:p-10 shadow-2xl shadow-black/40">
        <div className="absolute -top-40 -right-40 h-[400px] w-[400px] rounded-full bg-cyan-600/10 blur-[80px] pointer-events-none" />
        <div className="absolute -bottom-40 -left-40 h-[400px] w-[400px] rounded-full bg-violet-600/10 blur-[80px] pointer-events-none" />
        <div className="relative z-10 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="mb-2 inline-flex items-center gap-2 text-[10px] font-bold uppercase tracking-wider text-cyan-400">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-cyan-400 opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-cyan-400" />
              </span>
              Live
            </div>
            <h1 className="text-3xl font-extrabold tracking-tight text-transparent bg-clip-text bg-gradient-to-r from-white to-cyan-200 sm:text-4xl">
              Agent Dashboard
            </h1>
            <p className="mt-2 max-w-2xl text-sm text-zinc-400 sm:text-base">
              {manifest.length > 0
                ? `${manifest.length} autonomous workers run the exchange end-to-end — create markets, quote spreads, resolve outcomes, settle parlays, distribute weekly prizes.`
                : "Autonomous CLOB agents (creator, maker, resolver) plus optional legacy DeepBook Predict agents"}
            </p>
          </div>
          <div className="flex flex-col items-end gap-1 rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-right">
            <p className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">
              Active agents
            </p>
            <p className="font-mono text-2xl font-extrabold text-white">
              {manifest.length}
            </p>
          </div>
        </div>
      </div>

      {/* R-WC-1.2 fix: CoinRegistry circuit-breaker
          banner. Sits above the drift panel so a
          tripped breaker is the first thing the
          operator sees. The banner explains the
          CoinRegistry limit, the trip time, the
          market that hit the limit, and offers a
          one-click "Reset" action (in case the
          operator manually cleared the limit by
          redeploying the contract). The reset
          action POSTs to /wc/circuit-breaker
          which clears the local state file. */}
      {circuitBreaker?.coinRegistryFull && (
        <div className="rounded-2xl border border-amber-500/30 bg-amber-500/5 p-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex-1 space-y-2">
              <div className="flex items-center gap-2">
                <span className="inline-flex h-2 w-2 rounded-full bg-amber-400" />
                <h2 className="text-sm font-extrabold uppercase tracking-wider text-amber-200">
                  CoinRegistry is FULL
                </h2>
              </div>
              <p className="text-sm text-amber-200/80 leading-relaxed">
                The Sui system <code className="rounded bg-black/30 px-1 font-mono text-[10px]">CoinRegistry</code> at
                <code className="mx-1 rounded bg-black/30 px-1 font-mono text-[10px]">0xc</code>
                allows only one <code className="rounded bg-black/30 px-1 font-mono text-[10px]">Currency&lt;YES&lt;DUSDC&gt;&gt;</code> per package.
                The <code className="rounded bg-black/30 px-1 font-mono text-[10px]">world-cup-creator</code> agent tripped the circuit-breaker after the first
                market already registered a <code className="rounded bg-black/30 px-1 font-mono text-[10px]">Currency</code>;
                every subsequent market aborts with <code className="rounded bg-black/30 px-1 font-mono text-[10px]">ECurrencyAlreadyExists</code>.
                The agent is now short-circuiting (no PTB calls, no gas spend).
              </p>
              <dl className="grid gap-2 text-xs sm:grid-cols-2">
                <div>
                  <dt className="text-amber-200/60">Tripped at</dt>
                  <dd className="font-mono text-amber-200">
                    {circuitBreaker.firstErrorAt
                      ? new Date(circuitBreaker.firstErrorAt).toISOString()
                      : "—"}
                  </dd>
                </div>
                <div>
                  <dt className="text-amber-200/60">Tripped by market</dt>
                  <dd className="font-mono text-amber-200">
                    {circuitBreaker.firstErrorMarket ?? "—"}
                  </dd>
                </div>
                {circuitBreaker.resetAt && (
                  <>
                    <div>
                      <dt className="text-amber-200/60">Last reset</dt>
                      <dd className="font-mono text-amber-200">
                        {new Date(circuitBreaker.resetAt).toISOString()} ({circuitBreaker.resetReason})
                      </dd>
                    </div>
                  </>
                )}
              </dl>
              <p className="text-xs text-amber-200/70 leading-relaxed">
                <strong className="text-amber-200">Long-term fix:</strong> the
                contract must be upgraded to use per-market coin types
                (<code className="rounded bg-black/30 px-1 font-mono text-[10px]">YES&lt;DUSDC, MarketId&gt;</code>).
                Until then, the <code className="rounded bg-black/30 px-1 font-mono text-[10px]">wc26-A1v4</code> demo
                market is the only tradeable WC market. See <code className="rounded bg-black/30 px-1 font-mono text-[10px]">docs/SOP-DEPLOYMENT.md#coinregistry-limit</code> for the full deploy story.
              </p>
            </div>
            <button
              type="button"
              onClick={resetCircuitBreaker}
              disabled={resetting}
              className="self-start rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-amber-200 hover:bg-amber-500/20 disabled:opacity-50"
            >
              {resetting ? "Resetting…" : "Reset breaker"}
            </button>
          </div>
        </div>
      )}

      {drift.length > 0 && (
        // UAT-FN-15 fix: the pre-fix drift
        // panel was a bright rose-500 alert
        // box that dominated the page. A
        // first-time user landing on
        // /agents would interpret it as a
        // critical product bug (and the
        // long technical message about
        // `pnpm build` and
        // `NEXT_PUBLIC_*` env is not
        // actionable for a customer). The
        // new design:
        //   - amber instead of rose (the
        //     same tone the rest of the app
        //     uses for "operator should look
        //     at this" hints, e.g. the
        //     DailyPredictionCard's
        //     "no DUSDC" amber box)
        //   - the long drift list is hidden
        //     behind a "Show details"
        //     disclosure so the casual
        //     visitor doesn't see the wall
        //     of hex-truncated ids
        //   - the customer-facing copy
        //     leads with "We're still
        //     working normally" so the
        //     user doesn't think the app is
        //     broken
        //   - the technical fix message is
        //     now inside the disclosure
        //     (only operators who click
        //     through see it)
        //
        // UAT-FN-02 fix: the disclosure
        // previously listed drift as a
        // bare text line like
        //   `AGENT_POLICY_PACKAGE_ID: web=0x23b78ca… runtime=0xb1777f16…`
        // with no way for the operator to
        // act on it short of manually
        // diffing the values and typing
        // them into `.env.local`. The new
        // panel renders each drift as a
        // structured `env_key` / web value
        // / runtime value row with a
        // "Copy .env line" button. A
        // "Copy all .env lines" button
        // at the top of the disclosure
        // builds a single block of
        // `<KEY>=<RUNTIME_VALUE>` lines
        // the operator can paste into
        // `apps/web/.env.local` (or feed
        // to the matching agents-side
        // var). The drift detection now
        // also surfaces a single "missing
        // runtime value" row in the
        // same shape, so the operator
        // knows exactly which env the
        // agents service is missing.
        <div
          role="status"
          className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-100"
        >
          <div className="flex items-start gap-2">
            <span aria-hidden="true">⚙️</span>
            <div className="min-w-0 flex-1">
              <p className="font-semibold">
                Operator note: {drift.length} env id
                {drift.length === 1 ? "" : "s"} out of sync
              </p>
              <p className="mt-1 text-xs text-amber-200/80">
                The web bundle and the agents service are reading
                different config ids. The app still works for the
                current page (read-only diagnostics) but on-chain
                actions that hit the drifted ids will fail. This is
                an operator concern, not a customer issue.
              </p>
              <details className="mt-2">
                <summary className="cursor-pointer text-xs font-semibold text-amber-200 hover:text-amber-100">
                  Show details ({drift.length})
                </summary>
                <DriftDetails
                  drift={drift}
                  health={healthSnapshot}
                  webConfig={webConfigSnapshot}
                />
                <p className="mt-2 text-[11px] text-amber-200/70">
                  Fix: redeploy the web bundle (<code>pnpm build</code>
                  {" "}after setting the matching
                  {" "}<code>NEXT_PUBLIC_*</code> env) so the bundled ids
                  match the agents runtime.
                </p>
              </details>
            </div>
          </div>
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
          <div className="rounded-xl border border-dashed border-white/10 bg-white/[0.02] p-6 text-center">
            <div className="mb-2 text-2xl">🛰️</div>
            <p className="text-sm text-zinc-300">No agent decisions yet.</p>
            <p className="mt-1 text-xs text-zinc-500">
              The first tick of the fleet lands within a minute of starting the
              agents service.
            </p>
          </div>
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

/**
 * Structured per-drift table rendered inside the
 * `Operator note` disclosure. UAT-FN-02: the pre-fix
 * disclosure listed drift as a flat text line per entry
 * (e.g. `AGENT_POLICY_PACKAGE_ID: web=0x23b78ca… runtime=0xb1777f16…`)
 * which left the operator with two things to do by hand:
 *   1. Identify which env var to add/change.
 *   2. Compose the `KEY=value` line for `.env.local`.
 * The new component renders a table with one row per
 * drift entry, the env var name in the first column
 * (copy-pastable), the web value in the second, the
 * runtime value in the third, and a "Copy .env line"
 * button in the fourth. A "Copy all .env lines" button
 * at the top of the disclosure builds a single block of
 * `KEY=RUNTIME_VALUE` lines the operator can paste
 * into `.env.local` and then run `pnpm build` to
 * re-inline the values into the web bundle.
 *
 * Renders nothing on the rare path where the drift
 * strings are present but the health / webConfig
 * snapshots haven't been captured yet (the parent
 * already renders an empty disclosure in that case).
 */
function DriftDetails({
  drift,
  health,
  webConfig,
}: {
  drift: string[];
  health: HealthEnvelope | null;
  webConfig: WebConfig | null;
}) {
  if (!health || !webConfig || drift.length === 0) {
    // Fallback to the original flat list when the
    // structured snapshots aren't available.
    return (
      <ul className="mt-2 list-disc space-y-0.5 pl-5 font-mono text-[11px] text-amber-200/80">
        {drift.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    );
  }

  // Build the structured rows by walking ENV_IDS and
  // matching each drifted line to the corresponding
  // entry. We use the same `runtimeKey` lookup the
  // drift detector uses, so a row is "drifted" iff the
  // web value differs from the runtime value (or one
  // side is empty). Render the full id (not the
  // pre-truncated slice) in the table; the operator
  // needs the full id to paste into `.env.local`.
  const rows: Array<{
    env: string;
    label: string;
    webVal: string;
    runtimeVal: string;
  }> = [];
  for (const { env, label, runtimeKey } of ENV_IDS) {
    const runtimeVal = String(health[runtimeKey] ?? "");
    const webVal =
      label === "AGENT_POLICY_PACKAGE_ID"
        ? AGENT_POLICY_PACKAGE_ID
        : (webConfig[runtimeKey as keyof WebConfig] ?? "");
    const isWebEmpty = !webVal;
    const isRuntimeEmpty = !runtimeVal;
    const isMismatch =
      !isWebEmpty && !isRuntimeEmpty && webVal.toLowerCase() !== runtimeVal.toLowerCase();
    if (!(isWebEmpty || isRuntimeEmpty || isMismatch)) continue;
    rows.push({ env, label, webVal, runtimeVal });
  }

  // Sort: web-empty first (the operator needs to add a
  // brand-new line), then runtime-empty, then mismatches.
  // The original `drift` array preserves this order too
  // (driftLinesForWebConfig checks in the same sequence),
  // but re-sorting here keeps the structured table in
  // lock-step with the disclosure title's count.
  rows.sort((a, b) => {
    const aKey = a.webVal ? (a.runtimeVal ? 2 : 1) : 0;
    const bKey = b.webVal ? (b.runtimeVal ? 2 : 1) : 0;
    return aKey - bKey;
  });

  if (rows.length === 0) return null;

  // Build a single .env block for the "Copy all" button.
  // The .env file format requires `KEY=VALUE` with no
  // spaces around `=`; the runtime value is the
  // canonical source of truth so the operator is
  // aligning the web bundle to the agents runtime, not
  // the other way around.
  const envBlock = rows
    .filter((r) => r.runtimeVal)
    .map((r) => `${r.env}=${r.runtimeVal}`)
    .join("\n");

  return (
    <div className="mt-2 space-y-2">
      {envBlock && (
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard
              .writeText(envBlock)
              .then(() => {
                toast.success(
                  `Copied ${rows.filter((r) => r.runtimeVal).length} .env lines to clipboard`,
                );
              })
              .catch(() => {
                toast.error("Clipboard write failed — copy manually below");
              });
          }}
          className="inline-flex items-center gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/20 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-amber-100 hover:bg-amber-500/30 transition"
        >
          📋 Copy all .env lines
        </button>
      )}
      <div className="overflow-x-auto rounded-md border border-amber-500/20">
        <table className="w-full text-[11px]">
          <thead className="bg-amber-500/10 text-amber-200">
            <tr>
              <th className="px-2 py-1 text-left font-semibold uppercase tracking-wider">
                Env var
              </th>
              <th className="px-2 py-1 text-left font-semibold uppercase tracking-wider">
                Web bundle
              </th>
              <th className="px-2 py-1 text-left font-semibold uppercase tracking-wider">
                Agents runtime
              </th>
              <th className="px-2 py-1 text-right font-semibold uppercase tracking-wider">
                Action
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-amber-500/10 font-mono text-amber-200/90">
            {rows.map((r) => {
              const envLine = r.runtimeVal ? `${r.env}=${r.runtimeVal}` : r.env;
              return (
                <tr key={r.env} className="hover:bg-amber-500/5">
                  <td className="px-2 py-1.5 whitespace-nowrap font-semibold text-amber-100">
                    {r.env}
                  </td>
                  <td className="px-2 py-1.5 break-all text-amber-300/70">
                    {r.webVal ? (
                      <code>{r.webVal}</code>
                    ) : (
                      <span className="text-amber-300/50 italic">unset</span>
                    )}
                  </td>
                  <td className="px-2 py-1.5 break-all text-amber-300/70">
                    {r.runtimeVal ? (
                      <code>{r.runtimeVal}</code>
                    ) : (
                      <span className="text-amber-300/50 italic">missing</span>
                    )}
                  </td>
                  <td className="px-2 py-1.5 text-right">
                    <button
                      type="button"
                      onClick={() => {
                        void navigator.clipboard
                          .writeText(envLine)
                          .then(() => toast.success(`Copied ${r.env}`))
                          .catch(() => toast.error("Clipboard write failed"));
                      }}
                      className="rounded border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold text-amber-100 hover:bg-amber-500/20 transition"
                    >
                      Copy
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
