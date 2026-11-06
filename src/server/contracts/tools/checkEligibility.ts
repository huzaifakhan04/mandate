import { z } from "zod";

import { ok } from "../envelope";
import { blockerInstruction, blockerNextActions } from "../kyaActions";
import { defineTool } from "../registry";
import { borrowGate } from "../../services/kya";
import { creditSchema, creditView } from "../credit";
import { checkEligibility } from "../../services/loans";
import { mandateFeeAdvice } from "../../domain/reasons";
import { type NextAction } from "../envelope";
import { invoiceBackedCheckArgs, SAMPLE_INVOICE_PLACEHOLDERS } from "../sampleArgs";

/** `apply_for_loan` requires a purpose only the agent can supply; the next action carries this placeholder. */
export const PURPOSE_PLACEHOLDER = "<describe what the money is for>";

const inputSchema = z.object({
  amount_cents: z.number().int().min(1),
  term_days: z.number().int().min(1),
  /** Also check the mandate's eligible collateral for this kind (invoice_link = you'll pass an invoice). */
  collateral: z.enum(["invoice_link", "none"]).optional(),
  /** The face amount of the invoice you'd back the loan with; scores collateral (coverage = invoice ÷ amount). */
  invoice_amount_cents: z.number().int().min(1).optional(),
});

const mandateSchema = z.object({
  mandate_id: z.string(),
  version: z.number(),
  max_per_loan_cents: z.number(),
  max_total_owed_cents: z.number(),
  max_fee_bps: z.number(),
  max_term_days: z.number(),
  eligible_collateral: z.array(z.string()),
  expires_at: z.string().nullable(),
  principal_total_owed_cents: z.number(),
  total_owed_headroom_cents: z.number(),
  per_loan_cap_cents: z.number(),
});

const outputSchema = z.object({
  eligible: z.boolean(),
  reasons: z.array(z.string()),
  max_principal_cents: z.number(),
  available_liquidity_cents: z.number(),
  /** min(grade limit, tier cap, mandate max_per_loan) in cents. */
  effective_cap_cents: z.number(),
  /** The risk-based (v2) quote; null for grade E, which is never offered. */
  quote: z
    .object({
      fee_cents: z.number(),
      apr_bps: z.number(),
      total_cents: z.number(),
      grade: z.enum(["A", "B", "C", "D", "E"]),
      score: z.number(),
      rate_components: z.object({
        cost_of_funds_bps: z.number(),
        expected_loss_bps: z.number(),
        ops_bps: z.number(),
        capital_bps: z.number(),
        total_bps: z.number(),
      }),
      apr_flag: z.string().nullable(),
      /** P5: the annual base rate (bps) in the cost of funds — the bank's daily rate. */
      base_rate_bps: z.number(),
      /** P5: the annual utilization premium (bps): 0 up to 50% of the pool lent, up to 600 at 90%. */
      utilization_premium_bps: z.number(),
    })
    .nullable(),
  tier: z.number(),
  /** Your owner's current mandate: its limits and the headroom left across all their agents (null without one). */
  mandate: mandateSchema.nullable(),
  /** Your Agent Credit Score for this request (collateral scored only when invoice_amount_cents is given). */
  credit: creditSchema,
  /** Only while the calling agent is unclaimed — the link its human opens to claim it. */
  claim_url: z.string().optional(),
});

export const checkEligibilityTool = defineTool({
  name: "check_eligibility",
  title: "Check Eligibility",
  description:
    "Checks, without committing to anything, whether the calling agent could borrow amount_cents " +
    "for term_days right now (P1: 1000–50000 cents, 7–30 days, one open loan, enough pool " +
    "liquidity, and KYA tier ≥ 1: claimed by your human and covered by a signed mandate) and " +
    "quotes the fee, APR and total repayment. data.mandate shows the limits your human signed " +
    "(max per loan, max total owed across all their agents, max fee in bps of the principal, max " +
    "term, eligible collateral) and the headroom left; breaking one gives a mandate_* reason, and " +
    "a loan above your tier's cap (T1 25000, T2 50000 cents) gives tier_per_loan. Pass collateral " +
    "to also check the collateral rule. data.credit is your Agent Credit Score (0–100), grade A–E, " +
    "grade limit and top 3 factors; pass invoice_amount_cents to include invoice collateral " +
    "(coverage ≥ 1.5× scores 20 points, ≥ 1.1× scores 12; below 1.1× gives insufficient_collateral). " +
    "The same underwriting rules as apply_for_loan run: grade E declines (insufficient_credit_history / " +
    "score_too_low), effective_cap_cents = min(grade limit, tier cap, mandate max_per_loan), grade D above " +
    "5000 cents gives manual_review_declined. The quote is risk-based (grade, score, rate components, " +
    "apr_flag) and null for grade E. Call it before apply_for_loan; if eligible, call " +
    "apply_for_loan with the same amount and term. While unclaimed, reasons include " +
    "claim_required and data.claim_url is the link to give your human.",
  auth: "agent",
  mutating: false,
  readOnly: true,
  input: inputSchema,
  output: outputSchema,
  handler: async (input, ctx) => {
    if (!ctx.agentId) {
      throw new Error("check_eligibility requires an authenticated agent");
    }

    const gate = await borrowGate(ctx.db, ctx.worldId, ctx.agentId);
    const blockers = gate.tier.borrowBlockers;
    const claimUrl = gate.claimLink?.url ?? null;

    const result = await checkEligibility(ctx.db, ctx.worldId, ctx.agentId, BigInt(input.amount_cents), input.term_days, {
      collateral: input.collateral ?? (input.invoice_amount_cents !== undefined ? "invoice_link" : null),
      invoiceAmountCents: input.invoice_amount_cents !== undefined ? BigInt(input.invoice_amount_cents) : null,
    });
    const quote = result.quote;

    const reasons = [...blockers, ...result.reasons];
    const eligible = reasons.length === 0;

    let nextActions: NextAction[];
    if (eligible && quote) {
      // An invoice-backed check leads to an invoice-backed application (else it would be scored unsecured).
      const invoiceCents =
        input.invoice_amount_cents !== undefined
          ? Math.max(input.invoice_amount_cents, Number(quote.totalCents))
          : null;
      nextActions = [
        {
          tool: "apply_for_loan",
          args: {
            amount_cents: input.amount_cents,
            term_days: input.term_days,
            // Placeholder the agent must replace (5–200 chars).
            purpose: PURPOSE_PLACEHOLDER,
            ...(invoiceCents !== null
              ? {
                  invoice: {
                    client_email: SAMPLE_INVOICE_PLACEHOLDERS.client_email,
                    amount_cents: invoiceCents,
                    due_in_days: Math.min(input.term_days, 60),
                    description: SAMPLE_INVOICE_PLACEHOLDERS.description,
                  },
                }
              : {}),
            // ALA E and H (P3 Task 4): required; the agent declares and attests by sending them.
            declarations: { no_other_debt: true },
            attest: true,
          },
        },
      ];
    } else if (blockers.length > 0) {
      nextActions = blockerNextActions(blockers, claimUrl);
    } else if (result.reasons.includes("insufficient_credit_history") || result.reasons.includes("score_too_low")) {
      // I2: grade E — the way up is a small invoice-backed loan, not get_status (which would loop back here).
      const newcomer = invoiceBackedCheckArgs(input.amount_cents, input.term_days);
      const alreadyTried =
        newcomer.amount_cents === input.amount_cents &&
        input.invoice_amount_cents !== undefined &&
        input.invoice_amount_cents >= newcomer.invoice_amount_cents;
      nextActions = alreadyTried ? [{ tool: "get_bank_guide", args: {} }] : [{ tool: "check_eligibility", args: newcomer }];
    } else {
      nextActions = [{ tool: "get_status", args: {} }];
    }

    const feeAdvice =
      result.reasons.includes("mandate_fee") && quote && result.mandate
        ? ` ${mandateFeeAdvice(result.mandate.max_fee_bps, Number(quote.feeCents), input.amount_cents)}`
        : "";

    return ok(
      {
        eligible,
        reasons,
        max_principal_cents: Number(result.maxPrincipalCents),
        available_liquidity_cents: Number(result.availableLiquidityCents),
        effective_cap_cents: Number(result.effectiveCapCents),
        quote: quote
          ? {
              fee_cents: Number(quote.feeCents),
              apr_bps: quote.aprBps,
              total_cents: Number(quote.totalCents),
              grade: quote.grade,
              score: quote.score,
              rate_components: quote.rateComponents,
              apr_flag: quote.aprFlag,
              base_rate_bps: quote.baseRateBps,
              utilization_premium_bps: quote.utilizationPremiumBps,
            }
          : null,
        tier: gate.tier.tier,
        mandate: result.mandate,
        credit: creditView(result.credit),
        ...(claimUrl ? { claim_url: claimUrl } : {}),
      },
      {
        status: "OK",
        summary: eligible && quote
          ? `Eligible (score ${quote.score}, grade ${quote.grade}): fee ${quote.feeCents.toString()} cents, total ${quote.totalCents.toString()} cents.`
          : `Not eligible right now: ${reasons.join(", ")}.` +
            (blockers.length > 0 ? ` ${blockerInstruction(blockers, claimUrl)}` : "") +
            feeAdvice,
        reason_codes: reasons,
        next_actions: nextActions,
      },
    );
  },
});
