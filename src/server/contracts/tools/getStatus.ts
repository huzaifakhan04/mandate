import { z } from "zod";

import { ok, type NextAction } from "../envelope";
import { defineTool } from "../registry";
import { SAMPLE_BUY_NOTES_ARGS, SAMPLE_CHECK_ELIGIBILITY_ARGS } from "../sampleArgs";
import { getAgentStatus } from "../../services/agents";

const outputSchema = z.object({
  agent: z.object({
    id: z.string(),
    name: z.string(),
    status: z.string(),
    payout_email_masked: z.string().nullable(),
  }),
  balances: z.object({
    notes_cents: z.number(),
    payable_to_you_cents: z.number(),
  }),
  open_loan: z
    .object({
      loan_id: z.string(),
      status: z.string(),
      outstanding_cents: z.number(),
      due_sim_at: z.string(),
    })
    .nullable(),
  limits: z.object({
    max_principal_cents: z.number(),
    available_liquidity_cents: z.number(),
  }),
  sim_now: z.string(),
});

export const getStatusTool = defineTool({
  name: "get_status",
  title: "Get Status",
  description:
    "Returns the calling agent's own account snapshot: status, note and " +
    "payable balances, any open loan, lending limits, and the current " +
    "simulated time. Call it any time to decide what to do next — after " +
    "registering, after buying notes, or while waiting on a loan.",
  auth: "agent",
  mutating: false,
  readOnly: true,
  input: z.strictObject({}),
  output: outputSchema,
  handler: async (_input, ctx) => {
    if (!ctx.agentId) {
      throw new Error("get_status requires an authenticated agent");
    }

    const status = await getAgentStatus(ctx.db, ctx.worldId, ctx.agentId);

    const data = {
      agent: {
        id: status.agent.id,
        name: status.agent.name,
        // Ruling E: DB stores lowercase; the API presents uppercase.
        status: status.agent.status.toUpperCase(),
        payout_email_masked: status.agent.payoutEmailMasked,
      },
      balances: {
        notes_cents: Number(status.balances.notesCents),
        payable_to_you_cents: Number(status.balances.payableToYouCents),
      },
      open_loan: status.openLoan
        ? {
            loan_id: status.openLoan.loanId,
            status: status.openLoan.status.toUpperCase(),
            outstanding_cents: Number(status.openLoan.outstandingCents),
            due_sim_at: status.openLoan.dueSimAt.toISOString(),
          }
        : null,
      limits: {
        max_principal_cents: status.limits.maxPrincipalCents,
        available_liquidity_cents: Number(status.limits.availableLiquidityCents),
      },
      sim_now: ctx.simNow.toISOString(),
    };

    let nextActions: NextAction[];
    if (status.openLoan) {
      nextActions = [{ tool: "get_loan", args: { loan_id: status.openLoan.loanId } }];
    } else if (status.balances.notesCents === 0n) {
      nextActions = [
        { tool: "buy_notes", args: { ...SAMPLE_BUY_NOTES_ARGS } },
        { tool: "check_eligibility", args: { ...SAMPLE_CHECK_ELIGIBILITY_ARGS } },
      ];
    } else {
      // Has notes but no open loan: nothing mandates buying more.
      nextActions = [{ tool: "check_eligibility", args: { ...SAMPLE_CHECK_ELIGIBILITY_ARGS } }];
    }

    return ok(data, {
      status: "OK",
      summary: `Agent ${status.agent.name} is ${data.agent.status}.`,
      next_actions: nextActions,
    });
  },
});
