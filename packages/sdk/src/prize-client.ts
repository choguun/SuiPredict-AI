/**
 * Prize pool SDK — wraps `prize_pool.move` (suipredict module).
 *
 * Functions:
 *   - buildFundPoolTx           — anyone adds prize funds
 *   - buildClaimPrizeTx         — user claims a signed prize
 *   - buildSettleWeekTx         — admin marks a week as settled
 *   - buildRotateWeekTx         — admin rotates to a new week
 *   - buildRotatePubkeyTx       — admin rotates the prize admin's ed25519 key
 *   - buildSetDistributionTx    — admin updates the rank→bps mapping
 *   - signClaimPayload          — backend signs the canonical claim message
 *   - expectedAmountForRank     — pure helper for the frontend UI
 */
import { Transaction } from "@mysten/sui/transactions";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { fromBase64 } from "@mysten/sui/utils";
import { AGENT_POLICY_PACKAGE_ID, DUSDC_TYPE } from "./constants.js";

const PKG = () => AGENT_POLICY_PACKAGE_ID;

// Mirror on-chain DEFAULT_DISTRIBUTION_BPS.
export const DEFAULT_DISTRIBUTION_BPS: number[] = [
  5_000, 3_000, 1_500, 500, 1_000, 1_000, 1_000, 1_000, 1_000, 1_000,
];

export const BPS = 10_000;
export const MAX_RANK = 100;

export interface ClaimPayload {
  poolId: string;
  weekIndex: bigint;
  user: string;
  rank: number;
  amount: bigint;
}

export interface SignedClaim {
  payload: ClaimPayload;
  signatureB64: string;
}

/**
 * Build `fund_pool` transaction. Anyone can add funds.
 */
export function buildFundPoolTx(
  poolId: string,
  coinId: string,
  prizeCoinType: string = DUSDC_TYPE,
): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG()}::prize_pool::fund_pool`,
    typeArguments: [prizeCoinType],
    arguments: [tx.object(poolId), tx.object(coinId)],
  });
  return tx;
}

/**
 * Build `claim_prize` transaction. The `signature` must be an ed25519
 * signature over the canonical claim message (see `signClaimPayload`)
 * by the `PrizeAdmin` pubkey.
 */
export function buildClaimPrizeTx(params: {
  poolId: string;
  prizeAdminId: string;
  userStreakId: string;
  weekIndex: bigint;
  rank: number;
  amount: bigint;
  signatureB64: string;
  poolIdForSig: string; // must equal poolId
  prizeCoinType?: string; // defaults to DUSDC_TYPE; set to DBUSDC_TYPE for DBUSDC pools
}): Transaction {
  // The on-chain claim_prize signs the (pool_id_for_sig, week, user, rank,
  // amount) tuple. If the caller passes a different `poolId` to moveCall
  // than the one the backend signed over, the signature verifies against
  // a pool that doesn't exist and the funds go nowhere useful. Abort here
  // so the caller fixes the wiring rather than burning gas.
  if (params.poolId !== params.poolIdForSig) {
    throw new Error(
      `buildClaimPrizeTx: poolId (${params.poolId}) !== poolIdForSig (${params.poolIdForSig}); ` +
        "the signature was generated against a different pool. Pass the same id for both.",
    );
  }
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG()}::prize_pool::claim_prize`,
    typeArguments: [params.prizeCoinType ?? DUSDC_TYPE],
    arguments: [
      tx.object(params.poolId),
      tx.object(params.prizeAdminId),
      tx.object(params.userStreakId),
      tx.pure.u64(params.weekIndex),
      tx.pure.u64(params.rank),
      tx.pure.u64(params.amount),
      tx.pure.vector("u8", Array.from(fromBase64(params.signatureB64))),
      tx.pure.id(params.poolIdForSig),
    ],
  });
  return tx;
}

export function buildSettleWeekTx(
  poolId: string,
  adminCapId: string,
  weekIndex: bigint,
  prizeCoinType: string = DUSDC_TYPE,
): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG()}::prize_pool::settle_week`,
    typeArguments: [prizeCoinType],
    arguments: [tx.object(poolId), tx.object(adminCapId), tx.pure.u64(weekIndex)],
  });
  return tx;
}

export function buildRotateWeekTx(
  poolId: string,
  adminCapId: string,
  newWeek: bigint,
  prizeCoinType: string = DUSDC_TYPE,
): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG()}::prize_pool::rotate_week`,
    typeArguments: [prizeCoinType],
    arguments: [tx.object(poolId), tx.object(adminCapId), tx.pure.u64(newWeek)],
  });
  return tx;
}

export function buildRotatePubkeyTx(
  prizeAdminId: string,
  newPubkey: Uint8Array,
): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG()}::prize_pool::rotate_pubkey`,
    arguments: [
      tx.object(prizeAdminId),
      tx.pure.vector("u8", Array.from(newPubkey)),
    ],
  });
  return tx;
}

/**
 * Build `rotate_admin` transaction. Rotates the `PrizeAdmin.admin`
 * address (e.g. when the backend hot-wallet moves). The current admin
 * (signer) must call this; the new admin takes over immediately and
 * must re-sign all subsequent admin operations.
 *
 * @param prizeAdminId - Shared PrizeAdmin object ID
 * @param newAdmin     - Address to take over admin duties
 */
export function buildRotateAdminTx(
  prizeAdminId: string,
  newAdmin: string,
): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG()}::prize_pool::rotate_admin`,
    arguments: [tx.object(prizeAdminId), tx.pure.address(newAdmin)],
  });
  return tx;
}

export function buildSetDistributionTx(
  poolId: string,
  adminCapId: string,
  bps: number[],
  prizeCoinType: string = DUSDC_TYPE,
): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG()}::prize_pool::set_distribution`,
    typeArguments: [prizeCoinType],
    arguments: [
      tx.object(poolId),
      tx.object(adminCapId),
      tx.pure.vector("u64", bps.map((b) => BigInt(b))),
    ],
  });
  return tx;
}

/**
 * Pure helper: how much of `weekPrize` does the user get for `rank`?
 */
export function expectedAmountForRank(
  weekPrize: bigint,
  rank: number,
  distribution: number[] = DEFAULT_DISTRIBUTION_BPS,
): bigint {
  if (rank < 1) return 0n;
  const idx = rank - 1;
  if (idx >= distribution.length) return 0n;
  return (weekPrize * BigInt(distribution[idx]!)) / BigInt(BPS);
}

/**
 * Build the canonical claim message bytes (must match on-chain
 * `prize_pool::build_claim_message`). Backend should sign the keccak256
 * of this message with its ed25519 key.
 */
export function buildClaimMessageBytes(payload: ClaimPayload): Uint8Array {
  // Pool ID is 32 bytes. Strip the leading 0x if present.
  const poolIdHex = payload.poolId.startsWith("0x")
    ? payload.poolId.slice(2)
    : payload.poolId;
  if (poolIdHex.length !== 64) {
    throw new Error(`Invalid poolId length: ${poolIdHex.length}`);
  }
  const poolBytes = hexToBytes(poolIdHex);

  // User address — strip leading 0x and pad to 32 bytes.
  const userHex = payload.user.startsWith("0x")
    ? payload.user.slice(2)
    : payload.user;
  const userBytes = padLeft32(hexToBytes(userHex));

  const msg = new Uint8Array(1 + 32 + 8 + 32 + 8 + 8);
  msg[0] = 0x00; // ED25519_FLAG
  msg.set(poolBytes, 1);
  writeU64LE(msg, 1 + 32, payload.weekIndex);
  msg.set(userBytes, 1 + 32 + 8);
  writeU64LE(msg, 1 + 32 + 8 + 32, BigInt(payload.rank));
  writeU64LE(msg, 1 + 32 + 8 + 32 + 8, payload.amount);
  return msg;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function padLeft32(b: Uint8Array): Uint8Array {
  if (b.length === 32) return b;
  const out = new Uint8Array(32);
  out.set(b, 32 - b.length);
  return out;
}

function writeU64LE(buf: Uint8Array, offset: number, n: bigint): void {
  for (let i = 0; i < 8; i++) {
    buf[offset + i] = Number((n >> BigInt(i * 8)) & 0xffn);
  }
}

/**
 * Backend helper: sign a claim payload with the prize admin keypair.
 * The signature is a raw ed25519 signature over the keccak256 hash of
 * the canonical message. This matches `prize_pool::build_claim_message`
 * on-chain, which hashes the message with keccak256 and then verifies
 * the signature via `ed25519::ed25519_verify(&sig, pk, &digest)`.
 *
 * IMPORTANT: do NOT use `signer.signPersonalMessage` here — that wraps
 * the digest with a `PersonalMessage` intent prefix that the on-chain
 * verifier does not apply, so the signature would always be rejected
 * with `EInvalidSignature`. The raw `signer.sign(digest)` produces a
 * plain ed25519 signature that verifies against the bare keccak256
 * digest.
 */
export async function signClaimPayload(
  signer: Ed25519Keypair,
  payload: ClaimPayload,
  keccak256: (data: Uint8Array) => Promise<Uint8Array>,
): Promise<SignedClaim> {
  const raw = buildClaimMessageBytes(payload);
  const digest = await keccak256(raw);
  const signature = await signer.sign(digest);
  return {
    payload,
    signatureB64: Buffer.from(signature).toString("base64"),
  };
}
