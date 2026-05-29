import { Transaction } from "@mysten/sui/transactions";
import {
  CLOCK_OBJECT_ID,
  DBUSDC_TYPE,
  MARKET_PACKAGE_ID,
  encodeUtf8,
} from "./constants.js";

const PKG = () => MARKET_PACKAGE_ID;

export function buildCreateRegistryTx(): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG()}::registry::create_registry`,
    arguments: [],
  });
  return tx;
}

export function buildCreateMarketTx(params: {
  registryId: string;
  title: string;
  description: string;
  category: string;
  expiryMs: bigint;
  resolutionSource: string;
}): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG()}::market_factory::create_market`,
    typeArguments: [DBUSDC_TYPE],
    arguments: [
      tx.object(params.registryId),
      tx.pure.vector("u8", encodeUtf8(params.title)),
      tx.pure.vector("u8", encodeUtf8(params.description)),
      tx.pure.vector("u8", encodeUtf8(params.category)),
      tx.pure.u64(params.expiryMs),
      tx.pure.vector("u8", encodeUtf8(params.resolutionSource)),
      tx.object(CLOCK_OBJECT_ID),
    ],
  });
  return tx;
}

export function buildCreateOrderBookTx(marketId: string): Transaction {
  const tx = new Transaction();
  const book = tx.moveCall({
    target: `${PKG()}::clob::create_order_book`,
    typeArguments: [DBUSDC_TYPE],
    arguments: [tx.object(marketId)],
  });
  tx.moveCall({
    target: `${PKG()}::clob::share_order_book`,
    typeArguments: [DBUSDC_TYPE],
    arguments: [book],
  });
  return tx;
}

export function buildSplitCollateralTx(
  marketId: string,
  coinId: string,
): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG()}::outcome_tokens::split_collateral`,
    typeArguments: [DBUSDC_TYPE],
    arguments: [tx.object(marketId), tx.object(coinId)],
  });
  return tx;
}

export function buildMergeCollateralTx(
  marketId: string,
  amount: bigint,
): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG()}::outcome_tokens::merge_collateral`,
    typeArguments: [DBUSDC_TYPE],
    arguments: [tx.object(marketId), tx.pure.u64(amount)],
  });
  return tx;
}

export function buildPlaceLimitOrderTx(params: {
  marketId: string;
  orderBookId: string;
  isBid: boolean;
  priceBps: number;
  quantity: bigint;
}): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG()}::clob::place_limit_order`,
    typeArguments: [DBUSDC_TYPE],
    arguments: [
      tx.object(params.marketId),
      tx.object(params.orderBookId),
      tx.pure.bool(params.isBid),
      tx.pure.u64(BigInt(params.priceBps)),
      tx.pure.u64(params.quantity),
      tx.object(CLOCK_OBJECT_ID),
    ],
  });
  return tx;
}

export function buildResolveMarketTx(
  marketId: string,
  outcome: 1 | 2,
): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG()}::settlement::resolve_market`,
    typeArguments: [DBUSDC_TYPE],
    arguments: [
      tx.object(marketId),
      tx.pure.u8(outcome),
      tx.object(CLOCK_OBJECT_ID),
    ],
  });
  return tx;
}

export function buildRedeemWinnerTx(marketId: string): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG()}::settlement::redeem_winner`,
    typeArguments: [DBUSDC_TYPE],
    arguments: [tx.object(marketId)],
  });
  return tx;
}

export function buildCreateVaultTx(treasuryCapId: string): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG()}::vault::create_vault`,
    typeArguments: [DBUSDC_TYPE],
    arguments: [tx.object(treasuryCapId)],
  });
  return tx;
}

export function buildVaultDepositTx(
  vaultId: string,
  coinId: string,
  recipient: string,
): Transaction {
  const tx = new Transaction();
  const vlp = tx.moveCall({
    target: `${PKG()}::vault::deposit`,
    typeArguments: [DBUSDC_TYPE],
    arguments: [tx.object(vaultId), tx.object(coinId)],
  });
  tx.transferObjects([vlp], tx.pure.address(recipient));
  return tx;
}

export function buildVaultWithdrawTx(
  vaultId: string,
  vlpCoinId: string,
): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG()}::vault::withdraw`,
    typeArguments: [DBUSDC_TYPE],
    arguments: [tx.object(vaultId), tx.object(vlpCoinId)],
  });
  return tx;
}

export function buildAllocateForMmTx(
  vaultId: string,
  amount: bigint,
): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG()}::vault::allocate_for_mm`,
    typeArguments: [DBUSDC_TYPE],
    arguments: [tx.object(vaultId), tx.pure.u64(amount)],
  });
  return tx;
}

export function buildCancelOrderTx(params: {
  marketId: string;
  orderBookId: string;
  orderId: bigint;
}): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG()}::clob::cancel_order`,
    typeArguments: [DBUSDC_TYPE],
    arguments: [
      tx.object(params.marketId),
      tx.object(params.orderBookId),
      tx.pure.u64(params.orderId),
    ],
  });
  return tx;
}
export function buildLinkPoolTx(marketId: string, poolId: string): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG()}::market_factory::link_pool`,
    typeArguments: [DBUSDC_TYPE],
    arguments: [tx.object(marketId), tx.pure.id(poolId)],
  });
  return tx;
}
