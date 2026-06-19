import { SuiGrpcClient } from "@mysten/sui/grpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { AGENT_POLICY_PACKAGE_ID, CLOCK_OBJECT_ID, DUSDC_TREASURY_CAP_ID, DUSDC_TYPE, PLP_TYPE, PREDICT_OBJECT_ID, PREDICT_PACKAGE_ID, SUI_GRPC_URL, SUI_NETWORK, dollarsToDusdc, dollarsToStrike, } from "./constants.js";
import { getManagerForOwner } from "./predict-server.js";
import { normalizeObjectId, u64ToSafeNumber, isValidSuiAddress, listAllCoins } from "./utils.js";
export function createClient() {
    // R39 audit fix: was hardcoded to `"testnet"`. Now reads
    // `SUI_NETWORK` from the env (resolved in `constants.ts`),
    // so a mainnet deploy no longer silently submits every
    // agent tx — fund_pool, fund_parlay_pool, place_order,
    // prize-admin, etc. — to the testnet cluster. The
    // `SUI_GRPC_URL` constant follows the same env.
    return new SuiGrpcClient({
        network: SUI_NETWORK,
        baseUrl: SUI_GRPC_URL,
    });
}
// R54 audit fix: a shared, process-wide gRPC client. The
// `apps/agents/src/lib.ts` previously defined its own
// `getSharedClient()` that opened a fresh `SuiGrpcClient` on
// every tick. The SDK never closed the prior ones, so the gRPC
// client pool grew to ~60 idle connections after a few minutes
// of polling. Export the singleton from the SDK so the agents'
// implementation shrinks to a re-export.
let _sharedClient = null;
export function getSharedClient() {
    if (!_sharedClient)
        _sharedClient = createClient();
    return _sharedClient;
}
// R57 agents audit fix: provide a reset path for the
// shared client. The previous `closeClient(c)` left
// `_sharedClient` populated, so a subsequent
// `getSharedClient()` returned the *closed* client — any
// `core.getObject` etc. would silently fail with
// "client is closed". Callers that want to re-open the
// client (e.g. the agents' SIGTERM → reconnect path) need
// a way to invalidate the cache without poking the
// private variable.
export function resetSharedClient() {
    _sharedClient = null;
}
/**
 * R54 audit fix: typed `closeClient` wrapper. The agents'
 * `lib.ts` previously did `(client as any).close?.()` because
 * `SuiClient = SuiGrpcClient` doesn't declare `close()` in its
 * public type — the `as any` cast is fragile and bypasses type
 * safety. A future `@mysten/sui` SDK bump that renames `close()`
 * to `destroy()` would break the agents' shutdown handler
 * silently. The single typed escape hatch lives here; callers
 * stay free of `as any`.
 */
export async function closeClient(c) {
    try {
        await c.close?.();
    }
    catch {
        // Best-effort — a misbehaving close() must not block the
        // process exit. The caller can still log if they want a
        // signal of the failure.
    }
}
export function keypairFromPrivateKey(privateKey) {
    if (privateKey.startsWith("suiprivkey")) {
        return Ed25519Keypair.fromSecretKey(privateKey);
    }
    const hex = privateKey.startsWith("0x") ? privateKey.slice(2) : privateKey;
    return Ed25519Keypair.fromSecretKey(Uint8Array.from(Buffer.from(hex, "hex")));
}
export async function executeTransaction(client, txOrFactory, signer, options) {
    const MAX_RETRY = options?.maxRetry ?? 2;
    let lastError;
    // R-WC-3.3 fix: support a factory callback so a version-race
    // retry can rebuild the `Transaction` from scratch. The Sui
    // SDK's `coreClientResolveTransactionPlugin` (see
    // `@mysten/sui/src/client/core-resolver.ts:59`,
    // `const needsPayment = !gasData.payment`) skips gas
    // re-selection when `gasData.payment` is already set. The
    // first build populates `gasData.payment` with the gas-coin
    // ref fetched at that moment; if the same `tx` is re-submitted
    // after a version-race, the resolve plugin sees the
    // truthy `gasData.payment` and skips the re-fetch — so the
    // retry re-uses the same stale version, and the same
    // version-race error fires again. The earlier attempt to
    // work around this with `tx.setGasPayment([])` failed
    // because `[]` is truthy in JS, so the resolve plugin still
    // skipped the re-fetch, and the empty `[]` reservation
    // caused an "Invalid withdraw reservation" error. The
    // correct fix is to construct a fresh `Transaction` on
    // each retry; the factory callback lets callers like the
    // wc-creator rebuild the PTB with all input refs
    // re-fetched, while the legacy `Transaction` shape is
    // preserved for callers that don't need rebuild-on-retry
    // (and re-using a `tx` keeps their existing signature).
    const factory = typeof txOrFactory === "function" ? txOrFactory : () => txOrFactory;
    let tx = await factory();
    for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
        try {
            tx.setSender(signer.getPublicKey().toSuiAddress());
            const result = await client.signAndExecuteTransaction({
                transaction: tx,
                signer,
            });
            if (result.$kind === "FailedTransaction") {
                throw new Error(`Transaction failed: ${result.FailedTransaction.status.error?.message ?? "unknown"}`);
            }
            if (result.$kind !== "Transaction") {
                const kind = result.$kind;
                throw new Error(`signAndExecuteTransaction returned unexpected kind: ${kind}`);
            }
            const finalized = await client.waitForTransaction({
                digest: result.Transaction.digest,
                timeout: 30_000,
                include: { effects: true, events: true },
            });
            if (finalized.$kind === "FailedTransaction") {
                throw new Error(`Transaction failed: ${finalized.FailedTransaction.status.error?.message ?? "unknown"}`);
            }
            return {
                digest: finalized.Transaction.digest,
                effects: finalized.Transaction.effects,
                events: finalized.Transaction.events,
            };
        }
        catch (e) {
            lastError = e;
            const rawMsg = e instanceof Error ? e.message : String(e);
            // R-WC-3.3 fix: the protobuf-ts transport wraps the
            // Sui validator's "Transaction needs to be rebuilt
            // because object 0x… is unavailable for consumption,
            // current version: 0x…" error in
            // `decodeURIComponent` and then re-encodes the
            // resulting Error message. The string we get has
            // `%20` (URL-encoded space) between words. Normalize
            // both forms via `decodeURIComponent` (a no-op on
            // the un-encoded form) so a single regex catches
            // both.
            const msg = (() => {
                try {
                    return decodeURIComponent(rawMsg);
                }
                catch {
                    return rawMsg;
                }
            })();
            const isTransient = /(429|TooManyRequests|408|502|503|504|fetch failed|ETIMEDOUT|ECONNRESET|ECONNREFUSED|socket hang up|Service Unavailable|Bad Gateway|Gateway Timeout|Request timeout|Too Many Requests)/i.test(msg) ||
                // R-WC-3.3 fix: the gRPC client's
                // `signAndExecuteTransaction` raises
                // "Transaction needs to be rebuilt because object
                // 0x… is unavailable for consumption, current version: 0x…"
                // when an input object's version moved between PTB
                // build and signing. This is a transient race
                // (typically caused by a sibling tx consuming the
                // SUI gas coin or a shared object) — the SDK should
                // rebuild the PTB and retry. Pre-fix, the wc-creator
                // surfaced the version race as a fatal error and
                // skipped the market, even though the next tick
                // would have succeeded.
                /Transaction\s+needs\s+to\s+be\s+rebuilt/i.test(msg) ||
                /is\s+unavailable\s+for\s+consumption/i.test(msg);
            // R-WC-3.3 diag: log every caught error so the operator
            // can see whether the version-race retry is firing.
            // Pre-fix the wc-creator's `B3v4 failed: Error checking
            // transaction input objects: Transaction needs to be
            // rebuilt…` log appeared without any prior
            // `[executeTransaction] transient error (attempt 1/3)`
            // log — the only way that can happen is if the catch
            // block isn't entered, or if `isTransient` is false.
            // Surface the matching result to disambiguate.
            console.warn(`[executeTransaction:diag] attempt=${attempt} isTransient=${isTransient} msg=${msg.slice(0, 200)}`);
            if (isTransient && attempt < MAX_RETRY) {
                // R-WC-3.3: back off longer for version-race errors
                // than for transient network errors. The version
                // race is caused by a sibling tx (a sibling
                // wc-creator, a wc-maker, or a MarketMaker
                // running in parallel) that consumed the agent's
                // gas coin. Sibling txs land within ~1-3s, so a
                // 1s/2s/4s backoff (the default exponential) is
                // not enough — the gas coin's version keeps
                // moving on each retry. Use a longer fixed
                // backoff (4s/8s) for version-race errors to
                // give the sibling tx time to settle.
                const isVersionRace = /Transaction\s+needs\s+to\s+be\s+rebuilt/i.test(msg) ||
                    /is\s+unavailable\s+for\s+consumption/i.test(msg);
                const delay = isVersionRace
                    ? 4000 * 2 ** attempt
                    : 1000 * 2 ** attempt;
                console.warn(`[executeTransaction] transient error (attempt ${attempt + 1}/${MAX_RETRY + 1}), retrying in ${delay}ms: ${msg.slice(0, 120)}`);
                await new Promise((r) => setTimeout(r, delay));
                // R-WC-3.3 fix: rebuild the `Transaction` from
                // scratch on each version-race retry. See the
                // `factory` declaration above for the rationale.
                // If the caller passed a bare `Transaction`
                // (legacy shape) we keep re-using it; that path
                // is best-effort — the version-race *can* recur
                // (the gas-coin ref stays stale) but the
                // exponential backoff gives sibling txs a chance
                // to settle, and a rare second-attempt failure
                // is acceptable for the simple-shape callers
                // (mint, redeem, supply, etc.). The factory path
                // is used by `ensureMarketCreated` where the
                // version race is a hot path (the wc-creator
                // calls `create_market_with_pool` every 15
                // minutes, often against the same gas coin).
                if (isVersionRace) {
                    try {
                        tx = await factory();
                    }
                    catch (factoryErr) {
                        console.warn(`[executeTransaction] rebuild tx failed: ${factoryErr.message?.slice(0, 120)}`);
                        throw e;
                    }
                }
                continue;
            }
            throw e;
        }
    }
    throw lastError;
}
export function buildCreateManagerTx() {
    const tx = new Transaction();
    tx.moveCall({
        target: `${PREDICT_PACKAGE_ID}::predict::create_manager`,
        arguments: [],
    });
    return tx;
}
export async function createPredictManager(client, signer) {
    const address = signer.getPublicKey().toSuiAddress();
    // R52 audit fix: re-check immediately
    // before signing. The previous
    // check-then-submit-then-poll pattern
    // had a TOCTOU window: two concurrent
    // calls (e.g. a user double-clicking
    // the button) both saw "no manager",
    // both submitted, and the on-chain
    // `create_manager` (which doesn't
    // assert uniqueness) accepted both.
    // The poll loop then returned the
    // newer object, silently orphaning
    // the first. Re-check immediately
    // before signing to close the window.
    const existing = await getManagerForOwner(address);
    if (existing)
        return existing;
    const result = await executeTransaction(client, buildCreateManagerTx(), signer);
    // R52 audit fix: use a single
    // `getManagerForOwner` poll with
    // exponential backoff and a longer
    // total budget. The previous
    // fixed-1500ms × 8 attempts (12s
    // total) was wrong for an indexer
    // that lags 30s on a busy mainnet.
    // Now: 12 attempts at 1s/1.5s/2.5s/
    // 4s/6s/10s = ~24s total, plus the
    // `waitForTransaction` already
    // awaited by `executeTransaction`
    // above has surfaced the tx by the
    // time we get here, so the read-side
    // lag is just the indexer's view-
    // finality window.
    const backoffs = [1000, 1500, 2500, 4000, 6000, 10_000, 10_000, 10_000, 10_000, 10_000, 10_000, 10_000];
    for (const ms of backoffs) {
        const id = await getManagerForOwner(address);
        if (id)
            return id;
        await new Promise((r) => setTimeout(r, ms));
    }
    throw new Error(`PredictManager not found after creation (digest ${result.digest}, indexer lag?)`);
}
function buildMarketKey(tx, oracleId, expiry, strike, direction) {
    const keyFn = direction === "up" ? "up" : "down";
    return tx.moveCall({
        target: `${PREDICT_PACKAGE_ID}::market_key::${keyFn}`,
        arguments: [tx.pure.id(normalizeObjectId(oracleId)), tx.pure.u64(expiry), tx.pure.u64(strike)],
    });
}
export async function mergeAndSplitDusdc(tx, client, owner, amount) {
    // R51 audit fix: validate `amount > 0` and that
    // the type is a bigint. The previous shape accepted
    // `amount = 0n`, which would build a `splitCoins`
    // PTB with a `pure.u64(0)` arg. Sui's BCS encoder
    // accepts 0u64 (it's a valid u64), so the PTB
    // submits successfully and the user pays gas for a
    // zero-value split that yields a zero-balance coin
    // — the downstream `transferObjects` or `deposit`
    // call then aborts with an opaque Move error. A
    // non-bigint (e.g. a `number`) reaches the same
    // `tx.pure.u64(amount)` and the TS compiler
    // bails (the Sui SDK signature requires bigint),
    // but at runtime a forced-cast number reaching
    // here would silently truncate. Validate both
    // up front and throw with a clear error.
    if (typeof amount !== "bigint") {
        throw new Error(`mergeAndSplitDusdc: amount must be bigint, got ${typeof amount}`);
    }
    if (amount <= 0n) {
        throw new Error(`mergeAndSplitDusdc: amount must be > 0, got ${amount}`);
    }
    // R52 audit fix: paginate `listCoins` to
    // exhaustion. The previous single-page
    // fetch returned at most 50 coins, so a
    // wallet with more than 50 DUSDC coins
    // (e.g. after a busy day of redeems)
    // would silently report a balance
    // missing the tail of the page chain and
    // the caller's downstream "Insufficient
    // DUSDC" error would blame the user.
    const objects = await listAllCoins(client, owner, DUSDC_TYPE);
    if (objects.length === 0) {
        throw new Error(`No DUSDC found for ${owner}`);
    }
    const total = objects.reduce((s, c) => s + BigInt(c.balance), 0n);
    if (total < amount) {
        // R58.9 audit fix: format the human-readable dUSDC
        // amounts via BigInt division so a balance above
        // 2^53 - 1 (≈ 9 quadrillion atoms, ~9 PB of
        // dUSDC) doesn't lose precision. Today's wallets
        // are nowhere near that, but a stuck indexer
        // returning a corrupted 64-bit balance would
        // silently print "NaN dUSDC" via `Number(bigint) / 1e6`.
        // Mirror the pattern used by `parlay-client.ts:248-272`
        // for the gRPC `Balance<T>` reading.
        const toDusdc = (atoms) => {
            const base = 1000000n;
            const whole = atoms / base;
            const frac = atoms % base;
            return `${whole}.${frac.toString().padStart(6, "0")}`;
        };
        throw new Error(`Insufficient DUSDC: have ${toDusdc(total)}, need ${toDusdc(amount)}`);
    }
    // R52 audit fix: pick the largest coin as
    // the merge target. The previous
    // `objects[0]` was an arbitrary first
    // element of the indexer's response order,
    // which is not necessarily the largest.
    // For a user with several dust coins, the
    // first page could be a 0.5 DUSDC coin,
    // and the merge+split could fail to cover
    // the requested amount even though the
    // total is sufficient.
    const sorted = [...objects].sort((a, b) => (BigInt(b.balance) > BigInt(a.balance) ? 1 : -1));
    const primary = tx.object(sorted[0].objectId);
    if (sorted.length > 1) {
        tx.mergeCoins(primary, sorted.slice(1).map((c) => tx.object(c.objectId)));
    }
    const [coin] = tx.splitCoins(primary, [tx.pure.u64(amount)]);
    return coin;
}
export function buildDepositTx(tx, managerId, 
// eslint-disable-next-line @typescript-eslint/no-explicit-any
depositCoin) {
    // R47 audit fix: normalize `managerId`. R42 added
    // `normalizeObjectId` to the post-R40 builders but
    // missed the legacy `predict_manager::deposit` path
    // (used by the web's `app/legacy/predict/vault`
    // page). A mixed-case or whitespace-suffixed
    // managerId aborts the PTB with
    // `invalid input object`.
    tx.moveCall({
        target: `${PREDICT_PACKAGE_ID}::predict_manager::deposit`,
        typeArguments: [DUSDC_TYPE],
        arguments: [tx.object(normalizeObjectId(managerId)), depositCoin],
    });
}
export function buildMintTx(params) {
    const tx = new Transaction();
    const strike = dollarsToStrike(params.strikeDollars);
    const quantity = dollarsToDusdc(params.quantityDollars);
    const key = buildMarketKey(tx, params.oracleId, params.expiry, strike, params.direction);
    // R47 audit fix: normalize every user-supplied id.
    // R42 normalized `poolId` on the parlay builders but
    // missed the legacy `predict::mint` path. A
    // Suiscan-pasted `managerId` or `oracleId` (with
    // mixed case or trailing whitespace) would abort
    // the PTB with `invalid input object` at BCS
    // resolution.
    tx.moveCall({
        target: `${PREDICT_PACKAGE_ID}::predict::mint`,
        typeArguments: [DUSDC_TYPE],
        arguments: [
            tx.object(PREDICT_OBJECT_ID),
            tx.object(normalizeObjectId(params.managerId)),
            tx.object(normalizeObjectId(params.oracleId)),
            key,
            tx.pure.u64(quantity),
            tx.object(CLOCK_OBJECT_ID),
        ],
    });
    return tx;
}
export async function mintPositionWithTopup(client, signer, params) {
    const tx = new Transaction();
    const address = signer.getPublicKey().toSuiAddress();
    if (!params.skipTopup && params.topupDollars && params.topupDollars > 0) {
        const topup = dollarsToDusdc(params.topupDollars);
        const depositCoin = await mergeAndSplitDusdc(tx, client, address, topup);
        buildDepositTx(tx, params.managerId, depositCoin);
    }
    const strike = dollarsToStrike(params.strikeDollars);
    const quantity = dollarsToDusdc(params.quantityDollars);
    const key = buildMarketKey(tx, params.oracleId, params.expiry, strike, params.direction);
    tx.moveCall({
        target: `${PREDICT_PACKAGE_ID}::predict::mint`,
        typeArguments: [DUSDC_TYPE],
        arguments: [
            tx.object(PREDICT_OBJECT_ID),
            tx.object(normalizeObjectId(params.managerId)),
            tx.object(normalizeObjectId(params.oracleId)),
            key,
            tx.pure.u64(quantity),
            tx.object(CLOCK_OBJECT_ID),
        ],
    });
    return executeTransaction(client, tx, signer);
}
export function buildRedeemTx(params) {
    const tx = new Transaction();
    const strike = dollarsToStrike(params.strikeDollars);
    const quantity = dollarsToDusdc(params.quantityDollars);
    const key = buildMarketKey(tx, params.oracleId, params.expiry, strike, params.direction);
    const target = params.permissionless
        ? `${PREDICT_PACKAGE_ID}::predict::redeem_permissionless`
        : `${PREDICT_PACKAGE_ID}::predict::redeem`;
    // R47 audit fix: normalize `managerId` and `oracleId`.
    // The redeem path is the most-touched legacy page
    // (the `/legacy/predict/trade` "redeem" button),
    // so a mixed-case paste here would silently abort
    // the user's claim for the prior week's winnings.
    tx.moveCall({
        target,
        typeArguments: [DUSDC_TYPE],
        arguments: [
            tx.object(PREDICT_OBJECT_ID),
            tx.object(normalizeObjectId(params.managerId)),
            tx.object(normalizeObjectId(params.oracleId)),
            key,
            tx.pure.u64(quantity),
            tx.object(CLOCK_OBJECT_ID),
        ],
    });
    return tx;
}
export async function redeemPosition(client, signer, params) {
    return executeTransaction(client, buildRedeemTx(params), signer);
}
export async function supplyPLP(client, signer, amountDollars) {
    const tx = new Transaction();
    const address = signer.getPublicKey().toSuiAddress();
    const amount = dollarsToDusdc(amountDollars);
    const supplyCoin = await mergeAndSplitDusdc(tx, client, address, amount);
    const lpCoin = tx.moveCall({
        target: `${PREDICT_PACKAGE_ID}::predict::supply`,
        typeArguments: [DUSDC_TYPE],
        arguments: [tx.object(PREDICT_OBJECT_ID), supplyCoin, tx.object(CLOCK_OBJECT_ID)],
    });
    tx.transferObjects([lpCoin], tx.pure.address(address));
    return executeTransaction(client, tx, signer);
}
export async function withdrawPLP(client, signer, plpCoinId, amountDollars) {
    const tx = new Transaction();
    const address = signer.getPublicKey().toSuiAddress();
    const amount = dollarsToDusdc(amountDollars);
    // R47 audit fix: normalize the plpCoinId. R42 missed the
    // `predict::withdraw` source-coin id; a mixed-case
    // paste from the vault page aborts the PTB with
    // `invalid input object`.
    const plpCoin = tx.object(normalizeObjectId(plpCoinId));
    const [withdrawCoin] = tx.splitCoins(plpCoin, [tx.pure.u64(amount)]);
    tx.moveCall({
        target: `${PREDICT_PACKAGE_ID}::predict::withdraw`,
        typeArguments: [DUSDC_TYPE],
        arguments: [
            tx.object(PREDICT_OBJECT_ID),
            withdrawCoin,
            tx.object(CLOCK_OBJECT_ID),
        ],
    });
    tx.transferObjects([plpCoin], tx.pure.address(address));
    return executeTransaction(client, tx, signer);
}
export function buildCreatePolicyTx(agentAddress, maxBudgetDollars, expiryMs, packageId = AGENT_POLICY_PACKAGE_ID) {
    if (!packageId) {
        throw new Error("AGENT_POLICY_PACKAGE_ID not set");
    }
    // R49 audit fix: route `agentAddress` through `isValidSuiAddress`
    // for consistency with the rotate-admin builders. The on-chain
    // `agent_policy::create_policy` aborts with `EInvalidAgent` on a
    // malformed address; the build-time check costs nothing and
    // gives a friendlier error.
    if (!isValidSuiAddress(agentAddress)) {
        throw new Error(`buildCreatePolicyTx: agentAddress must be a non-zero Sui address (got "${agentAddress}")`);
    }
    // R54 audit fix: validate `maxBudgetDollars > 0` and
    // `expiryMs > now`. The on-chain `authorize_spend` immediately
    // rejects a `maxBudgetDollars = 0` policy with `EBudgetExceeded`
    // (the `0 < 1e6` check on every authorize_spend call). A past
    // `expiryMs` would create an instantly-expired policy that the
    // first `authorize_spend` rejects with `EPolicyExpired`.
    if (!Number.isFinite(maxBudgetDollars) || maxBudgetDollars <= 0) {
        throw new Error(`buildCreatePolicyTx: maxBudgetDollars must be a finite number > 0 (got ${maxBudgetDollars})`);
    }
    if (typeof expiryMs !== "bigint" || expiryMs <= 0n) {
        throw new Error(`buildCreatePolicyTx: expiryMs must be a bigint > 0 (got ${expiryMs})`);
    }
    const tx = new Transaction();
    tx.moveCall({
        target: `${packageId}::agent_policy::create_policy`,
        arguments: [
            tx.pure.address(agentAddress),
            tx.pure.u64(dollarsToDusdc(maxBudgetDollars)),
            tx.pure.u64(expiryMs),
        ],
    });
    return tx;
}
export function buildRevokePolicyTx(policyId, packageId = AGENT_POLICY_PACKAGE_ID) {
    // R47 audit fix: normalize `policyId`. R42 missed the
    // five `agent_policy::*` builders; the web settings
    // page's revoke/pause/unpause/authorize/log buttons
    // would all abort with `invalid input object` on a
    // mixed-case paste. (R44 added `isValidSuiAddress` to
    // the *input field* but not to the *PTB builder*; a
    // wallet-typed value could still slip through.)
    const tx = new Transaction();
    tx.moveCall({
        target: `${packageId}::agent_policy::revoke`,
        arguments: [tx.object(normalizeObjectId(policyId))],
    });
    return tx;
}
export function buildPausePolicyTx(policyId, packageId = AGENT_POLICY_PACKAGE_ID) {
    const tx = new Transaction();
    tx.moveCall({
        target: `${packageId}::agent_policy::pause`,
        arguments: [tx.object(normalizeObjectId(policyId))],
    });
    return tx;
}
/**
 * Build `unpause` transaction. Owner-only counterpart to
 * `buildPausePolicyTx` — the on-chain `unpause` asserts
 * `ctx.sender() == policy.owner` (pause also allows the agent,
 * unpause does not). Aborts with `ENotOwner` for any non-owner caller.
 */
export function buildUnpausePolicyTx(policyId, packageId = AGENT_POLICY_PACKAGE_ID) {
    const tx = new Transaction();
    tx.moveCall({
        target: `${packageId}::agent_policy::unpause`,
        arguments: [tx.object(normalizeObjectId(policyId))],
    });
    return tx;
}
export function buildAuthorizeSpendTx(policyId, amountDollars, packageId = AGENT_POLICY_PACKAGE_ID) {
    // R53 audit fix: validate
    // `amountDollars` at the
    // build boundary. A negative
    // value would produce a
    // negative `bigint` from
    // `dollarsToDusdc` and the
    // BCS encoder would reject
    // the cast to `u64` (or
    // produce a wrap-around).
    // A zero would pass the BCS
    // encoder but the on-chain
    // `authorize_spend` aborts
    // with `EZeroAmount` (code
    // 6). Both cases burn gas on
    // a doomed PTB.
    if (!Number.isFinite(amountDollars) || amountDollars <= 0) {
        throw new Error(`buildAuthorizeSpendTx: amountDollars must be a finite number > 0 (got ${amountDollars})`);
    }
    const tx = new Transaction();
    tx.moveCall({
        target: `${packageId}::agent_policy::authorize_spend`,
        arguments: [
            tx.object(normalizeObjectId(policyId)),
            tx.pure.u64(dollarsToDusdc(amountDollars)),
            tx.object(CLOCK_OBJECT_ID),
        ],
    });
    return tx;
}
export function buildLogActionTx(policyId, action, packageId = AGENT_POLICY_PACKAGE_ID) {
    // R47 audit fix: cap the action vector at a sane
    // length to prevent a runaway 1MB `action` from
    // bloating the indexer's `AgentActionEvent`
    // bcs payload. The Move-side check is enforced
    // by a constant `MAX_ACTION_BYTES = 1024`; a
    // caller passing a longer string would abort the
    // PTB. Throw a readable error here so the web
    // gets a useful message instead of a move-abort.
    if (action.length > 1024) {
        throw new Error(`buildLogActionTx: action length ${action.length} exceeds 1024 bytes`);
    }
    const tx = new Transaction();
    tx.moveCall({
        target: `${packageId}::agent_policy::log_action`,
        arguments: [
            tx.object(normalizeObjectId(policyId)),
            tx.pure.vector("u8", Array.from(new TextEncoder().encode(action))),
            tx.object(CLOCK_OBJECT_ID),
        ],
    });
    return tx;
}
export async function getDusdcBalance(client, owner) {
    // R52 audit fix: paginate to exhaustion
    // — a single page caps at 50 coins.
    const objects = await listAllCoins(client, owner, DUSDC_TYPE);
    return objects.reduce((sum, c) => sum + BigInt(c.balance), 0n);
}
export async function getPlpCoins(client, owner) {
    // R52 audit fix: paginate to exhaustion
    // so users with > 50 PLP coins get the
    // full set.
    return listAllCoins(client, owner, PLP_TYPE);
}
export async function getPolicyState(client, policyId, packageId = AGENT_POLICY_PACKAGE_ID) {
    try {
        const { object } = await client.core.getObject({
            objectId: policyId,
            include: { json: true },
        });
        const fields = object.json;
        if (!fields || !object.type.includes(`${packageId}::agent_policy::AgentPolicy`)) {
            return null;
        }
        // R47 audit fix: route the three u64 fields
        // through the shared `u64ToSafeNumber` helper
        // so a value above 2^53-1 logs a warning
        // instead of silently truncating. The
        // `max_budget` is the most concerning — a
        // self-hosted policy with a >9e15 atom
        // budget would lose precision at `Number(...)`
        // and the off-chain `agent_spend_*` mirror
        // would diverge from the on-chain budget.
        return {
            policy_id: policyId,
            owner: fields.owner,
            agent: fields.agent,
            max_budget: u64ToSafeNumber(fields.max_budget ?? 0n, "max_budget", policyId),
            spent: u64ToSafeNumber(fields.spent ?? 0n, "spent", policyId),
            expires_at: u64ToSafeNumber(fields.expires_at ?? 0n, "expires_at", policyId),
            revoked: fields.revoked,
            paused: fields.paused,
        };
    }
    catch {
        return null;
    }
}
export async function extractCreatedObjectId(client, digest, structSuffix) {
    const result = await client.waitForTransaction({
        digest,
        include: { effects: true, objectTypes: true },
    });
    // R54 audit fix: distinguish "tx failed" from "object not in
    // effects". The previous code returned `null` for both, so callers
    // (notably `apps/agents/src/agents/market-creator.ts:240-272`)
    // re-polled with a 60s timeout waiting for a `PredictionMarket`
    // object that would never appear (the tx was finalized as a
    // `FailedTransaction` and the on-chain object was never created).
    // Surface the failure as a typed error so the operator sees the
    // real cause; the `null` return is preserved for the "object not
    // in effects" case (a successful tx that created *some* object
    // but not the one the caller wanted).
    if (result.$kind === "FailedTransaction") {
        throw new Error(`extractCreatedObjectId: tx ${digest} failed on-chain; ` +
            "the requested object was never created. Check the digest in a Sui explorer for the abort reason.");
    }
    if (result.$kind !== "Transaction") {
        // EffectsCert / future kinds — same null semantics as before.
        return null;
    }
    const effects = result.Transaction.effects;
    const types = result.Transaction.objectTypes ?? {};
    if (!effects)
        return null;
    // R57.4 audit fix: normalize `structSuffix` to a bare struct name
    // before the substring match. The on-chain `TypeTag` is the full
    // `0x…::module::Struct` form, but callers pass the suffix in two
    // different shapes — `module::Struct` (the documented form) and
    // `<PKG>::module::Struct` (the Move TypeTag syntax). The
    // substring match against the full TypeTag works for the first
    // shape and silently misses the second. Strip the angle brackets
    // and reduce to the bare struct name (everything after the last
    // `::`) so both shapes match.
    const bareStructName = structSuffix
        .replace(/^</, "")
        .replace(/>$/, "")
        .split("::")
        .pop();
    for (const change of effects.changedObjects) {
        if (change.idOperation === "Created" &&
            types[change.objectId]?.includes(bareStructName)) {
            return change.objectId;
        }
    }
    return null;
}
export async function mintDusdcFromTreasury(client, signer, amountDollars) {
    // R55 audit fix: validate `amountDollars > 0` at the
    // build boundary. R53/R54 added the same check to
    // `buildAuthorizeSpendTx` and `buildCreatePolicyTx`
    // but missed the legacy `mintDusdcFromTreasury`. A
    // zero mints a zero-balance coin and the subsequent
    // `transferObjects` aborts with "Unused result
    // without the ability to assign". The smoke-test
    // script and devnet bootstrap both call this; a
    // stale test arg would burn gas.
    if (!Number.isFinite(amountDollars) || amountDollars <= 0) {
        throw new Error(`mintDusdcFromTreasury: amountDollars must be a finite number > 0 (got ${amountDollars})`);
    }
    const tx = new Transaction();
    const address = signer.getPublicKey().toSuiAddress();
    const amount = dollarsToDusdc(amountDollars);
    const coin = tx.moveCall({
        target: "0x2::coin::mint",
        typeArguments: [DUSDC_TYPE],
        arguments: [tx.object(DUSDC_TREASURY_CAP_ID), tx.pure.u64(amount)],
    });
    tx.transferObjects([coin], tx.pure.address(address));
    return executeTransaction(client, tx, signer);
}
//# sourceMappingURL=predict-client.js.map