import { z } from "zod";

import { fail, ok } from "../envelope";
import { defineTool } from "../registry";
import { createLoanOffer } from "../../services/loans";

const invoiceSchema = z.object({
  client_email: z.email(),
  amount_cents: z.number().int().min(1),
  due_in_days: z.number().int().min(1).max(60),
  description: z.string().min(1).max(500),
});

// M7: the invoice-size rule (≥ principal + fee) is checked by
// `createLoanOffer` (the fee depends on the agent's grade), not here, so
// the error can carry the computed minimum.
const inputSchema = z.object({
  amount_cents: z.number().int().min(1),
  term_days: z.number().int().min(1),
  purpose: z.string().min(5).max(200),
  invoice: invoiceSchema.optional(),
});

const disclosureSchema = z.object({
  funding_provided_cents: z.number(),
  fee_cents: z.number(),
  estimated_apr_bps: z.number(),
  total_repayment_cents: z.number(),
  term_days: z.number(),
  estimated_due_date: z.string(),
  due_rule: z.string(),
  prepayment: z.string(),
  collateral: z.string(),
  avoidable_fees: z.string(),
  total_cost_cents: z.number(),
  mandate_id: z.string(),
  mandate_version: z.number(),
  credit_score: z.number(),
  credit_grade: z.enum(["A", "B", "C", "D", "E"]),
  rate_components: z.object({
    cost_of_funds_bps: z.number(),
    expected_loss_bps: z.number(),
    ops_bps: z.number(),
    capital_bps: z.number(),
    total_bps: z.number(),
  }),
  apr_flag: z.string().optional(),
  right_to_statement: z.string(),
});

/** OFFERED (offer + disclosure) or DECLINED (reason codes). */
const outputSchema = z.union([
  z.object({
    application_id: z.string(),
    offer_id: z.string(),
    disclosure: disclosureSchema,
    disclosure_hash: z.string(),
    expires_sim_at: z.string(),
  }),
  z.object({
    application_id: z.string(),
    reasons: z.array(z.string()),
  }),
]);

export const applyForLoanTool = defineTool({
  name: "apply_for_loan",
  title: "Apply for Loan",
  description:
    "Applies for a loan of amount_cents over term_days (optionally backed by an invoice the bank " +
    "will collect via a payment link; invoice.amount_cents must cover the principal plus the fee, " +
    "i.e. at least amount_cents + the fee check_eligibility quotes). Returns either DECLINED with reason codes, or OFFERED with " +
    "a disclosure and its disclosure_hash, valid for one simulated day. Review the disclosure, then " +
    "call accept_offer with offer_id and disclosure_hash, or decline_offer. Needs KYA tier ≥ 1: " +
    "an unclaimed agent gets 403 CLAIM_REQUIRED (data.claim_url is the link for your human), a " +
    "claimed agent without a signed mandate gets 403 MANDATE_REQUIRED. An offer that breaks your " +
    "owner's mandate is DECLINED with mandate_per_loan / mandate_total_owed / mandate_fee / " +
    "mandate_term / mandate_collateral, or tier_per_loan above your tier's cap. Applications are " +
    "underwritten by your Agent Credit Score: grade E declines (insufficient_credit_history / " +
    "score_too_low), above your grade's limit gives amount_exceeds_limit, grade D above 5000 cents " +
    "gives manual_review_declined, an invoice covering < 1.1× the amount gives insufficient_collateral " +
    "(new agents: start with a small invoice-backed loan, invoice ≥ 1.5× the amount). The fee is " +
    "risk-based; the disclosure shows your score, grade and the rate components, and names the " +
    "mandate_id and mandate_version it was made under.",
  auth: "agent",
  mutating: true,
  // KYA tier gate (runTool): unclaimed → 403 CLAIM_REQUIRED with the
  // claim_url (only ever to the agent itself); claimed with no current
  // mandate → 403 MANDATE_REQUIRED.
  requiresBorrowTier: true,
  readOnly: false,
  input: inputSchema,
  output: outputSchema,
  handler: async (input, ctx) => {
    if (!ctx.agentId) {
      throw new Error("apply_for_loan requires an authenticated agent");
    }

    const result = await createLoanOffer(ctx.tx, ctx.worldId, ctx.agentId, {
      amountCents: BigInt(input.amount_cents),
      termDays: input.term_days,
      purpose: input.purpose,
      invoice: input.invoice
        ? {
            clientEmail: input.invoice.client_email,
            amountCents: BigInt(input.invoice.amount_cents),
            dueInDays: input.invoice.due_in_days,
            description: input.invoice.description,
          }
        : null,
    });

    if (result.outcome === "invoice_too_small") {
      // M7: the bank repays itself from the invoice, so it must cover the
      // whole debt (principal + the risk-priced fee), not just the principal.
      const minimumCents = result.minimumInvoiceCents;
      return fail(
        "INVALID_REQUEST",
        `invoice.amount_cents must be at least ${minimumCents} cents (amount_cents + the ${minimumCents - BigInt(input.amount_cents)}-cent fee).`,
        ["invoice_too_small"],
        { minimum_invoice_cents: Number(minimumCents) },
      );
    }

    if (result.outcome === "declined") {
      return ok(
        { application_id: result.applicationId, reasons: result.reasons },
        {
          status: "DECLINED",
          summary: `Application declined: ${result.reasons.join(", ")}.`,
          reason_codes: result.reasons,
          next_actions: [
            { tool: "check_eligibility", args: { amount_cents: input.amount_cents, term_days: input.term_days } },
          ],
        },
      );
    }

    return ok(
      {
        application_id: result.applicationId,
        offer_id: result.offerId,
        disclosure: result.disclosure,
        disclosure_hash: result.disclosureHash,
        expires_sim_at: result.expiresSimAt.toISOString(),
      },
      {
        status: "OFFERED",
        summary:
          `Offer: ${result.disclosure.funding_provided_cents} cents for ${result.disclosure.term_days} days, ` +
          `fee ${result.disclosure.fee_cents} cents. Accept with the disclosure_hash before it expires.`,
        next_actions: [
          { tool: "accept_offer", args: { offer_id: result.offerId, disclosure_hash: result.disclosureHash } },
          { tool: "decline_offer", args: { offer_id: result.offerId } },
        ],
      },
    );
  },
});
