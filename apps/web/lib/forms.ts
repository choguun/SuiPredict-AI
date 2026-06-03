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
