/**
 * Fixed P1 loan pricing (plan, Global Constraints "Fixed P1 pricing";
 * replaced by risk-based pricing in P3):
 *
 *   fee_cents = min(2500, ceil(principal_cents × 150 × ceil(term_days / 7) / 10000))
 *   apr_bps   = round(fee / principal × 365 / term × 10000)
 *
 * i.e. 1.5% per started week, capped at $25. Pure and integer-only: the
 * fee is computed in `bigint` cents, and the APR's rounding is done on
 * exact integers (round-half-up) rather than through floating point.
 */

export const PRICING_LIMITS = {
  minPrincipalCents: 1000n,
  maxPrincipalCents: 50000n,
  minTermDays: 7,
  maxTermDays: 30,
} as const;

const FEE_BPS_PER_WEEK = 150n;
const FEE_CAP_CENTS = 2500n;

export interface Price {
  feeCents: bigint;
  aprBps: number;
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

/**
 * Prices a loan. Throws on a non-positive principal or term (the APR
 * would divide by zero); range checks (1000–50000 cents, 7–30 days) are
 * the caller's job — eligibility reports them as reason codes.
 */
export function price(principalCents: bigint, termDays: number): Price {
  if (principalCents <= 0n) {
    throw new Error(`price: principal must be positive, got ${principalCents.toString()}`);
  }
  if (!Number.isInteger(termDays) || termDays <= 0) {
    throw new Error(`price: term_days must be a positive integer, got ${termDays}`);
  }

  const weeks = BigInt(Math.ceil(termDays / 7));
  const uncappedFee = ceilDiv(principalCents * FEE_BPS_PER_WEEK * weeks, 10000n);
  const feeCents = uncappedFee < FEE_CAP_CENTS ? uncappedFee : FEE_CAP_CENTS;

  // round(fee × 365 × 10000 / (principal × term)), half-up on integers.
  const numerator = feeCents * 365n * 10000n;
  const denominator = principalCents * BigInt(termDays);
  const aprBps = Number((2n * numerator + denominator) / (2n * denominator));

  return { feeCents, aprBps };
}

/** Which of the P1 range checks `(amount, term)` fails, as eligibility reason codes. */
export function rangeReasons(principalCents: bigint, termDays: number): string[] {
  const reasons: string[] = [];
  if (principalCents < PRICING_LIMITS.minPrincipalCents || principalCents > PRICING_LIMITS.maxPrincipalCents) {
    reasons.push("amount_out_of_range");
  }
  if (termDays < PRICING_LIMITS.minTermDays || termDays > PRICING_LIMITS.maxTermDays) {
    reasons.push("term_out_of_range");
  }
  return reasons;
}
