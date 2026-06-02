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
  | "parlay";

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
  0: "EParlayAlreadyFinalized",
  1: "ELegMismatch",
  2: "ELegAlreadyRecorded",
  3: "EMarketNotResolved",
  4: "EMarketDisputed",
  5: "EParlayNotReady",
  6: "EPoolUnderfunded",
  7: "EInvalidNewAdmin",
  8: "EInvalidLegCount",
  9: "EZeroCollateral",
  10: "EMaxPayoutBelowBps",
  11: "EInsufficientLiquidity",
  12: "EWithdrawTooLarge",
  13: "EPayoutCapExceeded",
  14: "ECoinTypeMismatch",
};

const MODULE_CODES: Record<MoveModule, Record<number, string>> = {
  prediction_market: PREDICTION_MARKET_CODES,
  streak_system: STREAK_SYSTEM_CODES,
  prize_pool: PRIZE_POOL_CODES,
  agent_policy: AGENT_POLICY_CODES,
  parlay: PARLAY_CODES,
};

/** Extract the abort code from a Sui Move-abort error message.
 *  Returns null if the message doesn't look like a Move abort. */
export function extractMoveAbortCode(msg: string): number | null {
  // Sui formats Move aborts as `MoveAbort(<MoveLocation or elided>, N)`
  // optionally followed by "in command M". Match the final `, <digits>)`
  // at the end of the abort expression.
  const m = /MoveAbort[^\n]*\)\s*,\s*(\d+)\s*\)/.exec(msg);
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

/** True if `err` is a Move abort whose symbolic name appears anywhere
 *  in the message. Useful for matching a family of errors that share
 *  a prefix (e.g. "ENotStreakOwner" + "EWrongStreakOwner" both relate
 *  to streak ownership). */
export function isMoveAbortSymbol(err: unknown, symbol: string): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes(symbol);
}
