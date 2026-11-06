import { z } from "zod";

import { REASON_PRIORITY } from "@/server/domain/reasons";

/**
 * The AI roles (P3 Global Constraints, "AI roles"; P5 Task 3 adds the
 * treasury officer's daily memo): their inputs
 * (an allowlist — zod strips every field not named here, so a caller can
 * never forward a whole row by accident) and their outputs (a zod schema
 * for validation plus the equivalent strict JSON schema sent to the
 * Responses API as `text.format`).
 *
 * The LLM only writes text. Every decision — status, reasons, price,
 * limit, the KYA review status — is made deterministically elsewhere and
 * arrives here as input.
 */

export const AI_ROLES = ["kya_desk", "loan_officer", "risk_officer", "treasury_officer"] as const;
export type AiRole = (typeof AI_ROLES)[number];

const reasonCode = z.enum(REASON_PRIORITY);
const shortText = z.string().max(500);
const reason = z.object({ code: reasonCode, text: shortText });

// ---------------------------------------------------------------- inputs

export const kyaDeskInputSchema = z.object({
  agent: z.object({ name: shortText, operator: shortText, tier: z.number().int().min(0).max(2) }),
  document: z.object({
    kind: shortText,
    fileName: shortText.nullable(),
    contentType: shortText.nullable(),
    sizeBytes: z.number().int().nullable(),
    /** The authoritative P2 auto-review status (the AI is advisory only). */
    autoReviewStatus: shortText,
  }),
});

export const loanOfficerInputSchema = z.object({
  decision: z.enum(["approve", "decline"]),
  /** The principal reasons (≤ 4) with their fixed text; empty when approved. */
  reasons: z.array(reason).max(4),
  score: z.number().int().min(0).max(100),
  grade: z.enum(["A", "B", "C", "D", "E"]),
  scoreFactors: z.array(shortText).max(5),
  amountCents: z.number().int().nonnegative(),
  termDays: z.number().int().positive(),
  feeCents: z.number().int().nonnegative().nullable(),
  aprBps: z.number().int().nonnegative().nullable(),
  effectiveCapCents: z.number().int().nonnegative(),
  /** The mandate's `max_fee_bps` (P3 final review C1: the mandate_fee next step quotes it); null without a mandate. */
  mandateMaxFeeBps: z.number().int().nonnegative().nullable().optional(),
});

export const riskOfficerInputSchema = z.object({
  decision: z.enum(["approve", "decline"]),
  /** The rules pipeline's approval authority (`n/a`: declined for another reason). */
  approval: z.enum(["auto", "manual_review_declined", "n/a"]),
  reasons: z.array(reason).max(4),
  score: z.number().int().min(0).max(100),
  grade: z.enum(["A", "B", "C", "D", "E"]),
  components: z.object({
    identity: z.number().int(),
    history: z.number().int(),
    tenure: z.number().int(),
    collateral: z.number().int(),
    exposure: z.number().int(),
  }),
  scoreFactors: z.array(shortText).max(5),
  amountCents: z.number().int().nonnegative(),
  termDays: z.number().int().positive(),
  invoiceCoverageBps: z.number().int().nonnegative().nullable(),
});

const int = z.number().int();
const cents = z.number().int();

/**
 * P5 Task 3: the treasury officer's input — the world's economy numbers
 * only (no agent, principal or loan identities), all integers: bps, bp
 * (index, 10000 = 1.0000) or cents.
 */
export const treasuryOfficerInputSchema = z.object({
  simDay: int.nonnegative(),
  baseRateBps: int,
  inflationRateBps: int,
  inflationIndexBp: int,
  utilizationBps: int.nonnegative(),
  utilizationPremiumBps: int.nonnegative(),
  /** cash ÷ notes payable (bps); 0 with no notes. */
  reserveRatioBps: int.nonnegative(),
  reserveFloorBps: int.nonnegative(),
  reserveFloorCents: cents,
  cashCents: cents,
  availableLiquidityCents: cents,
  loansReceivableCents: cents,
  openLoans: int.nonnegative(),
  notesPayableCents: cents,
  allowanceCents: cents,
  dailyBudgetCents: cents.nullable(),
  budgetUsedCents: cents,
  queuedRedemptions: int.nonnegative(),
  queuedRedemptionCents: cents,
});

export type KyaDeskInput = z.infer<typeof kyaDeskInputSchema>;
export type LoanOfficerInput = z.infer<typeof loanOfficerInputSchema>;
export type RiskOfficerInput = z.infer<typeof riskOfficerInputSchema>;
export type TreasuryOfficerInput = z.infer<typeof treasuryOfficerInputSchema>;

// --------------------------------------------------------------- outputs

const outText = z.string().min(1).max(1200);
const outList = z.array(z.string().min(1).max(400)).max(8);

export const kyaDeskOutputSchema = z.strictObject({
  verdict: z.enum(["approve", "needs_info", "reject"]),
  findings: outList,
});

export const loanOfficerOutputSchema = z.strictObject({
  summary: outText,
  reasons_explained: z.array(z.strictObject({ code: reasonCode, explanation: z.string().min(1).max(600) })).max(4),
  next_steps: outList,
});

export const riskOfficerOutputSchema = z.strictObject({
  memo: z.string().min(1).max(2000),
  concerns: outList,
});

export const treasuryOfficerOutputSchema = z.strictObject({
  headline: z.string().min(1).max(200),
  observations: z.array(z.string().min(1).max(400)).max(6),
  risks: z.array(z.string().min(1).max(400)).max(6),
});

export type KyaDeskOutput = z.infer<typeof kyaDeskOutputSchema>;
export type LoanOfficerOutput = z.infer<typeof loanOfficerOutputSchema>;
export type RiskOfficerOutput = z.infer<typeof riskOfficerOutputSchema>;
export type TreasuryOfficerOutput = z.infer<typeof treasuryOfficerOutputSchema>;

export interface RoleIO {
  kya_desk: { input: KyaDeskInput; output: KyaDeskOutput };
  loan_officer: { input: LoanOfficerInput; output: LoanOfficerOutput };
  risk_officer: { input: RiskOfficerInput; output: RiskOfficerOutput };
  treasury_officer: { input: TreasuryOfficerInput; output: TreasuryOfficerOutput };
}

export const INPUT_SCHEMAS = {
  kya_desk: kyaDeskInputSchema,
  loan_officer: loanOfficerInputSchema,
  risk_officer: riskOfficerInputSchema,
  treasury_officer: treasuryOfficerInputSchema,
} as const;

export const OUTPUT_SCHEMAS = {
  kya_desk: kyaDeskOutputSchema,
  loan_officer: loanOfficerOutputSchema,
  risk_officer: riskOfficerOutputSchema,
  treasury_officer: treasuryOfficerOutputSchema,
} as const;

// Strict JSON schemas for `text.format` (structured outputs strict mode:
// every property required, `additionalProperties: false`). Kept by hand
// next to the zod schemas; tests/unit/ai/schemas.test.ts checks they agree.
const stringList = { type: "array", items: { type: "string" } } as const;

export const OUTPUT_JSON_SCHEMAS: Record<AiRole, Record<string, unknown>> = {
  kya_desk: {
    type: "object",
    properties: {
      verdict: { type: "string", enum: ["approve", "needs_info", "reject"] },
      findings: stringList,
    },
    required: ["verdict", "findings"],
    additionalProperties: false,
  },
  loan_officer: {
    type: "object",
    properties: {
      summary: { type: "string" },
      reasons_explained: {
        type: "array",
        items: {
          type: "object",
          properties: {
            code: { type: "string", enum: [...REASON_PRIORITY] },
            explanation: { type: "string" },
          },
          required: ["code", "explanation"],
          additionalProperties: false,
        },
      },
      next_steps: stringList,
    },
    required: ["summary", "reasons_explained", "next_steps"],
    additionalProperties: false,
  },
  risk_officer: {
    type: "object",
    properties: {
      memo: { type: "string" },
      concerns: stringList,
    },
    required: ["memo", "concerns"],
    additionalProperties: false,
  },
  treasury_officer: {
    type: "object",
    properties: {
      headline: { type: "string" },
      observations: stringList,
      risks: stringList,
    },
    required: ["headline", "observations", "risks"],
    additionalProperties: false,
  },
};
