import { z } from "zod";

/** P7: a repayment plan as get_loan / get_status / plan_repayments show it (`planView` in services/installments.ts). */
export const installmentViewSchema = z.object({
  installment: z.number(),
  due_on: z.string(),
  original_due_on: z.string(),
  amount_cents: z.number(),
  paid_cents: z.number(),
  status: z.string(),
  moves: z.number(),
  moves_left: z.number(),
  auto_moved: z.boolean(),
  paid_sim_at: z.string().nullable(),
  missed_sim_at: z.string().nullable(),
  failed_sim_at: z.string().nullable(),
});

export const repaymentPlanSchema = z.object({
  auto_reschedule: z.boolean(),
  planned_total_cents: z.number(),
  paid_cents: z.number(),
  installments: z.array(installmentViewSchema),
  next_due: z.object({ installment: z.number(), due_on: z.string(), amount_left_cents: z.number() }).nullable(),
});
