/**
 * The loan product's ranges (P1). The flat P1 fee — 1.5% per started week,
 * capped at $25 — was replaced by risk-based pricing in P3 Task 2
 * (`pricingV2.ts`); only the ranges remain here, used by the rules
 * pipeline (`rules.ts`) and eligibility.
 */

export const PRICING_LIMITS = {
  minPrincipalCents: 1000n,
  maxPrincipalCents: 50000n,
  minTermDays: 7,
  maxTermDays: 30,
} as const;

/** Which of the P1 range checks `(amount, term)` fails, as eligibility reason codes. */
export function rangeReasons(
  principalCents: bigint,
  termDays: number,
): Array<"amount_out_of_range" | "term_out_of_range"> {
  const reasons: Array<"amount_out_of_range" | "term_out_of_range"> = [];
  if (principalCents < PRICING_LIMITS.minPrincipalCents || principalCents > PRICING_LIMITS.maxPrincipalCents) {
    reasons.push("amount_out_of_range");
  }
  if (termDays < PRICING_LIMITS.minTermDays || termDays > PRICING_LIMITS.maxTermDays) {
    reasons.push("term_out_of_range");
  }
  return reasons;
}
