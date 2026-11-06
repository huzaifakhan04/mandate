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
