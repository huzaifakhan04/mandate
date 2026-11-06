const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/**
 * Minimum time between two reads of one PayPal object (a payout batch, a
 * checkout order), backing off with the object's age (real time):
 * < 10 min → 1 min; < 1 h → 5 min; < 24 h → 30 min; else 6 h.
 */
export function pollIntervalMs(ageMs: number): number {
  if (ageMs < 10 * MINUTE_MS) return MINUTE_MS;
  if (ageMs < HOUR_MS) return 5 * MINUTE_MS;
  if (ageMs < 24 * HOUR_MS) return 30 * MINUTE_MS;
  return 6 * HOUR_MS;
}

/**
 * Whether a background poll of an object is due (shared by
 * `pollPayoutStatus` and the reconcile cron's checkout polling):
 * - not before `minAgeMs` after the object was created (a fresh checkout
 *   is still in the hands of the request/agent that made it);
 * - then not sooner than `pollIntervalMs(age)` after the last read (any
 *   outcome — failed reads throttle too); no read yet → due.
 * All times are real time; `now` is injectable for tests.
 */
export function isPollDue({
  createdAt,
  lastReadAt,
  now,
  minAgeMs = 0,
}: {
  createdAt: Date;
  lastReadAt: Date | null;
  now: Date;
  minAgeMs?: number;
}): boolean {
  const age = now.getTime() - createdAt.getTime();
  if (age < minAgeMs) {
    return false;
  }
  if (!lastReadAt) {
    return true;
  }
  return now.getTime() - lastReadAt.getTime() >= pollIntervalMs(age);
}
