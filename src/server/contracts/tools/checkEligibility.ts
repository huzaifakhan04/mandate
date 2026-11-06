import { z } from "zod";

import { ok } from "../envelope";
import { blockerInstruction, blockerNextActions } from "../kyaActions";
import { defineTool } from "../registry";
import { invoiceCoverageBps, scoreAgent } from "../../services/credit";
import { borrowGate } from "../../services/kya";
import { creditSchema, creditView } from "../credit";
import { checkEligibility } from "../../services/loans";

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
  quote: z.object({ fee_cents: z.number(), apr_bps: z.number(), total_cents: z.number() }),
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
    "(coverage ≥ 1.5× scores 20 points, ≥ 1.1× scores 12). Call it before apply_for_loan; if eligible, call " +
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

    const result = await checkEligibility(
      ctx.db,
      ctx.worldId,
      ctx.agentId,
      BigInt(input.amount_cents),
      input.term_days,
      input.collateral ?? null,
    );

    // Read-only: computed for this request, never persisted (apply_for_loan records it).
    const credit = await scoreAgent(ctx.db, ctx.worldId, ctx.agentId, ctx.simNow, {
      ...(input.invoice_amount_cents !== undefined
        ? { invoiceCoverageBps: invoiceCoverageBps(BigInt(input.invoice_amount_cents), BigInt(input.amount_cents)) }
        : {}),
    });

    const reasons = [...blockers, ...result.reasons];
    const eligible = reasons.length === 0;

    return ok(
      {
        eligible,
        reasons,
        max_principal_cents: Number(result.maxPrincipalCents),
        available_liquidity_cents: Number(result.availableLiquidityCents),
        quote: {
          fee_cents: Number(result.quote.feeCents),
          apr_bps: result.quote.aprBps,
          total_cents: Number(result.quote.totalCents),
        },
        tier: gate.tier.tier,
        mandate: result.mandate,
        credit: creditView(credit),
        ...(claimUrl ? { claim_url: claimUrl } : {}),
      },
      {
        status: "OK",
        summary: eligible
          ? `Eligible: fee ${result.quote.feeCents.toString()} cents, total ${result.quote.totalCents.toString()} cents.`
          : `Not eligible right now: ${reasons.join(", ")}.` +
            (blockers.length > 0 ? ` ${blockerInstruction(blockers, claimUrl)}` : ""),
        reason_codes: reasons,
        next_actions: eligible
          ? [
              {
                tool: "apply_for_loan",
                args: {
                  amount_cents: input.amount_cents,
                  term_days: input.term_days,
                  // Placeholder the agent must replace (5–200 chars).
                  purpose: PURPOSE_PLACEHOLDER,
                },
              },
            ]
          : blockers.length > 0
            ? blockerNextActions(blockers, claimUrl)
            : [{ tool: "get_status", args: {} }],
      },
    );
  },
});
