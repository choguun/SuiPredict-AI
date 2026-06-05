import {
  PREDICT_OBJECT_ID,
  PREDICT_SERVER_URL,
} from "./constants.js";
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
  const res = await fetch(`${PREDICT_SERVER_URL}${path}`, {
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) {
    throw new Error(`predict-server ${path}: ${res.status} ${await res.text()}`);
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
  return fetchJson(`/predicts/${predictId}/oracles`);
}

export async function getActiveOracles(predictId = PREDICT_OBJECT_ID): Promise<OracleInfo[]> {
  const oracles = await getOracles(predictId);
  return oracles.filter((o) => o.status === "active");
}

export async function getOracleState(oracleId: string): Promise<OracleState> {
  const raw = await fetchJson<OracleStateResponse>(`/oracles/${oracleId}/state`);
  return normalizeOracleState(raw);
}

export async function getVaultSummary(predictId = PREDICT_OBJECT_ID): Promise<VaultSummary> {
  const raw = await fetchJson<VaultSummaryRaw>(`/predicts/${predictId}/vault/summary`);
  return normalizeVaultSummary(raw);
}

export async function getManagers(): Promise<
  { manager_id: string; owner: string; checkpoint?: number }[]
> {
  return fetchJson("/managers");
}

export async function getManagerForOwner(owner: string): Promise<string | null> {
  const managers = await getManagers();
  const mine = managers.filter(
    (m) => m.owner.toLowerCase() === owner.toLowerCase(),
  );
  if (mine.length === 0) return null;
  return mine[0]!.manager_id;
}

export async function getManagerSummary(managerId: string): Promise<ManagerSummary> {
  return fetchJson(`/managers/${managerId}/summary`);
}

export async function getManagerPositions(managerId: string): Promise<PositionSummary[]> {
  const data = await fetchJson<{ positions: PositionSummary[] } | PositionSummary[]>(
    `/managers/${managerId}/positions/summary`,
  );
  if (Array.isArray(data)) return data;
  return data.positions ?? [];
}

export async function getMintedPositions(limit = 50): Promise<MintedPosition[]> {
  return fetchJson(`/positions/minted?limit=${limit}`);
}

export async function getRedeemedPositions(limit = 50): Promise<RedeemedPosition[]> {
  return fetchJson(`/positions/redeemed?limit=${limit}`);
}

export async function getOracleSviLatest(oracleId: string) {
  return fetchJson(`/oracles/${oracleId}/svi/latest`);
}

export async function getOraclePriceLatest(oracleId: string) {
  return fetchJson(`/oracles/${oracleId}/prices/latest`);
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
  const settledIds = new Set(
    oracles.filter((o) => o.status === "settled").map((o) => o.oracle_id),
  );

  return positions.filter((pos) => settledIds.has(pos.oracle_id) && pos.quantity > 0);
}
