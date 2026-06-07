import type { ManagerSummary, MintedPosition, OracleInfo, OracleState, OracleStateResponse, PositionSummary, RedeemedPosition, VaultSummary, VaultSummaryRaw } from "./types.js";
export declare function normalizeOracleState(raw: OracleStateResponse): OracleState;
export declare function normalizeVaultSummary(raw: VaultSummaryRaw): VaultSummary;
export declare function getStatus(): Promise<{
    status: string;
}>;
export declare function getOracles(predictId?: string): Promise<OracleInfo[]>;
export declare function getActiveOracles(predictId?: string): Promise<OracleInfo[]>;
export declare function getOracleState(oracleId: string): Promise<OracleState>;
export declare function getVaultSummary(predictId?: string): Promise<VaultSummary>;
export declare function getManagers(): Promise<{
    manager_id: string;
    owner: string;
    checkpoint?: number;
}[]>;
export declare function getManagerForOwner(owner: string): Promise<string | null>;
export declare function getManagerSummary(managerId: string): Promise<ManagerSummary>;
export declare function getManagerPositions(managerId: string): Promise<PositionSummary[]>;
export declare function getMintedPositions(limit?: number): Promise<MintedPosition[]>;
export declare function getRedeemedPositions(limit?: number): Promise<RedeemedPosition[]>;
export declare function getOracleSviLatest(oracleId: string): Promise<unknown>;
export declare function getOraclePriceLatest(oracleId: string): Promise<unknown>;
export declare function findNearestActiveOracle(predictId?: string): Promise<OracleInfo | null>;
export declare function findSettledOraclesWithOpenPositions(managerId: string): Promise<PositionSummary[]>;
//# sourceMappingURL=predict-server.d.ts.map