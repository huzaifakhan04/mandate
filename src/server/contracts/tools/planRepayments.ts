import { z } from "zod";

import { fail, ok } from "../envelope";
import { defineTool } from "../registry";
import { MAX_AGENT_MOVES, MAX_INSTALLMENTS } from "../../domain/installments";
import { planRepayments, repaymentPlanView } from "../../services/installments";
import { repaymentPlanSchema } from "../repaymentPlan";

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a YYYY-MM-DD sim date");

const inputSchema = z.strictObject({
  loan_id: z.uuid().optional(),
  installments: z
    .array(z.strictObject({ date: DATE, amount_cents: z.number().int().min(1) }))
    .min(1)
    .max(MAX_INSTALLMENTS),
  auto_reschedule: z.boolean().optional(),
});

const outputSchema = z.object({ loan_id: z.string(), repayment_plan: repaymentPlanSchema });

/**
 * P7: the agent drives its own repayment schedule. It proposes up to 4
 * dated installments for its open loan; the bank's tick then watches the
 * loan's payments and re-plans (paid early / partial / missed / failed).
 */
export const planRepaymentsTool = defineTool({
  name: "plan_repayments",
  title: "Plan Repayments",
  description:
    `Proposes your own repayment schedule for your ACTIVE loan: 1 to ${MAX_INSTALLMENTS} installments, each ` +
    "{date: YYYY-MM-DD sim date, amount_cents}. Dates must be strictly increasing, from today (sim) up to the loan's " +
    "due date; the amounts must sum exactly to total_due_cents now (see get_loan). loan_id defaults to your open loan. " +
    "Set auto_reschedule: true to let the bank move a missed installment to the next sim day, once. " +
    "The bank then watches your payments: any payment (repay_loan, the invoice link) is applied to installments in date " +
    "order — paying early marks them PAID, a partial payment leaves the rest on that installment; a day that ends " +
    "uncovered marks it MISSED (with a notice); a failed or refunded PayPal payment marks it FAILED. " +
    `Move one with reschedule_installment (up to ${MAX_AGENT_MOVES} times each). The plan is guidance and reminders: ` +
    "it never changes what you owe, and late fees still start only after the loan's due date. One plan per loan; " +
    "calling again with the same plan returns it unchanged.",
  auth: "agent",
  mutating: true,
  readOnly: false,
  input: inputSchema,
  output: outputSchema,
  handler: async (input, ctx) => {
    if (!ctx.agentId) {
      throw new Error("plan_repayments requires an authenticated agent");
    }
    const result = await planRepayments(ctx.tx, ctx.worldId, ctx.agentId, ctx.simNow, {
      loanId: input.loan_id ?? null,
      installments: input.installments.map((i) => ({ date: i.date, amountCents: BigInt(i.amount_cents) })),
      autoReschedule: input.auto_reschedule ?? false,
    });
    switch (result.outcome) {
      case "not_found":
        return fail("NOT_FOUND", input.loan_id ? "No such loan." : "You have no open loan to plan.", ["loan_not_found"]);
      case "invalid_transition":
        return fail("INVALID_TRANSITION", `This loan is ${result.state}; only an ACTIVE loan can be planned.`, ["invalid_transition"], {
          loan_status: result.state,
        });
      case "invalid_plan":
        return fail("INVALID_PLAN", result.message, [result.code]);
      case "plan_exists":
        return {
          ...fail("PLAN_EXISTS", "This loan already has a different repayment plan. Move installments with reschedule_installment.", [
            "plan_exists",
          ]),
          next_actions: [{ tool: "get_loan", args: { loan_id: result.loanId } }],
        };
      case "planned":
        break;
    }
    const plan = (await repaymentPlanView(ctx.tx, ctx.worldId, result.loanId))!;
    return ok(
      { loan_id: result.loanId, repayment_plan: plan },
      {
        status: "PLANNED",
        summary: result.replay
          ? "This plan is already in place."
          : `Plan set: ${plan.installments.length} installment(s), next ${plan.next_due?.amount_left_cents ?? 0} cents on ${plan.next_due?.due_on ?? "—"}.` +
            " Repay with repay_loan; the bank re-plans as payments land.",
        next_actions: [
          { tool: "repay_loan", args: { loan_id: result.loanId, amount_cents: plan.next_due?.amount_left_cents } },
          { tool: "get_loan", args: { loan_id: result.loanId } },
        ],
      },
    );
  },
});
