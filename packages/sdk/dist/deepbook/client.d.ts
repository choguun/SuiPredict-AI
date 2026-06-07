import { DeepBookClient, type BalanceManager, type CoinMap, type PlaceLimitOrderParams, type PoolMap } from "@mysten/deepbook-v3";
import type { SuiGrpcClient } from "@mysten/sui/grpc";
import { Transaction } from "@mysten/sui/transactions";
import { DBUSDC_TYPE } from "./constants.js";
export type { BalanceManager, CoinMap, DeepBookClient, PoolMap };
export declare const PREDICT_DEEPBOOK_POOL_KEY = "PREDICT_YES_DUSDC";
export declare const PREDICT_BASE_COIN_KEY = "PREDICT_YES";
export declare const PREDICT_QUOTE_COIN_KEY = "PREDICT_QUOTE";
export declare const PREDICT_BALANCE_MANAGER_KEY = "PREDICT_MANAGER";
export declare function createDeepBookClient(client: SuiGrpcClient, address: string, balanceManagers?: Record<string, {
    address: string;
    tradeCap?: string;
}>, options?: {
    coins?: CoinMap;
    pools?: PoolMap;
    network?: "mainnet" | "testnet";
    packageIds?: {
        DEEPBOOK_PACKAGE_ID?: string;
        REGISTRY_ID?: string;
        DEEP_TREASURY_ID?: string;
    };
}): DeepBookClient;
export interface PredictionDeepBookMarketConfig {
    poolKey?: string | null;
    poolId: string;
    baseCoinType: string;
    quoteCoinType?: string;
    baseScalar?: number;
    quoteScalar?: number;
}
export declare function createPredictionDeepBookClient(params: {
    client: SuiGrpcClient;
    address: string;
    balanceManagerId?: string | null;
    tradeCapId?: string | null;
    market: PredictionDeepBookMarketConfig;
}): DeepBookClient;
export declare function buildDeepBookCreateBalanceManagerTx(dbClient: DeepBookClient, owner?: string): Transaction;
export declare function buildDeepBookDepositTx(dbClient: DeepBookClient, coinKey: string, amount: number): Transaction;
export declare function buildDeepBookWithdrawTx(dbClient: DeepBookClient, coinKey: string, amount: number, recipient: string): Transaction;
export declare function buildDeepBookPlaceLimitOrderTx(dbClient: DeepBookClient, params: Omit<PlaceLimitOrderParams, "poolKey" | "balanceManagerKey"> & {
    poolKey?: string;
}): Transaction;
export declare function buildDeepBookWithdrawSettledTx(dbClient: DeepBookClient, poolKey?: string): Transaction;
export type OrderBookDepth = {
    bids: [number, number][];
    asks: [number, number][];
};
export declare function getOrderBookDepth(dbClient: DeepBookClient, poolKey: string, lowPrice?: number, highPrice?: number): Promise<OrderBookDepth>;
export declare function getMidPrice(dbClient: DeepBookClient, poolKey: string): Promise<number>;
export { DBUSDC_TYPE };
//# sourceMappingURL=client.d.ts.map