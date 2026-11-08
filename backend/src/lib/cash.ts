// Cash credit amounts. Kept dependency-free so it can be unit tested.

/** Most cash credit one payment can be (a typo guard). */
export const MAX_CASH_CENTS = 20_000;
export const CASH_STEP_CENTS = 500;

/**
 * Cash credit chosen by the player: any multiple of $5 from $5 to $200.
 * Missing → `dflt`. Returns cents, or an error message.
 */
export function cashCreditCents(raw: unknown, dflt = CASH_STEP_CENTS): number | string {
  if (raw == null) return dflt;
  const n = typeof raw === 'number' ? raw : Number.NaN;
  if (!Number.isInteger(n) || n < CASH_STEP_CENTS || n > MAX_CASH_CENTS || n % CASH_STEP_CENTS !== 0) {
    return `Cash amounts go in $5 steps, from $5 to $${MAX_CASH_CENTS / 100}`;
  }
  return n;
}
