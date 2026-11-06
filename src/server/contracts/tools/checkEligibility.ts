import { z } from "zod";

import { ok } from "../envelope";
import { defineTool } from "../registry";
import { checkEligibility } from "../../services/loans";

/** `apply_for_loan` requires a purpose only the agent can supply; the next action carries this placeholder. */
export const PURPOSE_PLACEHOLDER = "<describe what the money is for>";

const inputSchema = z.object({
  amount_cents: z.number().int().min(1),
  term_days: z.number().int().min(1),
});

const outputSchema = z.object({
  eligible: z.boolean(),
  reasons: z.array(z.string()),
  max_principal_cents: z.number(),
  available_liquidity_cents: z.number(),
  quote: z.object({ fee_cents: z.number(), apr_bps: z.number(), total_cents: z.number() }),
});

export const checkEligibilityTool = defineTool({
  name: "check_eligibility",
  title: "Check Eligibility",
  description:
    "Checks, without committing to anything, whether the calling agent could borrow amount_cents " +
    "for term_days right now (P1: 1000–50000 cents, 7–30 days, one open loan, enough pool " +
    "liquidity) and quotes the fee, APR and total repayment. Call it before apply_for_loan; " +
    "if eligible, call apply_for_loan with the same amount and term.",
  auth: "agent",
  mutating: false,
  readOnly: true,
  input: inputSchema,
  output: outputSchema,
  handler: async (input, ctx) => {
    if (!ctx.agentId) {
      throw new Error("check_eligibility requires an authenticated agent");
    }

    const result = await checkEligibility(
      ctx.db,
      ctx.worldId,
      ctx.agentId,
      BigInt(input.amount_cents),
      input.term_days,
    );

    return ok(
      {
        eligible: result.eligible,
        reasons: result.reasons,
        max_principal_cents: Number(result.maxPrincipalCents),
        available_liquidity_cents: Number(result.availableLiquidityCents),
        quote: {
          fee_cents: Number(result.quote.feeCents),
          apr_bps: result.quote.aprBps,
          total_cents: Number(result.quote.totalCents),
        },
      },
      {
        status: "OK",
        summary: result.eligible
          ? `Eligible: fee ${result.quote.feeCents.toString()} cents, total ${result.quote.totalCents.toString()} cents.`
          : `Not eligible right now: ${result.reasons.join(", ")}.`,
        reason_codes: result.reasons,
        next_actions: result.eligible
          ? [
              {
                tool: "apply_for_loan",
                args: {
                  amount_cents: input.amount_cents,
                  term_days: input.term_days,
                  // Placeholder the agent must replace (5–200 chars).
                  purpose: PURPOSE_PLACEHOLDER,
                },
              },
            ]
          : [{ tool: "get_status", args: {} }],
      },
    );
  },
});
