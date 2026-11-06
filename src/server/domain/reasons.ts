/**
 * Reason codes and their fixed human text (P3 Global Constraints, "Reason
 * codes"): Reg B–style principal reasons for a decline. The text is fixed
 * here — never generated — and at most `MAX_SHOWN_REASONS` are shown, in
 * `REASON_PRIORITY` order (the rules pipeline's order, `domain/rules.ts`).
 */
import { PRICING_LIMITS } from "./pricing";

/** Whole dollars from cents, e.g. 1000n → "$10". */
function dollars(cents: bigint): string {
  return `$${(cents / 100n).toString()}`;
}

export const REASON_PRIORITY = [
  // 0. product range
  "amount_out_of_range",
  "term_out_of_range",
  // 1. tier / claim
  "claim_required",
  "tier_per_loan",
  // 2. mandate
  "mandate_missing",
  "mandate_per_loan",
  "mandate_total_owed",
  "mandate_fee",
  "mandate_term",
  "mandate_collateral",
  // 3. sanctions stub
  "sanctions_hit",
  // 4. grade E
  "insufficient_credit_history",
  "score_too_low",
  // 5. amount vs the effective cap, and approval authority (grade D)
  "amount_exceeds_limit",
  "manual_review_declined",
  // 6. collateral
  "insufficient_collateral",
  // 7. declarations
  "declaration_missing",
  // 8. capacity: one open loan, pool liquidity
  "open_loan_exists",
  "insufficient_liquidity",
] as const;

export type ReasonCode = (typeof REASON_PRIORITY)[number];

export const REASON_TEXT: Record<ReasonCode, string> = {
  amount_out_of_range: `Amount requested is outside the range we lend (${dollars(PRICING_LIMITS.minPrincipalCents)} to ${dollars(PRICING_LIMITS.maxPrincipalCents)}).`,
  term_out_of_range: `Term requested is outside the range we lend (${PRICING_LIMITS.minTermDays} to ${PRICING_LIMITS.maxTermDays} days).`,
  claim_required: "Unable to verify identity: the agent is not claimed by a verified human.",
  tier_per_loan: "Amount requested exceeds the per-loan limit for your verification tier.",
  mandate_missing: "No current signed mandate from your human authorizes borrowing.",
  mandate_per_loan: "Amount requested exceeds the per-loan limit in your human's mandate.",
  mandate_total_owed: "Total owed would exceed the limit in your human's mandate.",
  mandate_fee: "The fee for this loan exceeds the maximum fee in your human's mandate.",
  mandate_term: "Term requested exceeds the maximum term in your human's mandate.",
  mandate_collateral: "The collateral offered is not allowed by your human's mandate.",
  sanctions_hit: "Unable to complete required sanctions screening of the applicant.",
  insufficient_credit_history: "Insufficient credit history.",
  score_too_low: "Agent Credit Score below our minimum (grade E).",
  amount_exceeds_limit: "Amount requested exceeds the credit limit for your grade.",
  manual_review_declined: "Amount requested is above the automatic-approval limit for your grade; manual review declined.",
  insufficient_collateral: "Value of collateral is not sufficient: the invoice must cover at least 1.1× the amount.",
  declaration_missing: "Required application declarations were not provided.",
  open_loan_exists: "You already have an open loan with us.",
  insufficient_liquidity: "The lending pool cannot fund this amount right now.",
};

export const MAX_SHOWN_REASONS = 4;

export function isReasonCode(code: string): code is ReasonCode {
  return Object.prototype.hasOwnProperty.call(REASON_TEXT, code);
}

const PRIORITY_INDEX = new Map<string, number>(REASON_PRIORITY.map((code, index) => [code, index]));

/** Sorts codes by priority (unique, unknown codes dropped). */
export function byPriority(codes: readonly string[]): ReasonCode[] {
  return [...new Set(codes)]
    .filter(isReasonCode)
    .sort((a, b) => (PRIORITY_INDEX.get(a) ?? 0) - (PRIORITY_INDEX.get(b) ?? 0));
}

/** The principal reasons shown on a notice: at most 4, in priority order, with their fixed text. */
export function principalReasons(codes: readonly string[]): Array<{ code: ReasonCode; text: string }> {
  return byPriority(codes)
    .slice(0, MAX_SHOWN_REASONS)
    .map((code) => ({ code, text: REASON_TEXT[code] }));
}

/** Basis points as a percent with up to two decimals, e.g. 500 → "5%", 580 → "5.8%". */
function percentText(bps: number): string {
  return `${Number((bps / 100).toFixed(2))}%`;
}

/**
 * P3 final review C1: the `mandate_fee` next step with the real numbers —
 * the mandate's current `max_fee_bps` and the fee this request was quoted,
 * as bps of the principal (rounded up, so a mandate at that value passes).
 */
export function mandateFeeAdvice(maxFeeBps: number, feeCents: number, amountCents: number): string {
  const neededBps = amountCents > 0 ? Math.ceil((feeCents * 10000) / amountCents) : 0;
  // ≤ 200 chars (the narrative text cap) for any realistic numbers.
  return (
    `Ask your human to raise the mandate's max fee (currently ${percentText(maxFeeBps)}) to at least ` +
    `${percentText(neededBps)} (${neededBps} bps; fee ${feeCents} cents on ${amountCents}) and re-sign it.`
  );
}
