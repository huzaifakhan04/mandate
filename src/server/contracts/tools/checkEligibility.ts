import { z } from "zod";

import { ok } from "../envelope";
import { blockerInstruction, blockerNextActions } from "../kyaActions";
import { defineTool } from "../registry";
import { borrowGate } from "../../services/kya";
import { checkEligibility } from "../../services/loans";

/** `apply_for_loan` requires a purpose only the agent can supply; the next action carries this placeholder. */
export const PURPOSE_PLACEHOLDER = "<describe what the money is for>";

const inputSchema = z.object({
  amount_cents: z.number().int().min(1),
  term_days: z.number().int().min(1),
});

const outputSchema = z.object({
  eligible: z.boolean(),
  reasons: z.array(z.string()),
  max_principal_cents: z.number(),
  available_liquidity_cents: z.number(),
  quote: z.object({ fee_cents: z.number(), apr_bps: z.number(), total_cents: z.number() }),
  tier: z.number(),
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
    "quotes the fee, APR and total repayment. Call it before apply_for_loan; if eligible, call " +
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
    );

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
