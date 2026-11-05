/**
 * Shared classification used by both `paypalFetch` (fetch.ts, for its own
 * exhausted-retry-budget exit) and `executeOperation` (operations.ts, the
 * single code path that owns `paypal_operations.status` bookkeeping for
 * the queued-operation flow). Kept here, rather than in either module, so
 * neither has to import the other.
 */

export type TerminalFailureStatus = "failed_retryable" | "failed_terminal";

/**
 * Classifies a failed call's terminal status from its HTTP status
 * (`0` meaning a network error or timeout, never a real HTTP response):
 * - `0` or `5xx` — infrastructure trouble, worth retrying later.
 * - `401` / `409` / `429` — auth/conflict/rate-limit, also worth
 *   retrying later (a fresh token, a cleared conflict, or a cooled-down
 *   rate limit may well succeed).
 * - any other `4xx` — a definite rejection; retrying won't help.
 */
export function classifyFailureStatus(httpStatus: number): TerminalFailureStatus {
  if (httpStatus === 0) {
    return "failed_retryable";
  }
  if (httpStatus >= 500) {
    return "failed_retryable";
  }
  if (httpStatus === 401 || httpStatus === 409 || httpStatus === 429) {
    return "failed_retryable";
  }
  return "failed_terminal";
}

const BASE_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 10 * 60_000;

/**
 * `next_attempt_at` for a `failed_retryable` row: `now + 30s * 2^attempts`,
 * capped at 10 minutes. `attempts` is the row's own `attempts` column
 * value at the time of this failure (how many HTTP attempts this one
 * call made), not a count of separate `executeOperation` claims.
 */
export function computeNextAttemptAt(attempts: number, now: Date = new Date()): Date {
  const delayMs = Math.min(BASE_BACKOFF_MS * 2 ** attempts, MAX_BACKOFF_MS);
  return new Date(now.getTime() + delayMs);
}
