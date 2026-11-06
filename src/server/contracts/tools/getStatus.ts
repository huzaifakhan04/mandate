import { z } from "zod";

import { ok, type NextAction } from "../envelope";
import { blockerInstruction, blockerNextActions } from "../kyaActions";
import { defineTool } from "../registry";
import { SAMPLE_BUY_NOTES_ARGS, SAMPLE_CHECK_ELIGIBILITY_ARGS } from "../sampleArgs";
import { getAgentStatus } from "../../services/agents";
import { scoreAgent } from "../../services/credit";
import { creditSchema, creditView } from "../credit";
import { noticeSchema } from "../notices";
import { daysLate } from "../../domain/delinquency";
import { isOwingStatus } from "../../domain/loanMachine";
import { noticeView, unreadNotices } from "../../services/collections";

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
      /** P4: whole sim days past due (0 if not yet due). */
      days_late: z.number(),
      late_fee_cents: z.number(),
      penalty_cents: z.number(),
      /** Everything owed: outstanding principal + fee, late fees and penalty (CHARGED_OFF: what is still recoverable). */
      total_due_cents: z.number(),
      /** P4: for a CHARGED_OFF loan, your owner's guarantee link (null otherwise). */
      guarantee_link: z.object({ url: z.string().nullable(), amount_cents: z.number(), status: z.string() }).nullable(),
    })
    .nullable(),
  /** P4: notices you haven't acknowledged (late, penalty, substandard, cured…); clear them with ack_notices. */
  notices: z.array(noticeSchema),
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
    "unread notices (late fees, penalty, substandard — acknowledge with ack_notices), " +
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
    const notices = await unreadNotices(ctx.db, ctx.worldId, ctx.agentId);

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
            // M2: only a funded loan that still owes can be late (same gating as get_loan).
            days_late: isOwingStatus(status.openLoan.status) ? daysLate(status.openLoan.dueSimAt, ctx.simNow) : 0,
            late_fee_cents: Number(status.openLoan.lateFeeOutstandingCents),
            penalty_cents: Number(status.openLoan.penaltyOutstandingCents),
            total_due_cents: Number(status.openLoan.totalDueCents),
            guarantee_link: status.openLoan.guaranteeLink
              ? {
                  url: status.openLoan.guaranteeLink.url,
                  amount_cents: Number(status.openLoan.guaranteeLink.amountCents),
                  status: status.openLoan.guaranteeLink.status.toUpperCase(),
                }
              : null,
          }
        : null,
      notices: notices.map(noticeView),
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

    let nextActions: NextAction[];
    const delinquent =
      status.openLoan &&
      (status.openLoan.status === "late" || status.openLoan.status === "substandard" || status.openLoan.status === "charged_off");
    if (status.openLoan && delinquent) {
      // P4: past due — repaying comes first (a restricted agent may still repay).
      nextActions = [
        { tool: "repay_loan", args: { loan_id: status.openLoan.loanId } },
        { tool: "get_loan", args: { loan_id: status.openLoan.loanId } },
      ];
    } else if (status.openLoan) {
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
        { tool: "check_eligibility", args: { ...SAMPLE_CHECK_ELIGIBILITY_ARGS } },
      ];
    } else {
      // Has notes but no open loan: nothing mandates buying more.
      nextActions = [{ tool: "check_eligibility", args: { ...SAMPLE_CHECK_ELIGIBILITY_ARGS } }];
    }

    const tierText = blockers.length > 0
      ? `tier ${data.kya.tier} (can lend, cannot borrow yet). ${blockerInstruction(blockers, claimUrl)}`
      : `tier ${data.kya.tier} (can lend and borrow).`;
    if (notices.length > 0) {
      nextActions.push({ tool: "ack_notices", args: {} });
    }
    const loanText =
      data.open_loan && delinquent
        ? ` Your loan is ${data.open_loan.status}, ${data.open_loan.days_late} days past due: ` +
          `${data.open_loan.total_due_cents} cents owed (incl. ${data.open_loan.late_fee_cents} late fees, ` +
          `${data.open_loan.penalty_cents} penalty). Repay it with repay_loan.`
        : "";
    const noticeText = notices.length > 0 ? ` ${notices.length} unread notice(s).` : "";
    return ok(data, {
      status: "OK",
      summary:
        `Agent ${status.agent.name} is ${data.agent.status} at ${tierText} ` +
        `Agent Credit Score ${credit.score} (grade ${credit.grade}).` +
        loanText +
        noticeText,
      next_actions: nextActions,
    });
  },
});
