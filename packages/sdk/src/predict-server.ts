import {
  PREDICT_OBJECT_ID,
  PREDICT_SERVER_URL,
} from "./constants.js";
import type {
  ManagerSummary,
  MintedPosition,
  OracleInfo,
  OracleState,
  PositionSummary,
  RedeemedPosition,
  VaultSummary,
} from "./types.js";

async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(`${PREDICT_SERVER_URL}${path}`);
  if (!res.ok) {
    throw new Error(`predict-server ${path}: ${res.status} ${await res.text()}`);
  }
  return res.json() as Promise<T>;
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
  return fetchJson(`/oracles/${oracleId}/state`);
}

export async function getVaultSummary(predictId = PREDICT_OBJECT_ID): Promise<VaultSummary> {
  return fetchJson(`/predicts/${predictId}/vault/summary`);
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
  const data = await fetchJson<{ positions: PositionSummary[] }>(
    `/managers/${managerId}/positions/summary`,
  );
  return data.positions ?? (data as unknown as PositionSummary[]);
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
  const positions = await getManagerPositions(managerId);
  const settled: PositionSummary[] = [];
  for (const pos of positions) {
    try {
      const state = await getOracleState(pos.oracle_id);
      if (state.status === "settled" && pos.quantity > 0) {
        settled.push(pos);
      }
    } catch {
      // skip
    }
  }
  return settled;
}
