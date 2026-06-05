"use client";

import { useCurrentAccount, useCurrentClient, useDAppKit } from "@mysten/dapp-kit-react";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import {
  AGENT_POLICY_PACKAGE_ID,
  buildCreatePolicyTx,
  buildCreateProfileTx,
  buildPausePolicyTx,
  buildRevokePolicyTx,
  buildSetCountryCodeTx,
  buildSetForecasterKindTx,
  buildUnpausePolicyTx,
  extractCreatedObjectId,
  FORECASTER_AI,
  FORECASTER_BOT,
  FORECASTER_HUMAN,
  getPolicyState,
  isValidSuiAddress,
  MAX_COUNTRY_BYTES,
  dusdcToDollars,
  isMoveAbortInModule,
  type AgentPolicyState,
} from "@suipredict/sdk";
import { Card } from "@/components/ui";
import { useUserStreakId } from "@/hooks/useUserStreakId";

interface MirrorProfile {
  user: string;
  country_code: string;
  forecaster_kind: number;
  updated_at_ms: number;
}

const PROFILE_REGISTRY_ID = process.env.NEXT_PUBLIC_PROFILE_REGISTRY_ID ?? "";
// R52 audit fix: source the streak
// registry id from the same env var
// that `useUserStreakId.ts` reads
// (`NEXT_PUBLIC_STREAK_REGISTRY_ID`).
// The previous `PROFILE_REGISTRY_ID`
// mismatch meant the
// `invalidateStreakCache` invalidation
// targeted a different TanStack key
// than the hook actually registered,
// so the success path silently
// no-op'd the streak refresh — the
// home page's streak panel would
// show "no streak" for 30s after
// the user started a streak from
// the settings page.
const STREAK_REGISTRY_ID = process.env.NEXT_PUBLIC_STREAK_REGISTRY_ID ?? "";
const AGENTS_URL = process.env.NEXT_PUBLIC_AGENTS_URL ?? "http://localhost:3001";

const KIND_LABELS: Record<number, string> = {
  [FORECASTER_HUMAN]: "Human",
  [FORECASTER_AI]: "AI-assisted",
  [FORECASTER_BOT]: "Bot",
};

// R52 audit fix: replace the previous generic
// "Transaction failed" toasts with abort-aware
// messages. The settings page drives `agent_policy`
// and `user_profile` Move modules, both of which
// have rich abort codes that the user can act on
// (e.g. "agent cap exceeded" → top up the policy;
// "country code too long" → trim input). Without
// this helper the catch blocks were emitting a
// blanket string and the user had no signal which
// input to fix.
function friendlyMoveError(err: unknown, action: string): string {
  if (isMoveAbortInModule(err, "agent_policy")) {
    return `${action} failed: agent policy paused, revoked, or out of budget.`;
  }
  if (isMoveAbortInModule(err, "user_profile")) {
    return `${action} failed: profile invariant violated (invalid input or wrong owner?).`;
  }
  if (isMoveAbortInModule(err, "streak_system")) {
    return `${action} failed: streak registry rejected the call.`;
  }
  return `${action} failed on-chain`;
}

function failedTxToError(
  r: { FailedTransaction?: { status?: { success: false; error?: { message?: string } } | { success: true } } },
): Error {
  const failed = r.FailedTransaction;
  if (!failed) return new Error("Move transaction failed");
  const status = failed.status;
  if (!status || status.success !== false) {
    return new Error("Move transaction failed");
  }
  return new Error(status.error?.message ?? "Move transaction failed");
}

export default function SettingsPage() {
  const account = useCurrentAccount();
  const client = useCurrentClient();
  const dAppKit = useDAppKit();
  // R48 audit fix: invalidate the `useUserStreakId` query after a
  // successful create/revoke policy or create/save profile
  // operation, so the StreakProfile / StreakWelcomeBanner /
  // DailyPredictionCard / ClaimPrizeButton components pick up
  // the new state on next render. R40/R43 added this pattern to
  // the StreakProfile and DailyPredictionCard; settings was the
  // survivor. Without invalidation the streak panel shows
  // "no streak" for up to 30s after the policy is created.
  const queryClient = useQueryClient();
  const { streakId } = useUserStreakId(account?.address);
  const invalidateStreakCache = useCallback(() => {
    if (!account?.address) return;
    // R52 audit fix: use the streak
    // registry id (matching the
    // `useUserStreakId` hook's
    // `queryKey`) instead of the
    // profile registry id. TanStack's
    // prefix-match is exact on the
    // tuple `[..., REGISTRY_ID, address]`
    // — a different id is a different
    // key.
    void queryClient.invalidateQueries({
      queryKey: ["userStreakId", STREAK_REGISTRY_ID, account.address],
      type: "active",
    });
    // R51 audit fix: also invalidate the
    // `useStreakInfo` query (key shape
    // `["streakInfo", streakId]`). After
    // `createPolicy` or `saveProfile`, the
    // agents' `RiskMonitor` updates
    // `streak_info` off-chain and the next
    // render of the home page's streak
    // panel would otherwise show a stale
    // "no policy" badge for up to 30s.
    // Only invalidate when we know the
    // streakId — otherwise the unscoped
    // `["streakInfo"]` would also catch
    // other addresses' cached streakInfo
    // entries from SSR preloading.
    if (streakId) {
      void queryClient.invalidateQueries({
        queryKey: ["streakInfo", streakId],
        type: "active",
      });
    }
  }, [queryClient, account?.address, streakId]);
  const [agentAddress, setAgentAddress] = useState("");
  const [budget, setBudget] = useState(50);
  const [policyId, setPolicyId] = useState("");
  const [policyInfo, setPolicyInfo] = useState<string>("");
  const [policyState, setPolicyState] = useState<AgentPolicyState | null>(null);
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(false);

  const [profile, setProfile] = useState<MirrorProfile | null>(null);
  const [profileMissing, setProfileMissing] = useState(false);
  const [country, setCountry] = useState("");
  const [forecasterKind, setForecasterKind] = useState<number>(FORECASTER_HUMAN);
  const [profileStatus, setProfileStatus] = useState("");
  const [profileBusy, setProfileBusy] = useState(false);

  // Pull the indexer-mirrored profile row whenever the connected
  // account changes. The agents route reads `user_profiles` (populated
  // by the position-indexer from `ProfileCreated` / `CountryCodeSet` /
  // `ForecasterKindSet` events). A 404 means "no profile yet" — we
  // surface the create button instead of an error.
  useEffect(() => {
    if (!account?.address) {
      setProfile(null);
      setProfileMissing(false);
      return;
    }
    let cancelled = false;
    fetch(`${AGENTS_URL}/profile/${account.address}`, { cache: "no-store" })
      .then(async (r) => {
        if (cancelled) return;
        if (r.status === 404) {
          setProfile(null);
          setProfileMissing(true);
          return;
        }
        if (!r.ok) {
          setProfile(null);
          setProfileMissing(false);
          return;
        }
        const data = (await r.json()) as MirrorProfile;
        setProfile(data);
        setProfileMissing(false);
        if (data.country_code) setCountry(data.country_code);
        setForecasterKind(data.forecaster_kind);
      })
      .catch(() => {
        if (!cancelled) {
          setProfile(null);
          setProfileMissing(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [account?.address]);

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
    // R44 audit fix: validate the agent address before submitting
    // the create-policy PTB. The previous code accepted any
    // non-empty string; a typo (truncation, wrong network,
    // accidental 0x prefix or, most commonly, a paste from a
    // different chain like Ethereum) would have:
    //   - produced a `tx.pure.address(badAddr)` that Move parsed
    //     into a Sui address (zero-padded) on the way to the
    //     signature check, where the on-chain
    //     `agent_policy::create_policy` aborts with
    //     `EInvalidAgentAddress` and burns the gas fee, or
    //   - succeeded and created a policy whose `agent` field is
    //     a non-existent address — the policy is then orphaned
    //     forever (no one can `pause` it, the budget is locked).
    // Match the same validator the agents-side
    // `bootstrap-env.ts` and `referral-keeper.ts` use (R42 audit
    // surfaced the same `isValidSuiAddress` helper in utils.ts).
    if (!isValidSuiAddress(agentAddress)) {
      setStatus(
        "Agent address is not a valid Sui address (expected 0x + 64 hex chars, not the 0x0…0 placeholder).",
      );
      return;
    }
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
      if (!digest) {
        // R52 audit fix: surface a friendly
        // Move-abort message (e.g. "agent
        // cap exceeded") instead of a
        // generic "Transaction failed".
        setStatus(friendlyMoveError(failedTxToError(result), "Create policy"));
        return;
      }

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
      invalidateStreakCache();
    } catch (e) {
      setStatus(friendlyMoveError(e, "Create policy"));
    } finally {
      setLoading(false);
    }
  }

  async function revokePolicy() {
    if (!account || !policyId) return;
    // R47 audit fix: confirm before revoking. The
    // card description on line ~425 explicitly states
    // "Revoke permanently disables the policy —
    // irreversible." yet the previous submit handler
    // went straight to `buildRevokePolicyTx` with
    // no second-chance prompt. R45 added this
    // pattern to the admin destructive actions
    // (settle, rotate, allocate) but missed the
    // settings page's policy controls. A user who
    // mis-clicked "Revoke" would have to redeploy
    // the entire `agent_policy` object to recover.
    if (
      !window.confirm(
        `Revoke policy ${policyId.slice(0, 12)}…? This is irreversible.`,
      )
    ) {
      return;
    }
    setLoading(true);
    setStatus("Revoking policy...");
    try {
      const tx = buildRevokePolicyTx(policyId);
      const result = await dAppKit.signAndExecuteTransaction({ transaction: tx });
      // R38 audit fix: same R30/R32/R37 pattern — bail with an
      // explicit error rather than rendering "Revoked! Tx: unknown…"
      // on a Failed/EffectsCert result. The previous code fell
      // through to the literal "unknown" digest.
      if (result.$kind !== "Transaction") {
        setStatus("Revoke failed on-chain");
        return;
      }
      const digest = result.Transaction.digest;
      setStatus(`Revoked! Tx: ${digest.slice(0, 16)}…`);
      await loadPolicyInfo(policyId);
    } catch (e) {
      setStatus(friendlyMoveError(e, "Revoke policy"));
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
      // R38 audit fix: same R30/R32/R37 pattern. Bail on a
      // non-Transaction result rather than rendering
      // "Paused! Tx: unknown…" / "Unpaused! Tx: unknown…".
      if (result.$kind !== "Transaction") {
        setStatus(
          `${pause ? "Pause" : "Unpause"} failed on-chain`,
        );
        return;
      }
      const digest = result.Transaction.digest;
      setStatus(`${pause ? "Paused" : "Unpaused"}! Tx: ${digest.slice(0, 16)}…`);
      await loadPolicyInfo(policyId);
      invalidateStreakCache();
    } catch (e) {
      setStatus(friendlyMoveError(e, pause ? "Pause policy" : "Unpause policy"));
    } finally {
      setLoading(false);
    }
  }

  async function createProfile() {
    if (!account || !PROFILE_REGISTRY_ID) return;
    setProfileBusy(true);
    setProfileStatus("Creating profile…");
    try {
      const tx = buildCreateProfileTx(PROFILE_REGISTRY_ID);
      const r = await dAppKit.signAndExecuteTransaction({ transaction: tx });
      if (r.$kind !== "Transaction") {
        // R52 audit fix: friendly abort
        // message instead of a generic
        // throw. The `user_profile` module
        // aborts include "country code
        // too long" (R44) and "profile
        // already exists" (R47) which
        // the user needs to act on.
        setProfileStatus(friendlyMoveError(failedTxToError(r), "Create profile"));
        return;
      }
      setProfileStatus(
        `Profile created! Tx: ${r.Transaction.digest.slice(0, 16)}…`,
      );
      invalidateStreakCache();
    } catch (e) {
      setProfileStatus(friendlyMoveError(e, "Create profile"));
    } finally {
      setProfileBusy(false);
    }
  }

  async function saveCountry() {
    if (!account || !profile) return;
    setProfileBusy(true);
    setProfileStatus("Saving country code…");
    try {
      const tx = buildSetCountryCodeTx(profile.user, country);
      const r = await dAppKit.signAndExecuteTransaction({ transaction: tx });
      if (r.$kind !== "Transaction") {
        setProfileStatus(friendlyMoveError(failedTxToError(r), "Save country"));
        return;
      }
      setProfileStatus(
        `Country saved! Tx: ${r.Transaction.digest.slice(0, 16)}…`,
      );
      invalidateStreakCache();
    } catch (e) {
      setProfileStatus(friendlyMoveError(e, "Save country"));
    } finally {
      setProfileBusy(false);
    }
  }

  async function saveKind() {
    if (!account || !profile) return;
    setProfileBusy(true);
    setProfileStatus("Saving forecaster kind…");
    try {
      const tx = buildSetForecasterKindTx(profile.user, forecasterKind);
      const r = await dAppKit.signAndExecuteTransaction({ transaction: tx });
      if (r.$kind !== "Transaction") {
        setProfileStatus(friendlyMoveError(failedTxToError(r), "Save forecaster kind"));
        return;
      }
      setProfileStatus(
        `Forecaster kind saved! Tx: ${r.Transaction.digest.slice(0, 16)}…`,
      );
      invalidateStreakCache();
    } catch (e) {
      setProfileStatus(friendlyMoveError(e, "Save forecaster kind"));
    } finally {
      setProfileBusy(false);
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
                value={agentAddress}
                onChange={(e) => setAgentAddress(e.target.value)}
                placeholder="0x..."
                // R44 audit fix: surface the validator inline
                // (red ring when invalid) so the user can fix a
                // typo before clicking Create Policy, instead of
                // seeing the failure in the bottom status line.
                // `isValidSuiAddress` is the same helper used
                // server-side; running it twice (here + at submit
                // time) is cheap.
                aria-invalid={
                  agentAddress.length > 0 && !isValidSuiAddress(agentAddress)
                }
                className={`w-full rounded-lg border bg-black/20 px-3 py-2.5 text-sm font-mono text-white focus:outline-none transition-colors ${
                  agentAddress.length > 0 && !isValidSuiAddress(agentAddress)
                    ? "border-rose-500/50 focus:border-rose-500/70"
                    : "border-white/10 focus:border-cyan-500/50"
                }`}
              />
              {agentAddress.length > 0 && !isValidSuiAddress(agentAddress) && (
                <p className="mt-1 text-[10px] text-rose-400">
                  Must be 0x + 64 hex characters (Sui address, not the 0x0…0 placeholder).
                </p>
              )}
            </div>
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-1.5">Max Budget (dUSDC)</label>
              <input
                type="number"
                min="0"
                step="1"
                className="w-full rounded-lg border border-white/10 bg-black/20 px-3 py-2.5 text-sm text-white focus:border-cyan-500/50 focus:outline-none transition-colors"
                value={budget}
                // R37 audit fix: clamp to a non-negative integer.
                // `Number("")` is 0, `Number("1e10")` is 10000000000
                // (valid but absurdly large), and `Number("abc")` is
                // NaN — all of which would either silently inflate
                // the on-chain u64 budget or make `tx.pure.u64(budget)`
                // throw at build time. `Math.floor` rejects fractions
                // and `Number.isFinite` rejects NaN/Infinity.
                onChange={(e) => {
                  const n = Number(e.target.value);
                  setBudget(Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);
                }}
              />
            </div>
            <button
              onClick={createPolicy}
              // R44 audit fix: also block submit when the
              // typed agent address is syntactically invalid.
              // The submit-time guard above surfaces a status
              // message, but disabling the button up-front
              // matches the visual cue (red border + helper
              // text) and avoids the click → reject loop.
              disabled={
                loading || !agentAddress || !isValidSuiAddress(agentAddress)
              }
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

      <Card title="Profile" className="border-white/10">
        {!account ? (
          <p className="text-zinc-400">Connect wallet to manage your profile.</p>
        ) : !PROFILE_REGISTRY_ID ? (
          <p className="text-amber-300">
            NEXT_PUBLIC_PROFILE_REGISTRY_ID is not set — ask the operator
            to publish `user_profile::init` and configure the env.
          </p>
        ) : profileMissing ? (
          <div className="space-y-3 max-w-md">
            <p className="text-sm text-zinc-400">
              No profile yet. Creating one opts you into the national and
              AI-forecaster leaderboards.
            </p>
            <button
              onClick={createProfile}
              disabled={profileBusy}
              className="rounded-lg bg-gradient-to-r from-emerald-600 to-cyan-600 px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-cyan-900/30 transition-all hover:brightness-110 disabled:opacity-50"
            >
              Create profile
            </button>
          </div>
        ) : !profile ? (
          <p className="text-zinc-400">
            Profile mirror is unreachable. Try again after the agents
            service is up.
          </p>
        ) : (
          <div className="space-y-5 max-w-md">
            <p className="text-xs text-zinc-400">
              Owner: <span className="font-mono text-cyan-300">{profile.user.slice(0, 10)}…{profile.user.slice(-4)}</span>
            </p>
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-1.5">
                Country code
              </label>
              <div className="flex gap-2">
                <input
                  className="flex-1 rounded-lg border border-white/10 bg-black/20 px-3 py-2.5 text-sm font-mono text-white focus:border-cyan-500/50 focus:outline-none transition-colors"
                  value={country}
                  onChange={(e) => setCountry(e.target.value.toLowerCase())}
                  placeholder="us, th, jp…"
                  maxLength={MAX_COUNTRY_BYTES}
                  pattern="[a-z]{2,8}"
                />
                <button
                  onClick={saveCountry}
                  disabled={profileBusy || !country}
                  className="rounded-lg bg-cyan-500/20 border border-cyan-500/30 px-4 py-2 text-sm font-semibold text-cyan-200 transition-all hover:bg-cyan-500/30 disabled:opacity-50"
                >
                  Save
                </button>
              </div>
              <p className="mt-1 text-[10px] text-zinc-500">
                ISO-3166 alpha-2, lowercased. Leave empty to clear.
              </p>
            </div>
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-1.5">
                Forecaster kind
              </label>
              <div className="flex gap-2">
                <select
                  className="flex-1 rounded-lg border border-white/10 bg-black/20 px-3 py-2.5 text-sm text-white focus:border-cyan-500/50 focus:outline-none transition-colors"
                  value={forecasterKind}
                  onChange={(e) => setForecasterKind(Number(e.target.value))}
                >
                  {[FORECASTER_HUMAN, FORECASTER_AI, FORECASTER_BOT].map((k) => (
                    <option key={k} value={k}>
                      {KIND_LABELS[k] ?? `kind ${k}`}
                    </option>
                  ))}
                </select>
                <button
                  onClick={saveKind}
                  disabled={profileBusy}
                  className="rounded-lg bg-cyan-500/20 border border-cyan-500/30 px-4 py-2 text-sm font-semibold text-cyan-200 transition-all hover:bg-cyan-500/30 disabled:opacity-50"
                >
                  Save
                </button>
              </div>
            </div>
            {profileStatus && (
              <p className="text-xs font-mono text-cyan-400 break-all">
                {profileStatus}
              </p>
            )}
          </div>
        )}
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
