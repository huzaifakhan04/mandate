import { createHash } from "crypto";

import { canonicalJson } from "./disclosure";

/**
 * Standing mandates (P2 Task 4, Ruling P2-C). A human signs limits for
 * one of their agents; every borrowing path checks an offer against them.
 *
 * - `max_per_loan_cents`  — the principal of any one loan;
 * - `max_total_owed_cents` — the PRINCIPAL's total exposure in the world:
 *   Σ owed on the open loans of ALL agents they own + this loan's P + F;
 * - `max_fee_bps`         — the loan's flat fee as a share of its principal
 *   (fee × 10000 / principal), e.g. 500 = a fee of at most 5% of P;
 * - `max_term_days`       — the loan's term;
 * - `eligible_collateral` — `invoice_link` (an invoice the bank collects)
 *   and/or `none` (unsecured).
 *
 * Everything here is pure; `services/mandates.ts` does the I/O.
 */

export const MANDATE_COLLATERAL = ["invoice_link", "none"] as const;
export type MandateCollateral = (typeof MANDATE_COLLATERAL)[number];

/** Reason codes an offer gets when it breaks the mandate, in check order. */
export type MandateReason =
  | "mandate_missing"
  | "mandate_per_loan"
  | "mandate_total_owed"
  | "mandate_fee"
  | "mandate_term"
  | "mandate_collateral";

/** Bounds a signed mandate's limits must sit within. */
export const MANDATE_BOUNDS = {
  maxPerLoanCents: { min: 1000n, max: 50000n },
  maxTotalOwedCents: { min: 1000n, max: 10_000_000n },
  maxFeeBps: { min: 0, max: 10_000 },
  maxTermDays: { min: 1, max: 365 },
} as const;

/**
 * What the human agrees to when they sign (shown next to the checkbox).
 * Its sha256 is stored as `guarantee_text_hash` on every version.
 */
export const MANDATE_AGREEMENT_TEXT =
  "I authorise this agent to borrow from Mandate on my behalf within the limits above. " +
  "I am the borrower of record: I am responsible for repaying what it borrows under this " +
  "mandate, including fees. I can revoke this mandate at any time; revoking stops new " +
  "borrowing but does not cancel loans already taken.";

export function agreementTextHash(): string {
  return createHash("sha256").update(MANDATE_AGREEMENT_TEXT).digest("hex");
}

export interface MandateLimits {
  maxPerLoanCents: bigint;
  maxTotalOwedCents: bigint;
  maxFeeBps: number;
  maxTermDays: number;
  eligibleCollateral: readonly string[];
}

export interface MandateTerms extends MandateLimits {
  expiresAt: Date | null;
}

export interface MandateOffer {
  principalCents: bigint;
  feeCents: bigint;
  termDays: number;
  collateral: MandateCollateral;
}

/**
 * Pure: the mandate reason codes for `offer` given the principal's current
 * exposure (Σ owed on their agents' open loans, NOT including this offer).
 * `null` mandate → `["mandate_missing"]`. Empty ⇔ the offer fits.
 */
export function checkMandate(
  mandate: MandateLimits | null,
  exposureCents: bigint,
  offer: MandateOffer,
): MandateReason[] {
  if (!mandate) {
    return ["mandate_missing"];
  }
  const reasons: MandateReason[] = [];
  if (offer.principalCents > mandate.maxPerLoanCents) {
    reasons.push("mandate_per_loan");
  }
  if (exposureCents + offer.principalCents + offer.feeCents > mandate.maxTotalOwedCents) {
    reasons.push("mandate_total_owed");
  }
  if (offer.feeCents * 10_000n > offer.principalCents * BigInt(mandate.maxFeeBps)) {
    reasons.push("mandate_fee");
  }
  if (offer.termDays > mandate.maxTermDays) {
    reasons.push("mandate_term");
  }
  if (!mandate.eligibleCollateral.includes(offer.collateral)) {
    reasons.push("mandate_collateral");
  }
  return reasons;
}

/** How much more the principal may owe under `mandate` (never negative). */
export function totalOwedHeadroom(mandate: MandateLimits, exposureCents: bigint): bigint {
  const left = mandate.maxTotalOwedCents - exposureCents;
  return left > 0n ? left : 0n;
}

/** The per-loan ceiling: the smaller of the tier's cap and the mandate's. */
export function effectivePerLoanCap(tierCapCents: number, mandate: MandateLimits | null): bigint {
  const tierCap = BigInt(tierCapCents);
  if (!mandate) {
    return 0n;
  }
  return mandate.maxPerLoanCents < tierCap ? mandate.maxPerLoanCents : tierCap;
}

/** The signed record whose canonical JSON is hashed into `terms_hash`. */
export interface MandateSignedRecord {
  worldId: string;
  agentId: string;
  principalId: string;
  version: number;
  terms: MandateTerms;
  signerName: string;
  signedAt: Date;
  guaranteeTextHash: string;
}

export function mandateCanonicalJson(record: MandateSignedRecord): string {
  return canonicalJson({
    world_id: record.worldId,
    agent_id: record.agentId,
    principal_id: record.principalId,
    version: record.version,
    max_per_loan_cents: record.terms.maxPerLoanCents.toString(),
    max_total_owed_cents: record.terms.maxTotalOwedCents.toString(),
    max_fee_bps: record.terms.maxFeeBps,
    max_term_days: record.terms.maxTermDays,
    eligible_collateral: [...record.terms.eligibleCollateral].sort(),
    expires_at: record.terms.expiresAt ? record.terms.expiresAt.toISOString() : null,
    signer_name: record.signerName,
    signed_at: record.signedAt.toISOString(),
    guarantee_text_hash: record.guaranteeTextHash,
  });
}

export function mandateTermsHash(record: MandateSignedRecord): string {
  return createHash("sha256").update(mandateCanonicalJson(record)).digest("hex");
}

/**
 * Pure: a form's dollar amount ("300", "$1,250.50") as a cents string for
 * `parseMandateSignInput`; `undefined` when absent, `"invalid"` when not
 * a plain amount with at most two decimals (so the field fails validation).
 */
export function dollarsToCentsField(value: string | undefined): string | undefined {
  return decimalField(value, 2, /^\$/);
}

/** Pure: a form's percent ("3", "2.5%") as basis points (300, 250), like `dollarsToCentsField`. */
export function percentToBpsField(value: string | undefined): string | undefined {
  return decimalField(value, 2, /%$/);
}

function decimalField(value: string | undefined, decimals: number, strip: RegExp): string | undefined {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }
  const cleaned = value.trim().replace(strip, "").replace(/,/g, "").trim();
  const match = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!match) {
    return "invalid";
  }
  const fraction = (match[2] ?? "").padEnd(decimals, "0");
  return (BigInt(match[1]!) * 10n ** BigInt(decimals) + BigInt(fraction || "0")).toString();
}

/** Raw sign-form fields (JSON numbers/strings or form-encoded strings). */
export interface MandateSignInput {
  max_per_loan_cents?: unknown;
  max_total_owed_cents?: unknown;
  max_fee_bps?: unknown;
  max_term_days?: unknown;
  eligible_collateral?: unknown;
  expires_at?: unknown;
  typed_name?: unknown;
  agree?: unknown;
}

export type MandateInputError =
  | "max_per_loan_cents"
  | "max_total_owed_cents"
  | "max_fee_bps"
  | "max_term_days"
  | "eligible_collateral"
  | "expires_at"
  | "typed_name"
  | "agree";

function parseInteger(value: unknown): bigint | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return BigInt(value);
  }
  if (typeof value === "string" && /^\s*\d{1,15}\s*$/.test(value)) {
    return BigInt(value.trim());
  }
  return null;
}

function inRange(value: bigint | null, min: bigint, max: bigint): value is bigint {
  return value !== null && value >= min && value <= max;
}

function parseAgree(value: unknown): boolean {
  return value === true || value === "true" || value === "on" || value === "yes" || value === "1";
}

/**
 * Pure: validates the sign-form fields at `now`. Collateral may be an
 * array or a comma-separated string; `expires_at` is optional (ISO date
 * or date-time, must be in the future); the typed name is 2–100 chars;
 * `agree` must be ticked.
 */
export function parseMandateSignInput(
  input: MandateSignInput,
  now: Date,
): { ok: true; terms: MandateTerms; signerName: string } | { ok: false; errors: MandateInputError[] } {
  const errors: MandateInputError[] = [];
  const b = MANDATE_BOUNDS;

  const perLoan = parseInteger(input.max_per_loan_cents);
  if (!inRange(perLoan, b.maxPerLoanCents.min, b.maxPerLoanCents.max)) errors.push("max_per_loan_cents");
  const totalOwed = parseInteger(input.max_total_owed_cents);
  if (!inRange(totalOwed, b.maxTotalOwedCents.min, b.maxTotalOwedCents.max)) errors.push("max_total_owed_cents");
  const feeBps = parseInteger(input.max_fee_bps);
  if (!inRange(feeBps, BigInt(b.maxFeeBps.min), BigInt(b.maxFeeBps.max))) errors.push("max_fee_bps");
  const termDays = parseInteger(input.max_term_days);
  if (!inRange(termDays, BigInt(b.maxTermDays.min), BigInt(b.maxTermDays.max))) errors.push("max_term_days");

  const rawCollateral = Array.isArray(input.eligible_collateral)
    ? input.eligible_collateral
    : typeof input.eligible_collateral === "string"
      ? input.eligible_collateral.split(",")
      : [];
  const collateral = [...new Set(rawCollateral.map((c) => (typeof c === "string" ? c.trim() : "")))];
  if (
    collateral.length === 0 ||
    !collateral.every((c): c is MandateCollateral => (MANDATE_COLLATERAL as readonly string[]).includes(c))
  ) {
    errors.push("eligible_collateral");
  }

  let expiresAt: Date | null = null;
  if (input.expires_at !== undefined && input.expires_at !== null && input.expires_at !== "") {
    const parsed = typeof input.expires_at === "string" ? new Date(input.expires_at) : null;
    if (!parsed || Number.isNaN(parsed.getTime()) || parsed.getTime() <= now.getTime()) {
      errors.push("expires_at");
    } else {
      expiresAt = parsed;
    }
  }

  const signerName = typeof input.typed_name === "string" ? input.typed_name.trim().replace(/\s+/g, " ") : "";
  if (signerName.length < 2 || signerName.length > 100) errors.push("typed_name");
  if (!parseAgree(input.agree)) errors.push("agree");

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    signerName,
    terms: {
      maxPerLoanCents: perLoan!,
      maxTotalOwedCents: totalOwed!,
      maxFeeBps: Number(feeBps!),
      maxTermDays: Number(termDays!),
      eligibleCollateral: (collateral as MandateCollateral[]).sort(),
      expiresAt,
    },
  };
}
