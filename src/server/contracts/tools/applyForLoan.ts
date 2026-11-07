import { eq } from "drizzle-orm";
import { z } from "zod";

import { agents } from "../../db/schema";
import { REASON_PRIORITY } from "../../domain/reasons";
import type { Explanation } from "../../services/adverseAction";
import { createLoanOffer, type NarrativeInputs } from "../../services/loans";
import { narrateApplication } from "../../services/underwritingNarrative";
import { fail, ok, type Envelope, type NextAction } from "../envelope";
import { halvedCheckArgs, invoiceBackedCheckArgs } from "../sampleArgs";
import { PURPOSE_PLACEHOLDER } from "./checkEligibility";
import { defineTool } from "../registry";
import { loanTreasuryLimits, type LoanTreasuryFacts } from "../../domain/treasury";
import type { ReasonCode } from "../../domain/reasons";

const invoiceSchema = z.object({
  client_email: z.email(),
  amount_cents: z.number().int().min(1),
  due_in_days: z.number().int().min(1).max(60),
  description: z.string().min(1).max(500),
});

// M7: the invoice-size rule (≥ principal + fee) is checked by
// `createLoanOffer` (the fee depends on the agent's grade), not here, so
// the error can carry the computed minimum.
/**
 * The ALA application (P3 Task 4), sections A–H. Backwards compatible:
 * every new field is optional, but E (`declarations.no_other_debt`) and H
 * (`attest`) default to false, which declines with `declaration_missing`.
 */
const inputSchema = z.object({
  // A. Identity (what the agent declares; stored as given).
  identity: z
    .object({
      operator: z.string().max(200).optional(),
      model: z.string().max(200).optional(),
      code_manifest_hash: z.string().max(200).optional(),
    })
    .optional(),
  // C. Amount and term.
  amount_cents: z.number().int().min(1),
  term_days: z.number().int().min(1),
  // B. Purpose.
  purpose: z.string().min(5).max(200),
  // D. Collateral.
  invoice: invoiceSchema.optional(),
  // E. Declarations.
  declarations: z.object({ no_other_debt: z.boolean() }).optional(),
  // F. Consent to a credit check of bank records.
  consent_bank_records: z.boolean().optional(),
  // G. Mandate reference: filled by the server; name the version you expect to be refused if it changed.
  mandate_version: z.number().int().min(1).optional(),
  // H. Attestation that the application is accurate.
  attest: z.boolean().optional(),
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
  /** P5 (disclosure v2): the annual base rate and utilization premium (bps) in the cost of funds. */
  base_rate_bps: z.number(),
  utilization_premium_bps: z.number(),
  right_to_statement: z.string(),
});

export const explanationSchema = z.object({
  source: z.enum(["ai", "template"]),
  summary: z.string(),
  reasons_explained: z.array(z.object({ code: z.enum(REASON_PRIORITY), explanation: z.string() })),
  next_steps: z.array(z.string()),
});

export const adverseActionSchema = z.object({
  reasons: z.array(z.object({ code: z.enum(REASON_PRIORITY), text: z.string() })).max(4),
  score: z.number(),
  grade: z.enum(["A", "B", "C", "D", "E"]),
  score_factors: z.array(z.string()),
  notice: z.string(),
  explanation: explanationSchema,
});

/** OFFERED (offer + disclosure) or DECLINED (reason codes + adverse action); both carry the explanation. */
const outputSchema = z.union([
  z.object({
    application_id: z.string(),
    offer_id: z.string(),
    disclosure: disclosureSchema,
    disclosure_hash: z.string(),
    expires_sim_at: z.string(),
    explanation: explanationSchema,
  }),
  z.object({
    application_id: z.string(),
    reasons: z.array(z.string()),
    adverse_action: adverseActionSchema,
    explanation: explanationSchema,
    /** M2 (final review): this world's actual caps, only for a treasury-gate decline. */
    treasury: z
      .object({
        reserve_floor_cents: z.number().optional(),
        concentration_cap_cents: z.number().optional(),
        daily_budget_cents: z.number().nullable().optional(),
        daily_budget_used_cents: z.number().optional(),
      })
      .optional(),
  }),
]);

interface ApplyFinalizeState {
  applicationId: string;
  /** The applicant (the daily per-agent LLM narrative cap). */
  agentId: string;
  narrative: NarrativeInputs;
  /** Private-world bots get the template narrative (no LLM calls for simulated volume). */
  isBot: boolean;
}

type ApplyInput = z.infer<typeof inputSchema>;

/** Only an ALA E/H miss: the reasons are `declaration_missing` and nothing else. */
function onlyDeclarationMissing(reasons: readonly string[]): boolean {
  return reasons.length > 0 && reasons.every((reason) => reason === "declaration_missing");
}

/** M1 (final review): the treasury/capacity gates where the bank, not the request, is the constraint. */
const TREASURY_GATE_REASONS = [
  "reserve_floor",
  "concentration_limit",
  "daily_budget_exhausted",
  "pool_utilization_high",
] as const;

/**
 * What a DECLINED agent should do next (P3 final review I2/I5; M1 final
 * review for the treasury gates):
 * - grade E (no or bad history) → check an invoice-backed newcomer loan
 *   (≤ 5000 cents, invoice ≥ 1.5×) instead of the same request again;
 * - only `declaration_missing` → the same application with section E and
 *   H filled in (the summary says to send them only if they are true);
 * - reserve_floor / concentration_limit / daily_budget_exhausted /
 *   pool_utilization_high → the bank's capacity is the constraint, not
 *   anything about this application: get_status (to watch it recover),
 *   plus check_eligibility for half the amount (min 1000 cents) in case a
 *   smaller request clears the same gate — not the same check again;
 * - anything else → check eligibility for the same amount and term.
 */
function declinedNextActions(input: ApplyInput, reasons: readonly string[]): NextAction[] {
  // P7: under risk review nothing about the application helps — see the flag in get_status.
  if (reasons.includes("risk_review")) {
    return [{ tool: "get_status", args: {} }];
  }
  if (reasons.includes("insufficient_credit_history") || reasons.includes("score_too_low")) {
    return [{ tool: "check_eligibility", args: invoiceBackedCheckArgs(input.amount_cents, input.term_days) }];
  }
  if (onlyDeclarationMissing(reasons)) {
    return [
      {
        tool: "apply_for_loan",
        args: {
          ...input,
          // A blank purpose is also a section B/E miss: hand back the placeholder to fill in.
          ...(input.purpose.trim().length === 0 ? { purpose: PURPOSE_PLACEHOLDER } : {}),
          declarations: { no_other_debt: true },
          attest: true,
        },
      },
    ];
  }
  if (TREASURY_GATE_REASONS.some((reason) => reasons.includes(reason))) {
    return [
      { tool: "get_status", args: {} },
      { tool: "check_eligibility", args: halvedCheckArgs(input.amount_cents, input.term_days) },
    ];
  }
  return [{ tool: "check_eligibility", args: { amount_cents: input.amount_cents, term_days: input.term_days } }];
}

/**
 * M2 (final review): this world's actual treasury caps, for a DECLINED
 * response whose reasons include a treasury gate — `data.treasury` carries
 * only the fields relevant to the reasons that actually fired, so the
 * fixed reason text ("see data.treasury") always points at real numbers.
 */
function treasuryGateData(reasons: readonly ReasonCode[], facts: LoanTreasuryFacts | null): Record<string, unknown> | null {
  if (!facts || !TREASURY_GATE_REASONS.some((reason) => reasons.includes(reason))) {
    return null;
  }
  const limits = loanTreasuryLimits(facts);
  const treasury: Record<string, unknown> = {};
  if (reasons.includes("reserve_floor")) {
    treasury.reserve_floor_cents = Number(limits.reserveFloorCents);
  }
  if (reasons.includes("concentration_limit")) {
    treasury.concentration_cap_cents = Number(limits.concentrationCapCents);
  }
  if (reasons.includes("daily_budget_exhausted")) {
    treasury.daily_budget_cents = limits.dailyBudgetCents === null ? null : Number(limits.dailyBudgetCents);
    treasury.daily_budget_used_cents = Number(facts.budgetUsedCents);
  }
  return Object.keys(treasury).length > 0 ? { treasury } : null;
}

/** I5: the declined summary's extra instruction when only the declarations were missing. */
const DECLARATION_RETRY_TEXT =
  " Your application was missing its declarations: re-apply with declarations.no_other_debt: true and attest: true " +
  "ONLY if both are true — you have no other outstanding debts and everything in the application is accurate. " +
  "If either is not true, do not send them.";

function isApplyFinalizeState(state: unknown): state is ApplyFinalizeState {
  return typeof state === "object" && state !== null && "applicationId" in state && "narrative" in state;
}

/** The envelope with `data.explanation` (and the notice's copy) replaced; nothing else changes. */
function withExplanation(envelope: Envelope<unknown>, explanation: Explanation): Envelope<unknown> {
  const data = envelope.data as Record<string, unknown>;
  const adverse = data.adverse_action as Record<string, unknown> | undefined;
  return {
    ...envelope,
    data: { ...data, explanation, ...(adverse ? { adverse_action: { ...adverse, explanation } } : {}) },
  };
}

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
    "mandate_id and mandate_version it was made under. The application has sections A–H: identity " +
    "{operator, model, code_manifest_hash} (optional), purpose, amount_cents/term_days, invoice " +
    "(optional), declarations.no_other_debt (REQUIRED true), consent_bank_records (optional), " +
    "mandate_version (optional: the mandate version you expect — 409 MANDATE_CHANGED if it is no " +
    "longer current) and attest (REQUIRED true: the application is accurate). Without " +
    "declarations.no_other_debt and attest it is DECLINED with declaration_missing. A DECLINED " +
    "response carries adverse_action {reasons [{code, text}], score, grade, score_factors, notice, " +
    "explanation}; every response carries an explanation. Re-read either later with get_application.",
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
      identity: input.identity
        ? {
            operator: input.identity.operator,
            model: input.identity.model,
            codeManifestHash: input.identity.code_manifest_hash,
          }
        : null,
      noOtherDebt: input.declarations?.no_other_debt === true,
      consentBankRecords: input.consent_bank_records === true,
      expectedMandateVersion: input.mandate_version ?? null,
      attest: input.attest === true,
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
      const feeCents = minimumCents - BigInt(input.amount_cents);
      return fail(
        "INVALID_REQUEST",
        feeCents > 0n
          ? `invoice.amount_cents must be at least ${minimumCents} cents (amount_cents + the ${feeCents}-cent fee).`
          : // No price (grade E): the invoice must at least cover amount_cents.
            `invoice.amount_cents must be at least ${minimumCents} cents (amount_cents).`,
        ["invoice_too_small"],
        { minimum_invoice_cents: Number(minimumCents) },
      );
    }

    if (result.outcome === "mandate_changed") {
      return fail(
        "MANDATE_CHANGED",
        `Your mandate is now version ${result.currentMandateVersion ?? "none"}, not ${input.mandate_version}. ` +
          "Re-read it (get_status), check eligibility, and apply again.",
        ["mandate_changed"],
        { current_mandate_version: result.currentMandateVersion },
      );
    }

    // Ruling K: the narrative (loan officer, risk officer for grade D) is written after commit.
    const [caller] = await ctx.scoped.selectFields(agents, { isBot: agents.isBot }, eq(agents.id, ctx.agentId));
    ctx.setFinalizeState({
      applicationId: result.applicationId,
      agentId: ctx.agentId,
      narrative: result.narrative,
      isBot: caller?.isBot === true,
    } satisfies ApplyFinalizeState);

    if (result.outcome === "declined") {
      const treasuryData = treasuryGateData(result.reasons, result.treasury);
      return ok(
        {
          application_id: result.applicationId,
          reasons: result.reasons,
          adverse_action: result.adverseAction,
          explanation: result.adverseAction.explanation,
          ...treasuryData,
        },
        {
          status: "DECLINED",
          // The fixed reason text, verbatim: what the agent should quote to its human (agents.md, "Tell your human why").
          summary:
            `Application declined. Tell your human the bank's principal reasons, quoted: ` +
            `${result.adverseAction.reasons.map((r) => `"${r.text}"`).join(" ")} ` +
            `(${result.reasons.join(", ")}).` +
            (onlyDeclarationMissing(result.reasons) ? DECLARATION_RETRY_TEXT : ""),
          reason_codes: result.reasons,
          next_actions: declinedNextActions(input, result.reasons),
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
        explanation: result.narrative.templateExplanation,
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
  /**
   * After commit: the loan officer's explanation (and the grade D risk
   * memo) are written to the application, time-bounded; the envelope gets
   * the new `explanation`. Decision fields are never touched here.
   */
  finalize: async (envelope, ctx, state) => {
    if (!isApplyFinalizeState(state)) {
      return envelope;
    }
    const narrative = await narrateApplication(ctx.db, ctx.worldId, state.applicationId, state.narrative, {
      templateOnly: state.isBot,
      agentId: state.agentId,
    });
    return withExplanation(envelope, narrative.explanation);
  },
});
