import { z } from "zod";

import { fail, ok } from "../envelope";
import { defineTool } from "../registry";
import { MAX_AGENT_MOVES, MAX_INSTALLMENTS } from "../../domain/installments";
import { repaymentPlanView, rescheduleInstallment } from "../../services/installments";
import { repaymentPlanSchema } from "../repaymentPlan";

const inputSchema = z.strictObject({
  loan_id: z.uuid().optional(),
  installment: z.number().int().min(1).max(MAX_INSTALLMENTS),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a YYYY-MM-DD sim date"),
});

const outputSchema = z.object({
  loan_id: z.string(),
  installment: z.number(),
  from: z.string(),
  to: z.string(),
  moves_left: z.number(),
  repayment_plan: repaymentPlanSchema,
});

export const rescheduleInstallmentTool = defineTool({
  name: "reschedule_installment",
  title: "Reschedule Installment",
  description:
    "Moves one unpaid installment of your repayment plan (from plan_repayments) to a new sim date. Rules: the new " +
    `date is at least 1 sim day ahead (tomorrow or later) and never after the loan's due date; each installment can be ` +
    `moved at most ${MAX_AGENT_MOVES} times (a bank auto-reschedule doesn't count). A MISSED or FAILED installment ` +
    "moved this way is PLANNED again. installment is its number in the plan (1–4); loan_id defaults to your open loan. " +
    "It changes nothing about what you owe or the loan's due date.",
  auth: "agent",
  mutating: true,
  readOnly: false,
  input: inputSchema,
  output: outputSchema,
  handler: async (input, ctx) => {
    if (!ctx.agentId) {
      throw new Error("reschedule_installment requires an authenticated agent");
    }
    const result = await rescheduleInstallment(ctx.tx, ctx.worldId, ctx.agentId, ctx.simNow, {
      loanId: input.loan_id ?? null,
      installment: input.installment,
      date: input.date,
    });
    switch (result.outcome) {
      case "not_found":
        return fail("NOT_FOUND", "No such loan or installment.", ["installment_not_found"]);
      case "no_plan":
        return fail("NOT_FOUND", "This loan has no repayment plan yet; propose one with plan_repayments.", ["no_plan"]);
      case "invalid_transition":
        return fail("INVALID_TRANSITION", `This loan is ${result.state}; its plan can't be changed.`, ["invalid_transition"], {
          loan_status: result.state,
        });
      case "invalid_move":
        return fail("INVALID_PLAN", result.message, [result.code]);
      case "moved":
        break;
    }
    const plan = (await repaymentPlanView(ctx.tx, ctx.worldId, result.loanId))!;
    return ok(
      {
        loan_id: result.loanId,
        installment: input.installment,
        from: result.from,
        to: result.to,
        moves_left: result.movesLeft,
        repayment_plan: plan,
      },
      {
        status: "RESCHEDULED",
        summary: `Installment ${input.installment} moved from ${result.from} to ${result.to}; ${result.movesLeft} move(s) left for it.`,
        next_actions: [{ tool: "get_loan", args: { loan_id: result.loanId } }],
      },
    );
  },
});
