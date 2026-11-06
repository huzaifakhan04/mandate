import { z } from "zod";

import { ok, type NextAction } from "../envelope";
import { blockerInstruction, blockerNextActions } from "../kyaActions";
import { defineTool } from "../registry";
import { SAMPLE_BUY_NOTES_ARGS, SAMPLE_CHECK_ELIGIBILITY_ARGS, SAMPLE_INVOICE_BACKED_CHECK_ARGS } from "../sampleArgs";
import { getAgentStatus } from "../../services/agents";
import { scoreAgent } from "../../services/credit";
import { creditSchema, creditView } from "../credit";

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
  kya: z.object({
    tier: z.number(),
    claimed: z.boolean(),
    claim_url: z.string().nullable(),
    claim_expires_at: z.string().nullable(),
    has_current_mandate: z.boolean(),
    can_borrow: z.boolean(),
    borrow_blockers: z.array(z.string()),
    next_tier_requirements: z.array(z.string()),
    tier_max_per_loan_cents: z.number(),
  }),
  /** Your Agent Credit Score (0–100), grade A–E, grade limit and the top 3 factors (no collateral without an application). */
  credit: creditSchema,
  sim_now: z.string(),
});

export const getStatusTool = defineTool({
  name: "get_status",
  title: "Get Status",
  description:
    "Returns the calling agent's own account snapshot: status, KYA tier (and the claim_url " +
    "to give your human while you are unclaimed), note and payable balances, any open loan, " +
    "lending limits, your Agent Credit Score (0–100, grade A–E, grade limit, top 3 factors), " +
    "and the current simulated time. Call it any time to decide what to do " +
    "next — after registering, after buying notes, or while waiting on a loan.",
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
    const credit = await scoreAgent(ctx.db, ctx.worldId, ctx.agentId, ctx.simNow);

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
      kya: {
        tier: status.kya.tier.tier,
        claimed: status.kya.tier.claimed,
        claim_url: status.kya.claimLink?.url ?? null,
        claim_expires_at: status.kya.claimLink?.expiresAt.toISOString() ?? null,
        has_current_mandate: status.kya.tier.hasCurrentMandate,
        can_borrow: status.kya.tier.borrowBlockers.length === 0,
        borrow_blockers: status.kya.tier.borrowBlockers,
        next_tier_requirements: status.kya.tier.nextTierRequirements,
        tier_max_per_loan_cents: status.kya.tier.maxPerLoanCents,
      },
      credit: creditView(credit),
      sim_now: ctx.simNow.toISOString(),
    };
    const blockers = status.kya.tier.borrowBlockers;
    const claimUrl = status.kya.claimLink?.url ?? null;

    // I2: with no repayment history an unsecured loan is grade E; the sample is the invoice-backed newcomer loan.
    const sampleCheck =
      credit.components.history === 0 ? { ...SAMPLE_INVOICE_BACKED_CHECK_ARGS } : { ...SAMPLE_CHECK_ELIGIBILITY_ARGS };

    let nextActions: NextAction[];
    if (status.openLoan) {
      nextActions = [{ tool: "get_loan", args: { loan_id: status.openLoan.loanId } }];
    } else if (blockers.length > 0) {
      // Can't borrow yet: the human's step comes first; lending is open.
      nextActions = [
        ...blockerNextActions(blockers, claimUrl),
        ...(status.balances.notesCents === 0n ? [{ tool: "buy_notes", args: { ...SAMPLE_BUY_NOTES_ARGS } }] : []),
      ];
    } else if (status.balances.notesCents === 0n) {
      nextActions = [
        { tool: "buy_notes", args: { ...SAMPLE_BUY_NOTES_ARGS } },
        { tool: "check_eligibility", args: sampleCheck },
      ];
    } else {
      // Has notes but no open loan: nothing mandates buying more.
      nextActions = [{ tool: "check_eligibility", args: sampleCheck }];
    }

    const tierText = blockers.length > 0
      ? `tier ${data.kya.tier} (can lend, cannot borrow yet). ${blockerInstruction(blockers, claimUrl)}`
      : `tier ${data.kya.tier} (can lend and borrow).`;
    return ok(data, {
      status: "OK",
      summary:
        `Agent ${status.agent.name} is ${data.agent.status} at ${tierText} ` +
        `Agent Credit Score ${credit.score} (grade ${credit.grade}).`,
      next_actions: nextActions,
    });
  },
});
