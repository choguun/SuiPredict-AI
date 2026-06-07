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
export type MoveModule = "prediction_market" | "streak_system" | "prize_pool" | "agent_policy" | "parlay" | "user_profile" | "badge_nft" | "vault" | "registry";
/** Extract the abort code from a Sui Move-abort error message.
 *  Returns null if the message doesn't look like a Move abort. */
export declare function extractMoveAbortCode(msg: string): number | null;
/** Look up the symbolic name of an abort code in a specific module.
 *  Returns null for codes the module doesn't define. */
export declare function moveAbortSymbol(module: MoveModule, code: number): string | null;
/** Look up the symbolic name in any module. Useful when the caller
 *  doesn't know which module the abort came from (e.g. a generic error
 *  toast). Returns the first match across modules, which can collide
 *  on a handful of small numbers — use the single-module variant when
 *  the call site knows what it called. */
export declare function moveAbortSymbolAny(code: number): string | null;
/** True if `err` is a Move abort of the given code in the given module. */
export declare function isMoveAbortCode(err: unknown, module: MoveModule, code: number): boolean;
/** True if `err` is a Move abort from the given module (any code).
 *  Use this when a worker treats every abort from a specific module
 *  as a permanent failure (e.g. the parlay worker — any on-chain
 *  decision in the parlay module is by definition non-retryable).
 *  Returns false for non-Move-abort errors and for aborts from other
 *  modules; call `extractMoveAbortCode(err)` first if you need the
 *  code.
 *
 *  R58.8 audit fix: the `module` parameter is typed as
 *  `string` (not the narrower `MoveModule` union) so
 *  callers can match against external packages — the
 *  Sui framework `balance_manager`, the
 *  `deepbook` order-book package, the test-stablecoin
 *  `dusdc` module — without the
 *  `as Parameters<typeof isMoveAbortInModule>[1]`
 *  cast that the markets/[id] page used to need. The
 *  union is preserved as a documentation aid via the
 *  `MoveModule` re-export below. */
export declare function isMoveAbortInModule(err: unknown, module: string): boolean;
/** True if `err` is a Move abort whose symbolic name appears anywhere
 *  in the message. Useful for matching a family of errors that share
 *  a prefix (e.g. "ENotStreakOwner" + "EWrongStreakOwner" both relate
 *  to streak ownership). */
export declare function isMoveAbortSymbol(err: unknown, symbol: string): boolean;
//# sourceMappingURL=move-errors.d.ts.map