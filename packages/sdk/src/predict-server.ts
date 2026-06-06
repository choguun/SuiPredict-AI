import {
  PREDICT_OBJECT_ID,
  resolvePredictServerUrl,
} from "./constants.js";
import { isValidSuiAddress } from "./utils.js";
import type {
  ManagerSummary,
  MintedPosition,
  OracleInfo,
  OracleState,
  OracleStateResponse,
  PositionSummary,
  RedeemedPosition,
  VaultSummary,
  VaultSummaryRaw,
} from "./types.js";

// R58.5 audit fix: every URL interpolated in this file
// embeds a Sui object id (`predict_id`, `manager_id`,
// `oracle_id`). A missing or malformed id — empty
// string from a defaulted `PREDICT_OBJECT_ID`, a
// whitespace-padded env-derived value, or the
// all-zeros placeholder — silently produces a 404
// (e.g. `/predicts//oracles`) or a URL-injection
// 400. The R42 audit pass added `normalizeObjectId`
// for the on-chain builders; the predict-server
// fetchers were missed. Centralize the guard here
// so each call site gets the same loud build-time
// error.
function requireId(id: string, paramName: string): string {
  if (!isValidSuiAddress(id)) {
    throw new Error(
      `predict-server: ${paramName} must be a non-zero Sui address (got "${id}")`,
    );
  }
  return id.toLowerCase();
}

async function fetchJson<T>(path: string): Promise<T> {
  // R52 audit fix: bound the fetch with a
  // 5s timeout and validate the
  // content-type. A hung predict-server
  // (e.g. mainnet RPC down) was hanging
  // the agents' `market-resolver` tick
  // for the full TCP keepalive
  // (~minutes). A 5s cap is tight enough
  // to keep the tick loop responsive but
  // loose enough for the 4-hop chain
  // (predict-server → gRPC → node →
  // fullnode) to converge under normal
  // load. Also catches a 200 with
  // `Content-Type: text/html` (Vite dev
  // page) before `res.json()` throws.
  //
  // R53 audit fix: read the URL at
  // call time, not via the
  // module-level `PREDICT_SERVER_URL`
  // constant. The agents'
  // `bootstrap-env.ts` hot-patches
  // `process.env.PREDICT_SERVER_URL`
  // after the SDK is imported, but
  // the SDK was already loaded and
  // the const was frozen. The
  // `resolvePredictServerUrl()`
  // helper re-reads the env on
  // every call (same pattern as
  // `getIndexerUrl()` fixed in
  // R49).
  const res = await fetch(`${resolvePredictServerUrl()}${path}`, {
    signal: AbortSignal.timeout(5_000),
    headers: { "User-Agent": "suipredict-sdk" },
  });
  if (!res.ok) {
    throw new Error(`predict-server ${path}: ${res.status} ${await res.text()}`);
  }
  // R54 audit fix: cap the response body size at 5 MB. The
  // previous code called `res.json()` with no bound — a
  // misconfigured or malicious backend returning a 1 GB body
  // would OOM the Node process (the agents' tick loop is
  // single-threaded). 5 MB is well above any realistic
  // predict-server response (a 1000-market list is ~500 KB).
  const len = Number(res.headers.get("content-length") ?? 0);
  if (len > 5_000_000) {
    throw new Error(
      `predict-server ${path}: response too large (Content-Length ${len} > 5_000_000)`,
    );
  }
  const ct = res.headers.get("content-type") ?? "";
  if (!ct.includes("application/json")) {
    throw new Error(
      `predict-server ${path}: expected application/json, got ${ct || "(none)"}`,
    );
  }
  return res.json() as Promise<T>;
}

export function normalizeOracleState(raw: OracleStateResponse): OracleState {
  const oracle = raw.oracle;
  return {
    oracle_id: oracle.oracle_id,
    predict_id: oracle.predict_id,
    underlying_asset: oracle.underlying_asset,
    expiry: oracle.expiry,
    status: oracle.status,
    spot: raw.latest_price?.spot ?? null,
    forward: raw.latest_price?.forward ?? null,
    settlement_price: oracle.settlement_price,
    min_strike: oracle.min_strike,
    tick_size: oracle.tick_size,
  };
}

export function normalizeVaultSummary(raw: VaultSummaryRaw): VaultSummary {
  return {
    predict_id: raw.predict_id,
    vault_value: raw.vault_value,
    utilization: raw.utilization,
    plp_supply: raw.plp_total_supply,
    quote_balance: raw.vault_balance,
    max_payout_utilization: raw.max_payout_utilization,
    plp_share_price: raw.plp_share_price,
    available_liquidity: raw.available_liquidity,
  };
}

export async function getStatus() {
  return fetchJson<{ status: string }>("/status");
}

export async function getOracles(predictId = PREDICT_OBJECT_ID): Promise<OracleInfo[]> {
  return fetchJson(`/predicts/${requireId(predictId, "predictId")}/oracles`);
}

export async function getActiveOracles(predictId = PREDICT_OBJECT_ID): Promise<OracleInfo[]> {
  const oracles = await getOracles(predictId);
  return oracles.filter((o) => o.status === "active");
}

export async function getOracleState(oracleId: string): Promise<OracleState> {
  const raw = await fetchJson<OracleStateResponse>(`/oracles/${requireId(oracleId, "oracleId")}/state`);
  return normalizeOracleState(raw);
}

export async function getVaultSummary(predictId = PREDICT_OBJECT_ID): Promise<VaultSummary> {
  const raw = await fetchJson<VaultSummaryRaw>(`/predicts/${requireId(predictId, "predictId")}/vault/summary`);
  return normalizeVaultSummary(raw);
}

export async function getManagers(): Promise<
  { manager_id: string; owner: string; checkpoint?: number }[]
> {
  return fetchJson("/managers");
}

export async function getManagerForOwner(owner: string): Promise<string | null> {
  const managers = await getManagers();
  // R55 audit fix: null-guard `m.owner` before calling
  // `.toLowerCase()`. The predict-server response could
  // include a `{ manager_id: "0x…", owner: null }` row
  // (a deleted user, or a future schema migration) and
  // the previous inline `.toLowerCase()` would throw
  // "Cannot read properties of null" inside the SDK.
  // `getManagerForOwner` is the very first step of the
  // mint flow (see `predict-client.ts:createPredictManager`),
  // so a crash here bricks the entire mint path.
  const mine = managers.filter(
    (m) => typeof m.owner === "string" && m.owner.toLowerCase() === owner.toLowerCase(),
  );
  if (mine.length === 0) return null;
  return mine[0]!.manager_id;
}

export async function getManagerSummary(managerId: string): Promise<ManagerSummary> {
  return fetchJson(`/managers/${requireId(managerId, "managerId")}/summary`);
}

export async function getManagerPositions(managerId: string): Promise<PositionSummary[]> {
  const data = await fetchJson<{ positions: PositionSummary[] } | PositionSummary[]>(
    `/managers/${requireId(managerId, "managerId")}/positions/summary`,
  );
  if (Array.isArray(data)) return data;
  return data.positions ?? [];
}

export async function getMintedPositions(limit = 50): Promise<MintedPosition[]> {
  // `limit` is a numeric query param; cast to integer
  // to prevent an injection like `?limit=100&foo=bar`
  // from being interpolated verbatim. `Number.isInteger`
  // rejects floats, NaN, and non-numbers.
  if (!Number.isInteger(limit) || limit < 0) {
    throw new Error(`predict-server: limit must be a non-negative integer (got ${limit})`);
  }
  return fetchJson(`/positions/minted?limit=${limit}`);
}

export async function getRedeemedPositions(limit = 50): Promise<RedeemedPosition[]> {
  if (!Number.isInteger(limit) || limit < 0) {
    throw new Error(`predict-server: limit must be a non-negative integer (got ${limit})`);
  }
  return fetchJson(`/positions/redeemed?limit=${limit}`);
}

export async function getOracleSviLatest(oracleId: string) {
  return fetchJson(`/oracles/${requireId(oracleId, "oracleId")}/svi/latest`);
}

export async function getOraclePriceLatest(oracleId: string) {
  return fetchJson(`/oracles/${requireId(oracleId, "oracleId")}/prices/latest`);
}

export async function findNearestActiveOracle(
  predictId = PREDICT_OBJECT_ID,
): Promise<OracleInfo | null> {
  const active = await getActiveOracles(predictId);
  if (active.length === 0) return null;
  const now = Date.now();
  const sorted = active
    .filter((o) => o.expiry > now)
    .sort((a, b) => a.expiry - b.expiry);
  return sorted[0] ?? active[0] ?? null;
}

export async function findSettledOraclesWithOpenPositions(
  managerId: string,
): Promise<PositionSummary[]> {
  const [positions, oracles] = await Promise.all([
    getManagerPositions(managerId),
    getOracles(),
  ]);
  // R57.18 audit fix: lowercase both sides of the `.has()` check.
  // Sui addresses are case-insensitive on the wire; a checksum-cased
  // id (e.g. a Sui Explorer-style paste) in either the oracle list
  // or the positions list would silently miss the exact-match `.has()`
  // and the "settled positions" view would be incomplete.
  const settledIds = new Set(
    oracles
      .filter((o) => o.status === "settled")
      .map((o) => o.oracle_id.toLowerCase()),
  );

  return positions.filter(
    (pos) => pos.quantity > 0 && settledIds.has(pos.oracle_id.toLowerCase()),
  );
}
