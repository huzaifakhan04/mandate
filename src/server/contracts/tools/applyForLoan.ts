import { z } from "zod";

import { fail, ok } from "../envelope";
import { defineTool } from "../registry";
import { price } from "../../domain/pricing";
import { createLoanOffer } from "../../services/loans";

const invoiceSchema = z.object({
  client_email: z.email(),
  amount_cents: z.number().int().min(1),
  due_in_days: z.number().int().min(1).max(60),
  description: z.string().min(1).max(500),
});

// M7: the invoice-size rule (≥ principal + fee) is checked in the handler,
// not here, so the error can carry the computed minimum.
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
  note: z.string().optional(),
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
    "call accept_offer with offer_id and disclosure_hash, or decline_offer.",
  auth: "agent",
  mutating: true,
  readOnly: false,
  input: inputSchema,
  output: outputSchema,
  handler: async (input, ctx) => {
    if (!ctx.agentId) {
      throw new Error("apply_for_loan requires an authenticated agent");
    }

    if (input.invoice) {
      // M7: the bank repays itself from the invoice, so it must cover the
      // whole debt (principal + fee), not just the principal.
      const minimumCents = BigInt(input.amount_cents) + price(BigInt(input.amount_cents), input.term_days).feeCents;
      if (BigInt(input.invoice.amount_cents) < minimumCents) {
        return fail(
          "INVALID_REQUEST",
          `invoice.amount_cents must be at least ${minimumCents} cents (amount_cents + the ${minimumCents - BigInt(input.amount_cents)}-cent fee).`,
          ["invoice_too_small"],
          { minimum_invoice_cents: Number(minimumCents) },
        );
      }
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
