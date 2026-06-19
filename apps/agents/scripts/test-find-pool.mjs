import { findExistingYesPool, PREDICT_MARKET_PACKAGE_ID } from "@suipredict/sdk";
import { SuiGrpcClient } from "@mysten/sui/grpc";

const RPC = process.env.SUI_RPC ?? "https://fullnode.testnet.sui.io:443";
const client = new SuiGrpcClient({ network: "testnet", baseUrl: RPC });
console.log("PREDICT_MARKET_PACKAGE_ID from SDK:", PREDICT_MARKET_PACKAGE_ID);

const result = await findExistingYesPool(
  client,
  "0xe14eba90fc8cc14a2eac1199b207d4e664931f8196f612b5aacf0c4a7f7d7a6f",
  "0xe98b0c9c215859ef937803ca9a2f4f94fd649c3a701fcb5b6850c115d9773dac",
);
console.log("findExistingYesPool result:", result);
