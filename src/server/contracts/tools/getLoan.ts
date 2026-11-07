import { z } from "zod";

import { fail, ok, type NextAction } from "../envelope";
import { defineTool } from "../registry";
import { disbursementFailureReasonCodes, getLoanView } from "../../services/loans";
import { getRepaymentLinkView } from "../../services/repayments";
import { refreshGuaranteeLink } from "../../services/paymentLinks";
import { daysLate } from "../../domain/delinquency";
import { noticeView, totalDueCents, unreadNotices } from "../../services/collections";
import { noticeSchema } from "../notices";
import { repaymentPlanView } from "../../services/installments";
import { repaymentPlanSchema } from "../repaymentPlan";

const inputSchema = z.object({
  loan_id: z.uuid(),
});

const outputSchema = z.object({
  loan_id: z.string(),
  status: z.string(),
  principal_cents: z.number(),
  fee_cents: z.number(),
  outstanding_cents: z.number(),
  due_sim_at: z.string(),
  /** P4 delinquency: whole sim days past due, late fees and penalty still owed, and everything owed. */
  days_late: z.number(),
  late_fee_cents: z.number(),
  penalty_cents: z.number(),
  total_due_cents: z.number(),
  /** P4: unread notices about this loan (acknowledge with ack_notices). */
  notices: z.array(noticeSchema),
  repayment_link: z.object({ url: z.string().nullable(), amount_cents: z.number(), status: z.string() }).optional(),
  /** P4 Task 2: present once the loan is charged off — what was written off, recovered, and the owner's guarantee link. */
  charge_off: z
    .object({
      charged_off_sim_at: z.string(),
      written_off_cents: z.number(),
      recovered_cents: z.number(),
      guarantee_link: z.object({ url: z.string().nullable(), amount_cents: z.number(), status: z.string() }).nullable(),
    })
    .optional(),
  /** P7: the agent's own repayment plan (plan_repayments), re-planned by the bank as payments land; null if none. */
  repayment_plan: repaymentPlanSchema.nullable(),
  history: z.array(z.object({ type: z.string(), occurred_sim_at: z.string(), payload: z.unknown() })),
});

export const getLoanTool = defineTool({
  name: "get_loan",
  title: "Get Loan",
  description:
    "Returns one of the calling agent's loans: its status (DISBURSING, ACTIVE, LATE, SUBSTANDARD, " +
    "CHARGED_OFF, RECOVERED, DISBURSEMENT_FAILED, REPAID), principal, fee, outstanding balance, due date, delinquency (days " +
    "late, late fees, rate penalty, total due) and unread notices about it, the invoice repayment link to forward " +
    "to the client (if the loan has an invoice), your repayment plan (plan_repayments) and full event history. Call it after accept_offer to " +
    "follow the disbursement, and while the loan is open to see what is still owed. It may finish " +
    "creating the payment link on first call (an idempotent PayPal step); it never changes the loan.",
  auth: "agent",
  mutating: false,
  readOnly: true,
  input: inputSchema,
  output: outputSchema,
  handler: async (input, ctx) => {
    if (!ctx.agentId) {
      throw new Error("get_loan requires an authenticated agent");
    }

    const view = await getLoanView(ctx.db, ctx.worldId, ctx.agentId, input.loan_id);
    if (!view) {
      return fail("NOT_FOUND", "No such loan.", ["loan_not_found"]);
    }

    const { loan, state } = view;
    // Task 7: the invoice link (executing a still-queued create lazily).
    const link = await getRepaymentLinkView(ctx.db, ctx.worldId, loan.id);
    const notices = await unreadNotices(ctx.db, ctx.worldId, ctx.agentId, loan.id);
    const totalDue = totalDueCents(loan);
    const owing = state === "ACTIVE" || state === "LATE" || state === "SUBSTANDARD";
    let nextActions: NextAction[] = [];
    if (state === "DISBURSING") {
      nextActions = [{ tool: "get_loan", args: { loan_id: loan.id } }];
    } else if (state === "CHARGED_OFF") {
      // P4 Task 2: any payment now is a recovery (up to what was written off).
      nextActions = [{ tool: "repay_loan", args: { loan_id: loan.id } }];
    } else if (state === "DISBURSEMENT_FAILED" || state === "REPAID" || state === "RECOVERED") {
      nextActions = [{ tool: "get_status", args: {} }];
    } else if (state === "ACTIVE" || state === "LATE" || state === "SUBSTANDARD") {
      nextActions = [
        ...(link?.url && link.orderId && link.status === "open"
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
          : []),
        { tool: "repay_loan", args: { loan_id: loan.id } },
      ];
    }

    return ok(
      {
        loan_id: loan.id,
        status: state,
        principal_cents: Number(loan.principalCents),
        fee_cents: Number(loan.feeCents),
        outstanding_cents: Number(loan.outstandingCents),
        due_sim_at: loan.dueSimAt.toISOString(),
        days_late: owing ? daysLate(loan.dueSimAt, ctx.simNow) : 0,
        late_fee_cents: Number(loan.lateFeeOutstandingCents),
        penalty_cents: Number(loan.penaltyOutstandingCents),
        total_due_cents: Number(totalDue),
        notices: notices.map(noticeView),
        ...(loan.chargedOffAt
          ? {
              charge_off: await chargeOffView(ctx.db, ctx.worldId, loan),
            }
          : {}),
        ...(link
          ? {
              repayment_link: {
                url: link.url,
                amount_cents: Number(link.amountCents),
                status: link.status.toUpperCase(),
              },
            }
          : {}),
        repayment_plan: await repaymentPlanView(ctx.db, ctx.worldId, loan.id),
        history: view.history.map((event) => ({
          type: event.type,
          occurred_sim_at: event.occurredSimAt.toISOString(),
          payload: event.payload,
        })),
      },
      {
        status: "OK",
        summary:
          state === "DISBURSING"
            ? // Task 11: agents polled this in a tight loop and read "0 cents
              // outstanding" as odd. Say what is happening and how long it takes.
              "Loan is DISBURSING: the principal payout to your PayPal account is settling, which " +
              "usually takes a minute or two. Nothing is owed until it lands. Check back with " +
              "get_loan in a minute (don't poll in a tight loop). The invoice repayment_link appears once the loan is ACTIVE."
            : state === "LATE" || state === "SUBSTANDARD"
              ? `Loan is ${state}, ${daysLate(loan.dueSimAt, ctx.simNow)} days past due; ${totalDue.toString()} cents owed ` +
                `(${loan.outstandingCents.toString()} principal + fee, ${loan.lateFeeOutstandingCents.toString()} late fees, ` +
                `${loan.penaltyOutstandingCents.toString()} rate penalty). Repay with repay_loan; late fees and the penalty are paid first.`
              : state === "CHARGED_OFF"
                ? `Loan is CHARGED_OFF: ${loan.chargeOffTotalCents.toString()} cents were written off and ` +
                  `${totalDue.toString()} cents are still owed. Your owner's guarantee has been invoked; any payment ` +
                  "(the guarantee link, the invoice link or repay_loan) is a recovery."
                : `Loan is ${state}; ${loan.outstandingCents.toString()} cents outstanding.`,
        reason_codes: state === "DISBURSEMENT_FAILED" ? disbursementFailureReasonCodes(view.disbursementFailureReason) : [],
        next_actions: nextActions,
      },
    );
  },
});

async function chargeOffView(
  db: Parameters<typeof refreshGuaranteeLink>[0],
  worldId: string,
  loan: { id: string; chargedOffAt: Date | null; chargeOffTotalCents: bigint; recoveredCents: bigint },
) {
  const link = await refreshGuaranteeLink(db, worldId, loan.id);
  return {
    charged_off_sim_at: loan.chargedOffAt!.toISOString(),
    written_off_cents: Number(loan.chargeOffTotalCents),
    recovered_cents: Number(loan.recoveredCents),
    guarantee_link: link
      ? { url: link.approveUrl, amount_cents: Number(link.amountCents), status: link.status.toUpperCase() }
      : null,
  };
}
