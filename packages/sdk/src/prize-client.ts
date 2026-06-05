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
import { fromBase64 } from "@mysten/sui/utils";
import { AGENT_POLICY_PACKAGE_ID, DUSDC_TYPE } from "./constants.js";
import { normalizeObjectId, isValidSuiAddress } from "./utils.js";

const PKG = () => AGENT_POLICY_PACKAGE_ID;

// Mirror on-chain DEFAULT_DISTRIBUTION_BPS. The vector MUST sum to BPS —
// if a future edit breaks that invariant, throw at module load so the
// bad value never reaches a real signing path. The previous mirror was
// `[5000, 3000, 1500, 500, 1000×6]` summing to 16_000 bps; the contract
// accepted it (no `create_pool` assertion), so every freshly-deployed
// pool's `claim_prize` silently dropped rank-4 and beyond with
// `EPrizeTooLarge` while the backend happily signed the 160% payloads.
export const DEFAULT_DISTRIBUTION_BPS: number[] = [
  5_000, // rank 1: 50%
  3_000, // rank 2: 30%
  1_500, // rank 3: 15%
  500,   // rank 4: 5%
  0,     // rank 5: 0%
  0,     // rank 6: 0%
  0,     // rank 7: 0%
  0,     // rank 8: 0%
  0,     // rank 9: 0%
  0,     // rank 10: 0%
];
{
  const sum = DEFAULT_DISTRIBUTION_BPS.reduce((a, b) => a + b, 0);
  if (sum !== 10_000) {
    throw new Error(
      `DEFAULT_DISTRIBUTION_BPS sums to ${sum} bps, expected 10_000. ` +
        `The on-chain contract would reject this at create_pool, so the ` +
        `SDK is refusing to load rather than sign malformed claim payloads.`,
    );
  }
}

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
 *
 * R38 audit fix: the on-chain `prize_pool::fund_pool<PrizeCoin>`
 * takes a `Coin<PrizeCoin>` BY VALUE and absorbs the entire
 * balance via `coin::into_balance(coin)`. The previous builder
 * passed `tx.object(coinId)` directly, which would have drained
 * the user's full DUSDC balance. Split `amountAtoms` off the
 * source coin in-PTB and pass the split result, matching the
 * pattern from `buildCreateParlayTx` (R36) and `buildMintSharesTx`.
 */
export function buildFundPoolTx(
  poolId: string,
  coinId: string,
  amountAtoms: number | bigint,
  prizeCoinType: string = DUSDC_TYPE,
): Transaction {
  const amount = BigInt(amountAtoms);
  if (amount <= 0n) {
    throw new Error(
      `buildFundPoolTx: amountAtoms must be > 0 (got ${amountAtoms})`,
    );
  }
  const tx = new Transaction();
  // R45 audit fix: normalize the source coin id (the R42 audit
  // pass added `normalizeObjectId` to `poolId` but skipped the
  // `coinId` on the splitCoins source). Mixed-case or
  // whitespace-suffixed coin ids from env-derived values fail
  // with `invalid input object` at BCS resolution. The
  // R38 `splitCoins` fix was the right pattern; R42 was the
  // right idempotency-pattern for the pool id; this is the
  // matching source-side guard.
  const [fundCoin] = tx.splitCoins(
    tx.object(normalizeObjectId(coinId)),
    [tx.pure.u64(amount)],
  );
  tx.moveCall({
    target: `${PKG()}::prize_pool::fund_pool`,
    typeArguments: [prizeCoinType],
    arguments: [tx.object(normalizeObjectId(poolId)), tx.object(fundCoin)],
  });
  return tx;
}

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
export function buildCreatePoolTx(params: {
  initialCoinId: string;
  seedAtoms: bigint;
  initialWeek: bigint;
  prizeCoinType?: string;
}): Transaction {
  // R54 audit fix: validate `seedAtoms >= 0` and `initialWeek >= 0`.
  // A negative `bigint` would fail at `tx.pure.u64(...)` (BCS
  // encoder rejects out-of-range values). The agents'
  // `bootstrap-gamification` script reads `seedAtoms` from env; a
  // stale var could ship a broken PTB.
  if (params.seedAtoms < 0n) {
    throw new Error(
      `buildCreatePoolTx: seedAtoms must be >= 0 (got ${params.seedAtoms})`,
    );
  }
  if (params.initialWeek < 0n) {
    throw new Error(
      `buildCreatePoolTx: initialWeek must be >= 0 (got ${params.initialWeek})`,
    );
  }
  const tx = new Transaction();
  const [seedCoin] = tx.splitCoins(
    tx.object(normalizeObjectId(params.initialCoinId)),
    [tx.pure.u64(params.seedAtoms)],
  );
  tx.moveCall({
    target: `${PKG()}::prize_pool::create_pool`,
    typeArguments: [params.prizeCoinType ?? DUSDC_TYPE],
    arguments: [tx.object(seedCoin), tx.pure.u64(params.initialWeek)],
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
  //
  // R44 audit fix: compare the *normalized* ids (trim + lowercase +
  // canonical 0x prefix), not the raw strings. The web settings page
  // hands `poolId` directly to the SDK from a `useReadAdminConfig`
  // hook that doesn't normalize; an env var picked up via
  // `process.env.PRIZE_POOL_ID` is sometimes mixed-case (the
  // bootstrap-env script reads it from `.env` files copied across
  // machines). The previous `params.poolId !== params.poolIdForSig`
  // would fire on a case-only difference and refuse to build a valid
  // PTB. Run both through `normalizeObjectId` and compare, then use
  // the normalized form for the actual `tx.object` / `tx.pure.id`
  // calls below (which is what the chain resolves against).
  const normalizedPoolId = normalizeObjectId(params.poolId);
  const normalizedPoolIdForSig = normalizeObjectId(params.poolIdForSig);
  if (normalizedPoolId !== normalizedPoolIdForSig) {
    throw new Error(
      `buildClaimPrizeTx: poolId (${params.poolId}) !== poolIdForSig (${params.poolIdForSig}); ` +
        "the signature was generated against a different pool. Pass the same id for both.",
    );
  }
  // R49 audit fix: validate `rank` and `amount` at the build
  // boundary. On-chain `prize_pool::claim_prize` aborts with
  // `EInvalidRank` for `rank < 1 || rank > MAX_RANK` and with
  // `EInvalidAmount` for `amount == 0`. The check matches the
  // `/prize/claims` agents-side cap (R48) and the /prize/signature
  // R49 fix.
  if (!Number.isInteger(params.rank) || params.rank < 1 || params.rank > MAX_RANK) {
    throw new Error(
      `buildClaimPrizeTx: rank must be an integer in [1, ${MAX_RANK}] (got ${params.rank})`,
    );
  }
  // R54 audit fix: also check `rank ≤ distribution.length`. The R49
  // check only validated `rank ∈ [1, MAX_RANK]`, but the on-chain
  // `claim_prize` calls `*vector::borrow(&pool.distribution_bps, idx)`
  // (where `idx = rank - 1`) — a custom pool that sets a shorter
  // distribution (e.g. `[5000]`) would abort with an opaque
  // vector-out-of-bounds Move abort. The companion helper
  // `expectedAmountForRank` silently returns `0n` for out-of-bounds,
  // which the R49 `amount > 0` check then catches as a misleading
  // "amount must be > 0" error. Surface the real cause at the
  // build boundary by accepting an optional `distribution` arg
  // (defaulting to the canonical `DEFAULT_DISTRIBUTION_BPS`) and
  // validating `rank - 1 < distribution.length`.
  if (params.rank - 1 >= DEFAULT_DISTRIBUTION_BPS.length) {
    throw new Error(
      `buildClaimPrizeTx: rank ${params.rank} exceeds DEFAULT_DISTRIBUTION_BPS length ${DEFAULT_DISTRIBUTION_BPS.length}; ` +
        "the on-chain distribution is too short to cover this rank. " +
        "Use a shorter rank or update the pool's distribution.",
    );
  }
  if (params.amount <= 0n) {
    throw new Error(
      `buildClaimPrizeTx: amount must be > 0 (got ${params.amount})`,
    );
  }
  // R53 audit fix: validate
  // `signatureB64` decodes to
  // exactly 64 bytes (the ed25519
  // signature length). The
  // previous code called
  // `fromBase64` without
  // checking length, so a
  // misconfigured backend that
  // returned an empty string or
  // a 32-byte truncated value
  // would build a malformed
  // `vector<u8>` and the
  // on-chain
  // `ed25519::ed25519_verify`
  // would abort with an opaque
  // `EInvalidSignature` (code 6).
  // Fast-fail at the build
  // boundary so the caller can
  // diagnose the backend bug
  // before signing the PTB.
  let sigBytes: Uint8Array;
  try {
    sigBytes = fromBase64(params.signatureB64);
  } catch (e) {
    throw new Error(
      `buildClaimPrizeTx: signatureB64 is not valid base64: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
  if (sigBytes.length !== 64) {
    throw new Error(
      `buildClaimPrizeTx: signatureB64 must decode to 64 bytes (ed25519), got ${sigBytes.length}`,
    );
  }
  const tx = new Transaction();
  // R54 audit fix: validate `prizeCoinType` is non-empty. The
  // on-chain `claim_prize<PrizeCoin>` is generic over the prize
  // coin type; an empty `typeArguments: [""]` would be a
  // type-argument mismatch at BCS resolution and the wallet would
  // surface "Invalid type argument". A misconfigured admin script
  // that reads `PRIZE_COIN_TYPE` from env and defaults to `""`
  // (when unset) would silently produce a malformed PTB.
  const prizeCoinType = params.prizeCoinType ?? DUSDC_TYPE;
  if (!prizeCoinType || !prizeCoinType.startsWith("0x")) {
    throw new Error(
      `buildClaimPrizeTx: prizeCoinType must be a non-empty coin type string starting with "0x" (got "${prizeCoinType}")`,
    );
  }
  tx.moveCall({
    target: `${PKG()}::prize_pool::claim_prize`,
    typeArguments: [prizeCoinType],
    arguments: [
      tx.object(normalizedPoolId),
      tx.object(normalizeObjectId(params.prizeAdminId)),
      tx.object(normalizeObjectId(params.userStreakId)),
      tx.pure.u64(params.weekIndex),
      tx.pure.u64(params.rank),
      tx.pure.u64(params.amount),
      tx.pure.vector("u8", Array.from(sigBytes)),
      tx.pure.id(normalizedPoolIdForSig),
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
  // R55 audit fix: bound `weekIndex` at the build
  // boundary. A negative bigint would fail at
  // `tx.pure.u64` (BCS encoder rejects out-of-range
  // values); a non-bigint number would silently
  // truncate. The prize-admin agent reads
  // `nextWeek = current_week + 1` from chain, so
  // the value is normally safe, but a manual
  // override or a stale read could ship a negative
  // bigint. Mirror the `buildCreatePoolTx` pattern.
  if (typeof weekIndex !== "bigint" || weekIndex < 0n) {
    throw new Error(
      `buildSettleWeekTx: weekIndex must be a bigint >= 0 (got ${weekIndex})`,
    );
  }
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG()}::prize_pool::settle_week`,
    typeArguments: [prizeCoinType],
    arguments: [tx.object(normalizeObjectId(poolId)), tx.object(normalizeObjectId(adminCapId)), tx.pure.u64(weekIndex)],
  });
  return tx;
}

export function buildRotateWeekTx(
  poolId: string,
  adminCapId: string,
  newWeek: bigint,
  prizeCoinType: string = DUSDC_TYPE,
): Transaction {
  // R55 audit fix: same guard as `buildSettleWeekTx`.
  // The on-chain `rotate_week` calls
  // `pool.current_week = new_week` with no upper
  // bound check; a huge positive value is technically
  // legal but operationally useless. The build-time
  // guard prevents the negative-bigint BCS-encoder
  // crash that a `nextWeek = current_week + 1n`
  // race (e.g. an off-by-one in the leaderboard
  // worker) could ship.
  if (typeof newWeek !== "bigint" || newWeek < 0n) {
    throw new Error(
      `buildRotateWeekTx: newWeek must be a bigint >= 0 (got ${newWeek})`,
    );
  }
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG()}::prize_pool::rotate_week`,
    typeArguments: [prizeCoinType],
    arguments: [tx.object(normalizeObjectId(poolId)), tx.object(normalizeObjectId(adminCapId)), tx.pure.u64(newWeek)],
  });
  return tx;
}

export function buildRotatePubkeyTx(
  prizeAdminId: string,
  newPubkey: Uint8Array,
): Transaction {
  // R55 audit fix: enforce the 32-byte ed25519
  // pubkey length. The on-chain `prize_pool::rotate_pubkey`
  // stores the bytes verbatim and subsequent
  // `claim_prize` calls `ed25519::ed25519_verify`
  // with this pubkey, which requires exactly 32
  // bytes. A wrong-length pubkey silently kills
  // every future claim with `EInvalidSignature`
  // (code 6) until rotated back. The
  // `bootstrap-gamification` script and
  // `rotate-prize-pubkey.ts` script both slice the
  // 64-byte ed25519 secret key; a copy-paste from
  // the wrong slice is a one-way ticket to "no
  // winners can ever claim".
  if (!(newPubkey instanceof Uint8Array)) {
    throw new Error(
      `buildRotatePubkeyTx: newPubkey must be a Uint8Array (got ${typeof newPubkey})`,
    );
  }
  if (newPubkey.length !== 32) {
    throw new Error(
      `buildRotatePubkeyTx: newPubkey must be exactly 32 bytes (ed25519 pubkey), got ${newPubkey.length}`,
    );
  }
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG()}::prize_pool::rotate_pubkey`,
    arguments: [
      tx.object(normalizeObjectId(prizeAdminId)),
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
  // R48 audit fix: pre-validate `newAdmin` so a typo (`""`,
  // `"0x0"`) surfaces as a build-time error instead of a Move
  // abort at execute time. Mirror the R37 streak guard.
  // R49 audit fix: route through `isValidSuiAddress` for
  // consistency with the other builders and to also reject
  // whitespace, mixed-case-with-trailing-space, and the
  // all-zeros placeholder.
  if (!isValidSuiAddress(newAdmin)) {
    throw new Error(
      `buildRotateAdminTx: newAdmin must be a non-zero Sui address (got "${newAdmin}")`,
    );
  }
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG()}::prize_pool::rotate_admin`,
    arguments: [tx.object(normalizeObjectId(prizeAdminId)), tx.pure.address(newAdmin)],
  });
  return tx;
}

export function buildSetDistributionTx(
  poolId: string,
  adminCapId: string,
  bps: number[],
  prizeCoinType: string = DUSDC_TYPE,
): Transaction {
  // R49 audit fix: on-chain `prize_pool::set_distribution` aborts
  // with `EInvalidDistribution` when the bps vector doesn't sum to
  // exactly 10_000. The module-load `DEFAULT_DISTRIBUTION_BPS`
  // check covers the constant, but a caller's override could
  // ship a sum != 10_000 and only learn about it at execute
  // time. Catch it at the build boundary.
  //
  // R54 audit fix: also cap the bps vector length at MAX_RANK. The
  // on-chain function only asserts the sum; a malicious or buggy
  // admin can ship a 1,000-element vector, which is then stored
  // permanently on the shared `PrizePool` and bloats every
  // subsequent `readPrizePoolDistribution` / `expectedAmountForRank`
  // call. Mirror the on-chain `MAX_RANK = 100` constant.
  if (bps.length === 0) {
    throw new Error(
      `buildSetDistributionTx: bps must be non-empty (got length 0)`,
    );
  }
  if (bps.length > MAX_RANK) {
    throw new Error(
      `buildSetDistributionTx: bps vector must be <= MAX_RANK (${MAX_RANK}) elements (got ${bps.length})`,
    );
  }
  for (const b of bps) {
    if (!Number.isInteger(b) || b < 0 || b > BPS) {
      throw new Error(
        `buildSetDistributionTx: each bps entry must be an integer in [0, ${BPS}] (got ${b})`,
      );
    }
  }
  const sumBps = bps.reduce((acc, b) => acc + BigInt(b), 0n);
  if (sumBps !== BigInt(BPS)) {
    throw new Error(
      `buildSetDistributionTx: bps must sum to BPS (${BPS}) (got ${sumBps})`,
    );
  }
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG()}::prize_pool::set_distribution`,
    typeArguments: [prizeCoinType],
    arguments: [
      tx.object(normalizeObjectId(poolId)),
      tx.object(normalizeObjectId(adminCapId)),
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
export function buildClaimMessageBytes(payload: ClaimPayload): Uint8Array {
  // Pool ID is 32 bytes. Normalize: strip 0x prefix, lowercase,
  // then hex-decode the canonical form.
  const poolIdHex = normalizeObjectId(payload.poolId).slice(2);
  if (poolIdHex.length !== 64) {
    throw new Error(`Invalid poolId length: ${poolIdHex.length}`);
  }
  const poolBytes = hexToBytes(poolIdHex);

  // User address — normalize to 32-byte lowercase hex (no 0x), then
  // left-pad to 32 bytes (hex is already 64 chars for a valid
  // Sui address, but the padLeft32 guard mirrors the prior safety
  // for short inputs).
  const userHex = normalizeObjectId(payload.user).slice(2);
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
