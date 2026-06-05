// Primary: Polymarket-style CLOB markets
export {
  MARKET_PACKAGE_ID,
  DBUSDC_TYPE,
  bpsToPrice,
  priceToBps,
  encodeUtf8,
} from "./markets/constants.js";
export * from "./markets/types.js";
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
  buildUnpausePolicyTx,
  buildCreatePolicyTx,
  buildRevokePolicyTx,
  getPolicyState,
} from "./predict-client.js";
export type { SuiClient, TxResult } from "./predict-client.js";

// Prediction Market (DeepBook V3 integrated)
export {
  createMarketDeepBookClient,
  buildPlaceYesLimitOrderTx,
  buildWithdrawSettledTx,
  buildMarketWithdrawSettledTx,
  buildMintSharesTx,
  buildMintSharesBatchTx,
  buildSetupReferralTx,
  buildCreateMarketTx,
  buildResolveMarketTx,
  buildRedeemTx,
  buildRedeemNoTx,
  buildRedeemWithStreakTx,
  buildRedeemNoWithStreakTx,
  buildDisputeMarketTx,
  buildResolveDisputeTx,
  buildClaimReferralRewardsTx,
  buildCreateRegistryTx,
  buildRegisterMarketTx,
  buildVaultDepositTx,
  buildVaultWithdrawTx,
  buildCreateVaultTx,
  buildAllocateForMmTx,
  buildReturnFromMmTx,
  buildWithdrawFeesTx,
  buildInitFeeVaultTx,
  // R50 audit fix: 5 builders were defined in
  // `prediction-market-client.ts` but omitted from
  // the explicit barrel list. Consumers importing
  // from `@suipredict/sdk` (instead of the deep
  // path) got `undefined` for each, and the
  // `place_order` Move call relied on by the
  // position-indexer's `OrderPlacedEvent` cursor
  // advancement was the dead one. Add all five.
  buildPlaceMarketOrderTx,
  buildPlaceOrderTx,
  buildCancelOrderTx,
  buildCancelOrdersTx,
  buildCancelAllOrdersTx,
  buildDepositForTradingTx,
  // 1e9 quote scale for the `place_order` wrapper.
  // See `QUOTE_SCALE` docstring in
  // `prediction-market-client.ts`.
  QUOTE_SCALE,
  yesCoinType,
  noCoinType,
  PREDICT_MARKET_PACKAGE_ID,
  FEE_VAULT_ID,
  REFERRAL_TREASURY_ADDRESS,
} from "./prediction-market-client.js";

export {
  getOrderBookDepth,
  getMidPrice,
  PREDICT_DEEPBOOK_POOL_KEY,
  type DeepBookClient,
  type BalanceManager,
} from "./deepbook/client.js";

// Streak + prize pool (gamification)
export * from "./streak-client.js";
export * from "./prize-client.js";
export * from "./badge-nft-client.js";
export * from "./parlay-client.js";
export * from "./user-profile-client.js";
export * from "./protocol-reads.js";

// Legacy DeepBook Predict
export * as predict from "./predict/index.js";

// Backward-compatible re-exports
export * from "./constants.js";
export * from "./types.js";
export * from "./predict-server.js";
export * from "./predict-client.js";
export * from "./utils.js";
export * from "./move-errors.js";
