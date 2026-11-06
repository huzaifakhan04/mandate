/**
 * Pure classification helpers used by `operations.ts`, the single owner
 * of `paypal_operations` status/attempts/backoff writes (Ruling H).
 */

export type TerminalFailureStatus = "failed_retryable" | "failed_terminal";

/**
 * Classifies a final non-2xx HTTP status:
 * - `5xx` — infrastructure trouble, worth retrying later.
 * - `401` / `409` / `429` — auth/conflict/rate-limit, also worth
 *   retrying later (a fresh token, a cleared conflict, or a cooled-down
 *   rate limit may well succeed).
 * - any other `4xx` — a definite rejection; retrying won't help.
 *
 * A network error / timeout never reaches this (there is no HTTP status);
 * `operations.ts` always treats it as `failed_retryable`.
 */
export function classifyFailureStatus(httpStatus: number): TerminalFailureStatus {
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
/** 2^5 · 30s already exceeds the 10-minute cap; clamping the exponent keeps the math finite. */
const MAX_EXPONENT = 10;

/**
 * `next_attempt_at` for a `failed_retryable` row: `now + 30s · 2^attempts`,
 * capped at 10 minutes. `attempts` is the row's *cumulative* `attempts`
 * column after this failure (every HTTP attempt across every
 * `executeOperation` run), so backoff keeps growing across runs.
 */
export function computeNextAttemptAt(attempts: number, now: Date = new Date()): Date {
  const exponent = Math.min(Math.max(attempts, 0), MAX_EXPONENT);
  const delayMs = Math.min(BASE_BACKOFF_MS * 2 ** exponent, MAX_BACKOFF_MS);
  return new Date(now.getTime() + delayMs);
}
