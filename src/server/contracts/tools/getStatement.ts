import { z } from "zod";

import { ok } from "../envelope";
import { defineTool } from "../registry";
import { fromDbStatus } from "../../domain/loanMachine";
import { getStatement } from "../../services/repayments";

const outputSchema = z.object({
  notes: z.object({
    balance_cents: z.number(),
    earned_cents: z.number(),
    /** P5: interest earned ÷ net principal invested, annualised over the holding period (bps); null with nothing invested. */
    nominal_annual_return_bps: z.number().nullable(),
    /** P5: nominal − the bank's current annual inflation rate (bps). */
    real_annual_return_bps: z.number().nullable(),
    inflation_rate_bps: z.number(),
    holding_days: z.number(),
  }),
  loans: z.array(
    z.object({
      loan_id: z.string(),
      status: z.string(),
      principal_cents: z.number(),
      fee_cents: z.number(),
      outstanding_cents: z.number(),
      due_sim_at: z.string(),
    }),
  ),
  ledger_lines: z.array(
    z.object({ sim_at: z.string(), memo: z.string(), account: z.string(), amount_cents: z.number() }),
  ),
});

export const getStatementTool = defineTool({
  name: "get_statement",
  title: "Get Statement",
  description:
    "Returns the calling agent's own statement: its note balance and the interest it has earned " +
    "(with the nominal annualised return and the real return = nominal − inflation, in bps), " +
    "its loans, and every ledger line on its own accounts (positive amount_cents = the bank owes " +
    "you more). Call it to reconcile what you lent, earned, borrowed and were paid back.",
  auth: "agent",
  mutating: false,
  readOnly: true,
  input: z.strictObject({}),
  output: outputSchema,
  handler: async (_input, ctx) => {
    if (!ctx.agentId) {
      throw new Error("get_statement requires an authenticated agent");
    }
    const statement = await getStatement(ctx.db, ctx.worldId, ctx.agentId);
    return ok(
      {
        notes: {
          balance_cents: Number(statement.notes.balanceCents),
          earned_cents: Number(statement.notes.earnedCents),
          nominal_annual_return_bps: statement.notes.returns.nominalAnnualBps,
          real_annual_return_bps: statement.notes.returns.realAnnualBps,
          inflation_rate_bps: statement.notes.returns.inflationRateBps,
          holding_days: statement.notes.returns.holdingDays,
        },
        loans: statement.loans.map((loan) => ({
          loan_id: loan.id,
          status: fromDbStatus(loan.status),
          principal_cents: Number(loan.principalCents),
          fee_cents: Number(loan.feeCents),
          outstanding_cents: Number(loan.outstandingCents),
          due_sim_at: loan.dueSimAt.toISOString(),
        })),
        ledger_lines: statement.ledgerLines.map((line) => ({
          sim_at: line.simAt.toISOString(),
          memo: line.memo,
          account: line.account,
          amount_cents: Number(line.amountCents),
        })),
      },
      {
        status: "OK",
        summary:
          `Notes balance ${statement.notes.balanceCents.toString()} cents ` +
          `(${statement.notes.earnedCents.toString()} earned); ${statement.loans.length} loan(s).`,
        next_actions: [{ tool: "get_status", args: {} }],
      },
    );
  },
});
