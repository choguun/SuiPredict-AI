/**
 * Prize pool SDK — wraps `prize_pool.move` (suipredict_agent_policy module).
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
export declare const DEFAULT_DISTRIBUTION_BPS: number[];
export declare const BPS = 10000;
export declare const MAX_RANK = 100;
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
 *
 * R38 audit fix: the on-chain `prize_pool::fund_pool<PrizeCoin>`
 * takes a `Coin<PrizeCoin>` BY VALUE and absorbs the entire
 * balance via `coin::into_balance(coin)`. The previous builder
 * passed `tx.object(coinId)` directly, which would have drained
 * the user's full DUSDC balance. Split `amountAtoms` off the
 * source coin in-PTB and pass the split result, matching the
 * pattern from `buildCreateParlayTx` (R36) and `buildMintSharesTx`.
 */
export declare function buildFundPoolTx(poolId: string, coinId: string, amountAtoms: number | bigint, prizeCoinType?: string): Transaction;
/**
 * Build `create_pool` transaction. Deployer-only initialization of a
 * `PrizePool<PrizeCoin>` shared object. The new pool is seeded with
 * `seedAtoms` atoms of `PrizeCoin` (split off `initialCoinId` in-PTB)
 * and `current_week = initialWeek`. Pass `seedAtoms: 0n` to create an
 * empty pool and `fund_pool` it later.
 *
 * R48 audit fix: the on-chain `create_pool` takes the seed `Coin`
 * BY VALUE, and the previous builder passed the *whole* source coin
 * via `tx.object(...)`. A deployer whose hot wallet held a single
 * 100k-DUSDC coin (and only wanted to seed 1k DUSDC) lost 99,000
 * DUSDC into the prize pool on the first `create_pool` call. Mirror
 * the R36/R38 split-then-pass pattern from `buildFundPoolTx` and
 * `buildVaultDepositTx` so the seed amount is exact. The caller
 * supplies `seedAtoms` explicitly; the helper picks the seed off
 * via `tx.splitCoins` and hands the result to `create_pool`.
 */
export declare function buildCreatePoolTx(params: {
    initialCoinId: string;
    seedAtoms: bigint;
    initialWeek: bigint;
    prizeCoinType?: string;
}): Transaction;
/**
 * Build `claim_prize` transaction. The `signature` must be an ed25519
 * signature over the canonical claim message (see `signClaimPayload`)
 * by the `PrizeAdmin` pubkey.
 */
export declare function buildClaimPrizeTx(params: {
    poolId: string;
    prizeAdminId: string;
    userStreakId: string;
    weekIndex: bigint;
    rank: number;
    amount: bigint;
    signatureB64: string;
    poolIdForSig: string;
    prizeCoinType?: string;
    distribution?: number[];
}): Transaction;
export declare function buildSettleWeekTx(poolId: string, adminCapId: string, weekIndex: bigint, prizeCoinType?: string): Transaction;
export declare function buildRotateWeekTx(poolId: string, adminCapId: string, newWeek: bigint, prizeCoinType?: string): Transaction;
export declare function buildRotatePubkeyTx(prizeAdminId: string, newPubkey: Uint8Array): Transaction;
/**
 * Build `rotate_admin` transaction. Rotates the `PrizeAdmin.admin`
 * address (e.g. when the backend hot-wallet moves). The current admin
 * (signer) must call this; the new admin takes over immediately and
 * must re-sign all subsequent admin operations.
 *
 * @param prizeAdminId - Shared PrizeAdmin object ID
 * @param newAdmin     - Address to take over admin duties
 */
export declare function buildRotateAdminTx(prizeAdminId: string, newAdmin: string): Transaction;
export declare function buildSetDistributionTx(poolId: string, adminCapId: string, bps: number[], prizeCoinType?: string): Transaction;
/**
 * Pure helper: how much of `weekPrize` does the user get for `rank`?
 */
export declare function expectedAmountForRank(weekPrize: bigint, rank: number, distribution?: number[]): bigint;
/**
 * Build the canonical claim message bytes (must match on-chain
 * `prize_pool::build_claim_message`). Backend should sign the keccak256
 * of this message with its ed25519 key.
 *
 * R48 audit fix: normalize `poolId` and `user` to the canonical
 * 32-byte hex (no `0x`, lowercase) before byte-packing. The
 * submission side (`buildSubmitClaimTx`) was fixed in R44 to
 * normalize, but the *signing* side still hashed whatever the
 * caller passed in. A leaderboard worker that hands the backend a
 * mixed-case poolId produces a signature over mixed-case bytes
 * that the on-chain verifier (which reads the canonical form from
 * the PTB args) will reject.
 */
export declare function buildClaimMessageBytes(payload: ClaimPayload): Uint8Array;
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
export declare function signClaimPayload(signer: Ed25519Keypair, payload: ClaimPayload, keccak256: (data: Uint8Array) => Promise<Uint8Array>): Promise<SignedClaim>;
//# sourceMappingURL=prize-client.d.ts.map