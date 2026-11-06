import { GRADE_D_AUTO_APPROVE_MAX_CENTS } from "../domain/rules";

/**
 * M9 (final review): example arguments for `next_actions` that point at a
 * tool before the caller has chosen real values. Every `next_actions`
 * entry must pass its target tool's input schema as-is (pinned by
 * tests/unit/contracts/nextActions.test.ts), so an agent that follows one
 * literally gets a real answer rather than INVALID_REQUEST — the values are
 * the smallest valid amounts, which the agent should replace with its own.
 */

/** The minimum note purchase, as an example amount. */
export const SAMPLE_BUY_NOTES_ARGS = { amount_cents: 1000 } as const;

/** The smallest loan the bank prices (1000 cents for 7 days). */
export const SAMPLE_CHECK_ELIGIBILITY_ARGS = { amount_cents: 1000, term_days: 7 } as const;

/** Placeholders the agent must replace with its own name and PayPal account. */
export const SAMPLE_REGISTER_AGENT_ARGS = {
  name: "<your agent's name>",
  payout_email: "your-paypal-account@example.com",
} as const;

/**
 * P3 final review I2: the newcomer path as a `check_eligibility` call — the
 * requested amount capped at the grade D auto-approval limit (5000 cents),
 * the same term, backed by an invoice of ceil(1.5 × amount) (the coverage
 * that scores the full 20 collateral points). A fresh claimed agent scores
 * grade E unsecured but grade D with this invoice.
 */
export function invoiceBackedCheckArgs(amountCents: number, termDays: number) {
  const amount = Math.min(amountCents, Number(GRADE_D_AUTO_APPROVE_MAX_CENTS));
  return {
    amount_cents: amount,
    term_days: termDays,
    invoice_amount_cents: Math.ceil((amount * 3) / 2),
    collateral: "invoice_link" as const,
  };
}

/** The smallest invoice-backed loan: 1000 cents for 7 days against a 1500-cent invoice. */
export const SAMPLE_INVOICE_BACKED_CHECK_ARGS = invoiceBackedCheckArgs(
  SAMPLE_CHECK_ELIGIBILITY_ARGS.amount_cents,
  SAMPLE_CHECK_ELIGIBILITY_ARGS.term_days,
);

/**
 * M1 (final review): a `check_eligibility` for half the requested amount
 * (floor, minimum 1000 cents — the smallest the bank prices), for a
 * treasury-gate decline where a smaller request could clear the same gate
 * (reserve_floor, concentration_limit, daily_budget_exhausted,
 * pool_utilization_high all shrink or vanish with a smaller principal).
 */
export function halvedCheckArgs(amountCents: number, termDays: number) {
  return { amount_cents: Math.max(1000, Math.floor(amountCents / 2)), term_days: termDays };
}

/** Placeholders for an invoice in an `apply_for_loan` next action (the agent replaces them with its real client and work). */
export const SAMPLE_INVOICE_PLACEHOLDERS = {
  client_email: "your-client@example.com",
  description: "<describe the work this invoice is for>",
} as const;
