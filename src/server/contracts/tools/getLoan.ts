import { z } from "zod";

import { fail, ok, type NextAction } from "../envelope";
import { defineTool } from "../registry";
import { disbursementFailureReasonCodes, getLoanView } from "../../services/loans";

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
  repayment_link: z.object({ url: z.string(), amount_cents: z.number(), status: z.string() }).optional(),
  history: z.array(z.object({ type: z.string(), occurred_sim_at: z.string(), payload: z.unknown() })),
});

export const getLoanTool = defineTool({
  name: "get_loan",
  title: "Get Loan",
  description:
    "Returns one of the calling agent's loans: its status (DISBURSING, ACTIVE, DISBURSEMENT_FAILED, " +
    "REPAID), principal, fee, outstanding balance, due date and full event history. Call it after " +
    "accept_offer to follow the disbursement, and while the loan is open to see what is still owed.",
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
    let nextActions: NextAction[] = [];
    if (state === "DISBURSING") {
      nextActions = [{ tool: "get_loan", args: { loan_id: loan.id } }];
    } else if (state === "DISBURSEMENT_FAILED" || state === "REPAID") {
      nextActions = [{ tool: "get_status", args: {} }];
    }

    return ok(
      {
        loan_id: loan.id,
        status: state,
        principal_cents: Number(loan.principalCents),
        fee_cents: Number(loan.feeCents),
        outstanding_cents: Number(loan.outstandingCents),
        due_sim_at: loan.dueSimAt.toISOString(),
        history: view.history.map((event) => ({
          type: event.type,
          occurred_sim_at: event.occurredSimAt.toISOString(),
          payload: event.payload,
        })),
      },
      {
        status: "OK",
        summary: `Loan is ${state}; ${loan.outstandingCents.toString()} cents outstanding.`,
        reason_codes: state === "DISBURSEMENT_FAILED" ? disbursementFailureReasonCodes(view.disbursementFailureReason) : [],
        next_actions: nextActions,
      },
    );
  },
});
