import { z } from "zod";

import { fail, ok } from "../envelope";
import { defineTool } from "../registry";
import { beginDirectRepayment, refreshDirectRepayment } from "../../services/repayments";

const inputSchema = z.object({
  loan_id: z.uuid(),
  amount_cents: z.number().int().min(1).optional(),
});

const outputSchema = z.object({
  checkout_id: z.string(),
  approve_url: z.string().optional(),
  loan_id: z.string(),
  amount_cents: z.number(),
});

/** Bookkeeping passed from `handler` to `finalize` (never the envelope). */
interface RepayLoanFinalizeState {
  linkId: string;
  loanId: string;
  amountCents: string;
}

export const repayLoanTool = defineTool({
  name: "repay_loan",
  title: "Repay Loan",
  description:
    "Repays the calling agent's ACTIVE loan directly through a PayPal checkout the agent's human " +
    "approves. amount_cents defaults to everything outstanding and may not exceed it; the fee is " +
    "paid first, then principal. Present the approve_url to the payer, then call confirm_checkout.",
  auth: "agent",
  mutating: true,
  readOnly: false,
  input: inputSchema,
  output: outputSchema,
  handler: async (input, ctx) => {
    if (!ctx.agentId) {
      throw new Error("repay_loan requires an authenticated agent");
    }

    const result = await beginDirectRepayment(
      ctx.tx,
      ctx.worldId,
      ctx.agentId,
      input.loan_id,
      input.amount_cents === undefined ? null : BigInt(input.amount_cents),
    );

    switch (result.outcome) {
      case "not_found":
        return fail("NOT_FOUND", "No such loan.", ["loan_not_found"]);
      case "invalid_transition":
        return fail("INVALID_TRANSITION", `This loan is ${result.state}, not ACTIVE; nothing to repay.`, [
          "invalid_transition",
        ], { loan_status: result.state });
      case "amount_exceeds_outstanding":
        return fail(
          "AMOUNT_EXCEEDS_OUTSTANDING",
          `amount_cents exceeds the ${result.outstandingCents.toString()} cents outstanding on this loan.`,
          ["amount_exceeds_outstanding"],
          { outstanding_cents: Number(result.outstandingCents) },
        );
      case "submitted":
        break;
    }

    ctx.setFinalizeState({
      linkId: result.linkId,
      loanId: result.loanId,
      amountCents: result.amountCents.toString(),
    } satisfies RepayLoanFinalizeState);

    // A clean, replayable fallback: confirm_checkout accepts this id until
    // the PayPal order exists (and re-executes a stalled create).
    return ok(
      { checkout_id: result.linkId, loan_id: result.loanId, amount_cents: Number(result.amountCents) },
      {
        status: "PENDING",
        summary: "Creating the repayment checkout.",
        next_actions: [{ tool: "confirm_checkout", args: { checkout_id: result.linkId } }],
      },
    );
  },
  finalize: async (envelope, ctx, state) => {
    const pending = state as RepayLoanFinalizeState | undefined;
    if (!pending) {
      return envelope;
    }
    const link = await refreshDirectRepayment(ctx.db, ctx.worldId, pending.linkId);
    const amountCents = Number(BigInt(pending.amountCents));
    if (!link?.approveUrl || !link.paypalOrderId) {
      return envelope;
    }
    return ok(
      { checkout_id: link.paypalOrderId, approve_url: link.approveUrl, loan_id: pending.loanId, amount_cents: amountCents },
      {
        status: "AWAITING_APPROVAL",
        summary: `Repayment checkout for ${amountCents} cents created. Have the payer approve it, then confirm.`,
        next_actions: [
          {
            tool: "human_approval",
            args: {
              url: link.approveUrl,
              who: "payer",
              then: { tool: "confirm_checkout", args: { checkout_id: link.paypalOrderId } },
            },
          },
        ],
      },
    );
  },
});
