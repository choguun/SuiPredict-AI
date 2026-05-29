export interface OracleInfo {
  predict_id: string;
  oracle_id: string;
  oracle_cap_id: string;
  underlying_asset: string;
  expiry: number;
  min_strike: number;
  tick_size: number;
  status: "active" | "settled" | string;
  activated_at: number | null;
  settlement_price: number | null;
  settled_at: number | null;
  created_checkpoint: number;
}

export interface OracleState {
  oracle_id: string;
  predict_id: string;
  underlying_asset: string;
  expiry: number;
  status: string;
  spot: number | null;
  forward: number | null;
  settlement_price: number | null;
  min_strike: number;
  tick_size: number;
}

export interface VaultSummary {
  predict_id: string;
  vault_value: number;
  utilization: number;
  plp_supply: number;
  quote_balance: number;
}

export interface ManagerSummary {
  manager_id: string;
  owner: string;
  quote_balance: number;
  position_count: number;
}

export interface PositionSummary {
  oracle_id: string;
  expiry: number;
  strike: number;
  is_up: boolean;
  quantity: number;
}

export interface MintedPosition {
  manager_id: string;
  oracle_id: string;
  expiry: number;
  strike: number;
  is_up: boolean;
  quantity: number;
  cost: number;
  checkpoint: number;
  timestamp_ms: number;
}

export interface RedeemedPosition {
  manager_id: string;
  oracle_id: string;
  expiry: number;
  strike: number;
  is_up: boolean;
  quantity: number;
  payout: number;
  is_settled: boolean;
  checkpoint: number;
  timestamp_ms: number;
}

export interface AgentDecisionLog {
  id: string;
  agent: string;
  action: string;
  reasoning: string;
  confidence?: number;
  txDigest?: string;
  timestamp: number;
}

export type Direction = "up" | "down";

export interface MintParams {
  managerId: string;
  oracleId: string;
  expiry: bigint;
  strikeDollars: number;
  direction: Direction;
  quantityDollars: number;
  topupDollars?: number;
  skipTopup?: boolean;
}

export interface RedeemParams {
  managerId: string;
  oracleId: string;
  expiry: bigint;
  strikeDollars: number;
  direction: Direction;
  quantityDollars: number;
  permissionless?: boolean;
}
