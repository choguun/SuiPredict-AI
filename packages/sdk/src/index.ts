// Primary: Polymarket-style CLOB markets
export {
  MARKET_PACKAGE_ID,
  DBUSDC_TYPE,
  bpsToPrice,
  priceToBps,
  encodeUtf8,
} from "./markets/constants.js";
export * from "./markets/types.js";
export * from "./markets/factory-client.js";
export * from "./markets/indexer-client.js";
export {
  DEEPBOOK_PACKAGE_ID,
  DEEPBOOK_REGISTRY_ID,
  DEEP_TYPE,
  VLP_TYPE,
  POOL_SUI_DBUSDC,
  POOL_DEEP_DBUSDC,
  POOL_CREATION_FEE_DEEP,
} from "./deepbook/constants.js";
export { DBUSDC_TYPE as DEEPBOOK_DBUSDC_TYPE } from "./deepbook/constants.js";
export * from "./deepbook/client.js";

// Shared utilities from predict client
export {
  createClient,
  executeTransaction,
  keypairFromPrivateKey,
  getDusdcBalance,
  extractCreatedObjectId,
  buildAuthorizeSpendTx,
  buildPausePolicyTx,
  buildCreatePolicyTx,
  buildRevokePolicyTx,
  getPolicyState,
} from "./predict-client.js";
export type { SuiClient, TxResult } from "./predict-client.js";

// Prediction Market (DeepBook V3 integrated)
// Re-export only the NEW functions that don't conflict with legacy exports.
// getOrderBookDepth, getMidPrice, PREDICT_DEEPBOOK_POOL_KEY live in deepbook/client.ts
// createMarketDeepBookClient, buildPlaceYesLimitOrderTx, buildWithdrawSettledTx, DeepBookClient
// live in prediction-market-client.ts
export {
  createMarketDeepBookClient,
  buildPlaceYesLimitOrderTx,
  buildWithdrawSettledTx,
  buildMintSharesTx,
  buildSetupReferralTx,
  buildCreateMarketTx,
  buildResolveMarketTx,
  buildRedeemTx,
  buildRedeemNoTx,
} from "./prediction-market-client.js";

// buildCreateMarketTx lives in both prediction-market-client.js and
// markets/factory-client.js. Import from prediction-market-client.js directly:
//   import { buildCreateMarketTx } from "@suipredict/sdk/prediction-market-client";

export {
  getOrderBookDepth,
  getMidPrice,
  PREDICT_DEEPBOOK_POOL_KEY,
  type DeepBookClient,
  type BalanceManager,
} from "./deepbook/client.js";

// Legacy DeepBook Predict
export * as predict from "./predict/index.js";

// Backward-compatible re-exports
export * from "./constants.js";
export * from "./types.js";
export * from "./predict-server.js";
export * from "./predict-client.js";
export * from "./utils.js";
