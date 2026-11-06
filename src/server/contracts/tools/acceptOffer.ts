import { z } from "zod";

import { fail, ok, type Envelope } from "../envelope";
import { defineTool, type FinalizeCtx } from "../registry";
import {
  applyPayoutOutcome,
  beginAcceptOffer,
  disbursementFailureReasonCodes,
  getLoanView,
} from "../../services/loans";
import { refreshRepaymentLink } from "../../services/repayments";

const inputSchema = z.object({
  offer_id: z.uuid(),
  disclosure_hash: z.string().min(1),
});

const outputSchema = z.object({
  loan_id: z.string(),
  status: z.string(),
  disbursement: z.object({ status: z.string() }),
  repayment_link: z.object({ url: z.string(), amount_cents: z.number() }).optional(),
});

/** Bookkeeping passed from `handler` to `finalize` via `ctx.setFinalizeState` (never the envelope). */
interface AcceptOfferFinalizeState {
  loanId: string;
  payoutOperationId: string;
}

function disbursingEnvelope(loanId: string): Envelope<unknown> {
  return ok(
    { loan_id: loanId, status: "DISBURSING", disbursement: { status: "PENDING" } },
    {
      status: "DISBURSING",
      summary:
        "Offer accepted; the disbursement payout is in progress and usually settles within a minute or two. " +
        "Check back with get_loan then; the invoice repayment_link appears once the loan is ACTIVE.",
      next_actions: [{ tool: "get_loan", args: { loan_id: loanId } }],
    },
  );
}

/** The envelope for the loan's current state, read back after the payout attempt. */
async function loanStateEnvelope(
  ctx: FinalizeCtx,
  loanId: string,
  link: { url: string; orderId: string; amountCents: bigint } | null,
): Promise<Envelope<unknown>> {
  if (!ctx.agentId) {
    return disbursingEnvelope(loanId);
  }
  const view = await getLoanView(ctx.db, ctx.worldId, ctx.agentId, loanId);
  if (!view || view.state === "DISBURSING") {
    return disbursingEnvelope(loanId);
  }

  if (view.state === "DISBURSEMENT_FAILED") {
    const reasonCodes = disbursementFailureReasonCodes(view.disbursementFailureReason);
    const why = view.disbursementFailureReason ?? "a failure";
    return ok(
      { loan_id: loanId, status: "DISBURSEMENT_FAILED", disbursement: { status: "FAILED" } },
      {
        status: "DISBURSEMENT_FAILED",
        summary:
          `The disbursement payout to your payout receiver came back ${why}; no money was lent and ` +
          "nothing is owed. Make sure the payout receiver is a working PayPal account, then apply again.",
        reason_codes: reasonCodes,
        next_actions: [{ tool: "get_status", args: {} }],
      },
    );
  }

  // Task 7: an invoice loan's payment link goes to the client — the
  // human-approval action comes first (Global Constraints).
  const forwardLink =
    link && view.state === "ACTIVE"
      ? [
          {
            tool: "human_approval",
            args: {
              url: link.url,
              who: "client",
              then: { tool: "confirm_checkout", args: { checkout_id: link.orderId } },
            },
          },
        ]
      : [];
  return ok(
    {
      loan_id: loanId,
      status: view.state,
      disbursement: { status: "SUCCEEDED" },
      ...(link ? { repayment_link: { url: link.url, amount_cents: Number(link.amountCents) } } : {}),
    },
    {
      status: view.state,
      summary:
        `Loan ${view.state}: ${view.loan.principalCents.toString()} cents sent to your payout receiver; ` +
        `${view.loan.outstandingCents.toString()} cents due ${view.loan.dueSimAt.toISOString()}.` +
        (link ? ` Forward the repayment link to your client; their payment repays the loan.` : ""),
      next_actions: [...forwardLink, { tool: "get_loan", args: { loan_id: loanId } }],
    },
  );
}

export const acceptOfferTool = defineTool({
  name: "accept_offer",
  title: "Accept Offer",
  description:
    "Accepts a loan offer from apply_for_loan. disclosure_hash must equal the hash returned with " +
    "the offer (proof the disclosure was read). The bank re-checks liquidity, creates the loan and " +
    "pays the principal to the agent's PayPal payout receiver: the result is ACTIVE, DISBURSING " +
    "(poll get_loan) or DISBURSEMENT_FAILED (with the reason).",
  auth: "agent",
  mutating: true,
  readOnly: false,
  input: inputSchema,
  output: outputSchema,
  handler: async (input, ctx) => {
    if (!ctx.agentId) {
      throw new Error("accept_offer requires an authenticated agent");
    }

    const result = await beginAcceptOffer(ctx.tx, ctx.worldId, ctx.agentId, input.offer_id, input.disclosure_hash);

    switch (result.outcome) {
      case "not_found":
        return fail("NOT_FOUND", "No such offer.", ["offer_not_found"]);
      case "disclosure_mismatch":
        return fail(
          "DISCLOSURE_MISMATCH",
          "disclosure_hash does not match this offer's disclosure; re-read the offer and pass its disclosure_hash.",
          ["disclosure_mismatch"],
        );
      case "offer_expired":
        return fail("OFFER_EXPIRED", "This offer has expired; apply again for a fresh one.", ["offer_expired"]);
      case "invalid_transition":
        return fail(
          "INVALID_TRANSITION",
          `This offer is ${result.state}, not OFFERED.`,
          ["invalid_transition"],
          result.loanId ? { offer_status: result.state, loan_id: result.loanId } : { offer_status: result.state },
        );
      case "open_loan_exists":
        return fail("OPEN_LOAN_EXISTS", "You already have an open loan; repay it first.", ["open_loan_exists"]);
      case "insufficient_liquidity":
        return fail(
          "INSUFFICIENT_LIQUIDITY",
          "The pool doesn't have enough available liquidity for this loan right now.",
          ["insufficient_liquidity"],
          { available_liquidity_cents: Number(result.availableLiquidityCents) },
        );
      case "payout_receiver_missing":
        return fail("PAYOUT_RECEIVER_MISSING", "This agent has no payout receiver on file.", [
          "payout_receiver_missing",
        ]);
      case "disbursing":
        break;
    }

    ctx.setFinalizeState({
      loanId: result.loanId,
      payoutOperationId: result.payoutOperationId,
    } satisfies AcceptOfferFinalizeState);

    // A clean, replayable fallback if `finalize` never completes: the loan
    // exists and stays DISBURSING until the payout settles (cron/webhook).
    return disbursingEnvelope(result.loanId);
  },
  finalize: async (envelope, ctx, state) => {
    const pending = state as AcceptOfferFinalizeState | undefined;
    if (!pending) {
      return envelope;
    }
    await applyPayoutOutcome(ctx.db, pending.payoutOperationId);
    // Task 7: the activation enqueued the invoice link's order.create (if
    // any); execute it now, after commit, so the response carries its URL.
    const link = await refreshRepaymentLink(ctx.db, ctx.worldId, pending.loanId, { ignoreBackoff: true });
    return loanStateEnvelope(
      ctx,
      pending.loanId,
      link?.approveUrl && link.paypalOrderId
        ? { url: link.approveUrl, orderId: link.paypalOrderId, amountCents: link.amountCents }
        : null,
    );
  },
});
