/**
 * Move-abort translator.
 *
 * The Sui SDK surfaces contract reverts as a plain `Error` whose
 * `.message` looks like:
 *
 *   "MoveAbort(MoveLocation { module: ... }, 15) in command 0"
 *
 * Pre-r14 the dispute page and the streak-sweeper each had their own
 * regex literal to pull the abort code out of that blob. The SDK is
 * the natural single source of truth — both packages depend on it,
 * and adding a new module's error codes there is one edit, not three.
 *
 * The codes below mirror the `const E*: u64 = N;` lines in:
 *   - prediction_market.move      (E0..E16)
 *   - streak_system.move          (E0..E8)
 *   - prize_pool.move             (E0..E9)
 *   - agent_policy.move           (E0..E6)
 *   - parlay.move                 (E0..E14)
 *   - user_profile.move           (E0..E3)
 *   - badge_nft.move              (E0..E1)
 *   - vault.move                  (E0, E1, E3)
 *   - registry.move               (E0..E1)
 *
 * If a new module is added, the abort codes must be added here too —
 * but the unknown-code fallback still returns a usable "Move abort N"
 * string so the UI never degrades to a raw blob.
 */

export type MoveModule =
  | "prediction_market"
  | "streak_system"
  | "prize_pool"
  | "agent_policy"
  | "parlay"
  | "user_profile"
  | "badge_nft"
  | "vault"
  | "registry";

/**
 * `code: number` per module. We don't key the map by `(module, code)`
 * because the same code can mean different things in different modules
 * (e.g. `code 5` is `EZeroAmount` in prediction_market, `EInvalidTier`
 * in streak_system, and `EPrizeTooLarge` in prize_pool). Group by
 * module to avoid the ambiguity.
 */
const PREDICTION_MARKET_CODES: Record<number, string> = {
  0: "ENotCreator",
  1: "EMarketNotActive",
  2: "EAlreadyResolved",
  3: "ENotExpired",
  4: "EInvalidOutcome",
  5: "EZeroAmount",
  6: "EReferralAlreadySet",
  7: "ENotAdmin",
  8: "EInvalidPrice",
  9: "EInvalidQuantity",
  10: "EWrongOutcome",
  11: "ENotDisputed",
  12: "EAlreadyDisputed",
  13: "EWrongStreakOwner",
  14: "EDisputeWindowExpired",
  15: "EMarketDisputed",
  16: "EEvidenceUriTooLong",
};

const STREAK_SYSTEM_CODES: Record<number, string> = {
  0: "ENotAdmin",
  1: "EStreakExists",
  2: "EStreakBroken",
  3: "EAlreadyRecordedToday",
  4: "EInvalidOutcome",
  5: "EInvalidTier",
  6: "EBadgeAlreadyClaimed",
  7: "EBadgeNotReached",
  8: "EInvalidNewAdmin",
};

const PRIZE_POOL_CODES: Record<number, string> = {
  0: "ENotAdmin",
  1: "EInvalidAmount",
  2: "EInvalidRank",
  3: "ENotStreakOwner",
  4: "EAlreadyClaimed",
  5: "EPrizeTooLarge",
  6: "EInvalidSignature",
  7: "EPoolSettled",
  8: "EWrongPrizeCoin",
  9: "EInvalidDistribution",
};

const AGENT_POLICY_CODES: Record<number, string> = {
  0: "ENotOwner",
  1: "ENotAgent",
  2: "ERevoked",
  3: "EPaused",
  4: "EExpired",
  5: "EBudgetExceeded",
  6: "EZeroAmount",
};

const PARLAY_CODES: Record<number, string> = {
  0: "ENotAdmin",
  1: "EZeroAmount",
  2: "EInvalidLegCount",
  3: "ELegPredictionMismatch",
  4: "EPayoutTooLarge",
  5: "EPoolUnderfunded",
  6: "EMarketNotResolved",
  7: "EMarketDisputed",
  8: "ELegMismatch",
  9: "ELegAlreadyRecorded",
  10: "EParlayNotReady",
  11: "ENotOwner",
  12: "EParlayAlreadyFinalized",
  13: "EInvalidPayoutBps",
  14: "EInvalidNewAdmin",
};

const USER_PROFILE_CODES: Record<number, string> = {
  0: "EProfileExists",
  1: "ENotOwner",
  2: "EInvalidCountry",
  3: "EInvalidForecasterKind",
};

const BADGE_NFT_CODES: Record<number, string> = {
  0: "ENotStreakOwner",
  1: "EInvalidTier",
};

const VAULT_CODES: Record<number, string> = {
  0: "ENotAdmin",
  1: "EZeroAmount",
  // Code 2 is intentionally absent — vault.move never assigned one.
  3: "EInsufficientAvailable",
};

const REGISTRY_CODES: Record<number, string> = {
  0: "ENotAdmin",
  1: "EMarketExists",
};

const MODULE_CODES: Record<MoveModule, Record<number, string>> = {
  prediction_market: PREDICTION_MARKET_CODES,
  streak_system: STREAK_SYSTEM_CODES,
  prize_pool: PRIZE_POOL_CODES,
  agent_policy: AGENT_POLICY_CODES,
  parlay: PARLAY_CODES,
  user_profile: USER_PROFILE_CODES,
  badge_nft: BADGE_NFT_CODES,
  vault: VAULT_CODES,
  registry: REGISTRY_CODES,
};

/** Extract the abort code from a Sui Move-abort error message.
 *  Returns null if the message doesn't look like a Move abort. */
export function extractMoveAbortCode(msg: string): number | null {
  // Sui formats Move aborts as `MoveAbort(<MoveLocation or elided>, N)`
  // optionally followed by "in command M". When a wrapper aborts on an
  // inner function abort, the gRPC error string embeds *both* blocks:
  //
  //   MoveAbort(MoveLocation { module: "balance_manager" }, 7) in command 1
  //   MoveAbort(MoveLocation { module: "prediction_market" }, 9) in command 0
  //
  // The caller's `isMoveAbortCode(err, "prediction_market", 9)` check
  // wants the outer (last) abort — the one for the function the user
  // actually called. Greedy `[\s\S]*` with a `, N)` + `in command`
  // anchor walks back to the *last* `, N)` in the string.
  //
  // R57.3 audit fix: the previous regex used non-greedy `[\s\S]*?` and
  // returned the *innermost* (first-in-string) abort code. A wrapper
  // PTB that aborted on a deeper call would silently misroute to the
  // "unknown abort" branch in the agents' parlay-worker /
  // market-resolver retry classification. Greedy match anchored to
  // the `in command` suffix is the robust pattern; a paren-depth
  // walker would be future-proof to a Sui rendering change but is
  // overkill for the current SDK shape.
  const m = /MoveAbort[\s\S]*\)\s*,\s*(\d+)\s*\)\s*(?=$|in command)/.exec(msg);
  return m ? Number(m[1]) : null;
}

/** Look up the symbolic name of an abort code in a specific module.
 *  Returns null for codes the module doesn't define. */
export function moveAbortSymbol(
  module: MoveModule,
  code: number,
): string | null {
  return MODULE_CODES[module][code] ?? null;
}

/** Look up the symbolic name in any module. Useful when the caller
 *  doesn't know which module the abort came from (e.g. a generic error
 *  toast). Returns the first match across modules, which can collide
 *  on a handful of small numbers — use the single-module variant when
 *  the call site knows what it called. */
export function moveAbortSymbolAny(code: number): string | null {
  for (const m of Object.keys(MODULE_CODES) as MoveModule[]) {
    const sym = MODULE_CODES[m][code];
    if (sym) return sym;
  }
  return null;
}

/** True if `err` is a Move abort of the given code in the given module. */
export function isMoveAbortCode(
  err: unknown,
  module: MoveModule,
  code: number,
): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  if (moveAbortSymbol(module, code) === null) {
    throw new Error(
      `isMoveAbortCode: code ${code} is not defined for module "${module}"`,
    );
  }
  return extractMoveAbortCode(msg) === code;
}

/** True if `err` is a Move abort from the given module (any code).
 *  Use this when a worker treats every abort from a specific module
 *  as a permanent failure (e.g. the parlay worker — any on-chain
 *  decision in the parlay module is by definition non-retryable).
 *  Returns false for non-Move-abort errors and for aborts from other
 *  modules; call `extractMoveAbortCode(err)` first if you need the
 *  code. */
export function isMoveAbortInModule(
  err: unknown,
  module: MoveModule,
): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  // Sui's error text embeds the module name as `module: "<name>"` in
  // the MoveLocation. Match the unqualified module name to avoid
  // false positives (e.g. an error in module "prize_pool" containing
  // the substring "pool" inside a different field).
  const moduleRe = new RegExp(`module:\\s*"${module}"`);
  if (!moduleRe.test(msg)) return false;
  return /MoveAbort/.test(msg);
}

/** True if `err` is a Move abort whose symbolic name appears anywhere
 *  in the message. Useful for matching a family of errors that share
 *  a prefix (e.g. "ENotStreakOwner" + "EWrongStreakOwner" both relate
 *  to streak ownership). */
export function isMoveAbortSymbol(err: unknown, symbol: string): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes(symbol);
}
