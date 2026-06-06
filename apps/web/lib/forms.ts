/**
 * Form input helpers — defensive parsing for free-text fields that
 * the user controls. Used by the trade/vault/market pages.
 *
 * `onChange` for a `type="number"` input gives you a string, and
 * `Number("")` is 0, `Number("abc")` is NaN, and `Number("1.2.3")`
 * is NaN. None of those cause React to throw, so the state would
 * happily end up `0` or `NaN` and the downstream PTB builder would
 * either build a zero-coin splitCoins PTB (chain aborts with
 * EZeroAmount) or pass a `NaN` to BigInt() (TypeError, not caught
 * by the caller's try/catch because it lives in the render path).
 *
 * The shared helpers here make it impossible for the value to land
 * in a state the chain would reject. `clampNumberString` enforces
 * a non-empty, well-formed, bounded decimal; the page-level callers
 * wrap their `setState` with it.
 */

/** A regex that matches a positive decimal up to 6 fraction digits.
 *  No exponent, no sign, no leading zeros except the single "0" or
 *  "0.x" case. Matches "0", "0.1", "0.123456", "1", "1.5", "100",
 *  "100.000001", but not "", "abc", ".5", "1.", "1.2.3", "-1", "1e2". */
const POSITIVE_DECIMAL_RE = /^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/;

/**
 * Sanitize a free-text number input to a safe numeric value. If the
 * string is empty or malformed, falls back to `fallback`. Clamps to
 * `[min, max]`. Always returns a finite, positive number suitable
 * for downstream `Number(...)` or `BigInt(Math.round(... * 1e6))`.
 */
export function clampNumberString(
  raw: string,
  fallback: number,
  min: number,
  max: number,
): number {
  if (typeof raw !== "string") return fallback;
  const trimmed = raw.trim();
  if (!trimmed) return fallback;
  if (!POSITIVE_DECIMAL_RE.test(trimmed)) return fallback;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

/**
 * Convert a `clampNumberString`-cleaned human-readable decimal to
 * base-unit BigInt atoms using integer-only string parsing.
 *
 * R58.M7 audit fix: the previous
 * `BigInt(Math.round(amount * 1_000_000))` pattern
 * coerces the string through a `Number` (IEEE-754
 * double) before rounding and BigInt-casting. For
 * the typical vault-deposit range (1 to 1_000_000
 * DUSDC) this is safe — the value is at most 1e12
 * atoms, well below 2^53. But the helper is
 * paranoid-by-default: a future caller that lifts
 * the clamp ceiling to, say, 1e9 DUSDC (1e15 atoms)
 * would silently lose 1-ULP precision and the
 * downstream `splitCoins` would build a PTB that
 * is 1 atom short of the user's intent.
 *
 * The implementation parses the integer and
 * fractional parts as separate `BigInt`s and
 * combines them, skipping the `Number(...)`
 * intermediate. `scale` is the number of fraction
 * digits (6 for dUSDC, 9 for spot prices in
 * `tick_size` units). Throws on a malformed input
 * — callers are expected to run `clampNumberString`
 * first, so the throw is a programmer error and
 * should surface in dev.
 */
export function decimalStringToAtoms(
  raw: string,
  scale: number,
): bigint {
  if (!Number.isInteger(scale) || scale < 0 || scale > 18) {
    throw new Error(
      `decimalStringToAtoms: scale must be an integer in [0, 18] (got ${scale})`,
    );
  }
  const trimmed = (raw ?? "").trim();
  if (!trimmed || !POSITIVE_DECIMAL_RE.test(trimmed)) {
    throw new Error(
      `decimalStringToAtoms: "${raw}" is not a valid positive decimal with up to ${scale} fraction digits`,
    );
  }
  const [whole, frac = ""] = trimmed.split(".");
  const scaleBig = BigInt(10) ** BigInt(scale);
  const wholeAtoms = BigInt(whole) * scaleBig;
  // Pad the fractional part to `scale` digits and
  // convert to BigInt directly — never via `Number`.
  const padded = frac.padEnd(scale, "0").slice(0, scale);
  const fracAtoms = BigInt(padded || "0");
  return wholeAtoms + fracAtoms;
}
