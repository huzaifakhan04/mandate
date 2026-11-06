import { checkMandate, type MandateCollateral, type MandateLimits } from "./mandate";
import { rangeReasons } from "./pricing";
import { priceLoan, type LoanPrice } from "./pricingV2";
import type { ReasonCode } from "./reasons";
import { GRADE_LIMIT_CENTS, type ScoreResult } from "./scorecard";

/**
 * The deterministic underwriting rules pipeline (P3 Global Constraints,
 * "Rules pipeline" + "Approval authority"). Pure: the services gather the
 * facts (under the note series lock for `apply_for_loan`) and this decides.
 *
 * Every rule runs and every failing rule adds its reason (all of them go on
 * the notice); the order is fixed and the first failure is the `primary`
 * reason that decides. Every reason is a hard failure.
 *
 *   0. product range       amount_out_of_range, term_out_of_range (P1 limits)
 *   1. tier / claim        tier_per_loan (the claim itself is the tool's tier gate)
 *   2. mandate             mandate_missing | mandate_per_loan, _total_owed, _fee, _term, _collateral
 *   3. sanctions stub      sanctions_hit (agent name or operator matches SANCTIONS_STUB)
 *   4. grade E             insufficient_credit_history (history component 0), else score_too_low
 *   5. amount vs cap       amount_exceeds_limit; grade D above 5000 → manual_review_declined
 *   6. collateral          insufficient_collateral (invoice given, coverage < 1.1×)
 *   7. declarations        declaration_missing (empty purpose, or no "no other debt" attestation)
 *   8. capacity            open_loan_exists, insufficient_liquidity
 *
 * Effective per-loan cap = min(grade limit, tier cap, mandate max_per_loan).
 * The tier and mandate parts already have their own codes (steps 1 and 2),
 * so `amount_exceeds_limit` is added for the grade limit — together the
 * three codes fire exactly when amount > the effective cap.
 *
 * Approval authority: grades A–C auto-approve within the grade limit;
 * grade D auto-approves only up to `GRADE_D_AUTO_APPROVE_MAX_CENTS`. Above
 * that it would need manual review, which P3 resolves deterministically as
 * a decline (`manual_review_declined`; the risk officer only writes a memo).
 */

export const GRADE_D_AUTO_APPROVE_MAX_CENTS = 5000n;
/** Invoice coverage below this (bps of the principal) is `insufficient_collateral`. */
export const MIN_INVOICE_COVERAGE_BPS = 11000;
export const DEFAULT_SANCTIONS_STUB = "sanctioned,blocked-entity";

export interface ApplicationFacts {
  amountCents: bigint;
  termDays: number;
  purpose: string;
  credit: Pick<ScoreResult, "score" | "grade" | "components">;
  /** The agent's KYA tier per-loan cap in cents. */
  tierCapCents: bigint;
  /** The current mandate's limits; `null` without one. */
  mandate: MandateLimits | null;
  /** The principal's current exposure across all their agents (not counting this application). */
  exposureCents: bigint;
  /** The collateral kind for the mandate rule; `null` skips it (check_eligibility without a kind). */
  collateral: MandateCollateral | null;
  /** Invoice face ÷ principal in bps; `null` without an invoice. */
  invoiceCoverageBps: number | null;
  sanctions: { name: string; operator: string; list: readonly string[] };
  /**
   * ALA section E. P3 Task 2 passes `noOtherDebt: true` (declarations are
   * not collected yet); Task 4 makes them required input.
   */
  declarations: { noOtherDebt: boolean };
  openLoanExists: boolean;
  availableLiquidityCents: bigint;
  /** Pricing base rate (default 400 bps). */
  baseRateBps?: number;
}

export interface ApplicationDecision {
  decision: "approve" | "decline";
  /** Every failing rule's code, in pipeline order. */
  reasons: ReasonCode[];
  /** The first hard failure — the deciding reason; `null` when approved. */
  primary: ReasonCode | null;
  /** min(grade limit, tier cap, mandate max_per_loan); 0 without a mandate. */
  effectiveCapCents: bigint;
  /** `manual_review_declined` when the grade D manual-review band decided it, else `auto`. */
  approval: "auto" | "manual_review_declined";
  /** The v2 price (grade E is never priced: `null`). */
  price: LoanPrice | null;
}

/** `SANCTIONS_STUB` as a list: comma-separated, trimmed, lower-cased; unset → the default stub list. */
export function sanctionsStubList(raw: string | undefined = process.env.SANCTIONS_STUB): string[] {
  return (raw ?? DEFAULT_SANCTIONS_STUB)
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

/** Case-insensitive substring match of any stub entry on the agent's name or operator. */
export function sanctionsHit(name: string, operator: string, list: readonly string[]): boolean {
  const haystacks = [name.toLowerCase(), operator.toLowerCase()];
  return list.some((entry) => entry.length > 0 && haystacks.some((text) => text.includes(entry.toLowerCase())));
}

function minBig(...values: bigint[]): bigint {
  return values.reduce((min, value) => (value < min ? value : min));
}

export function evaluateApplication(facts: ApplicationFacts): ApplicationDecision {
  const { amountCents, termDays, credit, mandate } = facts;
  const reasons: ReasonCode[] = [];
  const gradeLimitCents = BigInt(GRADE_LIMIT_CENTS[credit.grade]);
  const effectiveCapCents = mandate ? minBig(gradeLimitCents, facts.tierCapCents, mandate.maxPerLoanCents) : 0n;

  const price =
    credit.grade === "E" || amountCents <= 0n || termDays <= 0
      ? null
      : priceLoan({
          principalCents: amountCents,
          termDays,
          grade: credit.grade,
          coverageBps: facts.invoiceCoverageBps,
          ...(facts.baseRateBps !== undefined ? { baseRateBps: facts.baseRateBps } : {}),
        });

  // 0. Product range.
  reasons.push(...rangeReasons(amountCents, termDays));

  // 1. Tier / claim.
  if (mandate && amountCents > facts.tierCapCents) {
    reasons.push("tier_per_loan");
  }

  // 2. Mandate (the fee check uses the v2 fee; grade E has none).
  reasons.push(
    ...checkMandate(mandate, facts.exposureCents, {
      principalCents: amountCents,
      feeCents: price?.feeCents ?? 0n,
      termDays,
      collateral: facts.collateral ?? "none",
    }).filter((reason) => facts.collateral !== null || reason !== "mandate_collateral"),
  );

  // 3. Sanctions stub.
  if (sanctionsHit(facts.sanctions.name, facts.sanctions.operator, facts.sanctions.list)) {
    reasons.push("sanctions_hit");
  }

  // 4. Grade E.
  if (credit.grade === "E") {
    reasons.push(credit.components.history === 0 ? "insufficient_credit_history" : "score_too_low");
  }

  // 5. Amount vs the grade limit, then approval authority for grade D.
  let manualReview = false;
  if (credit.grade !== "E" && amountCents > gradeLimitCents) {
    reasons.push("amount_exceeds_limit");
  } else if (credit.grade === "D" && amountCents > GRADE_D_AUTO_APPROVE_MAX_CENTS) {
    manualReview = true;
    reasons.push("manual_review_declined");
  }

  // 6. Collateral.
  if (facts.invoiceCoverageBps !== null && facts.invoiceCoverageBps < MIN_INVOICE_COVERAGE_BPS) {
    reasons.push("insufficient_collateral");
  }

  // 7. Declarations.
  if (facts.purpose.trim().length === 0 || !facts.declarations.noOtherDebt) {
    reasons.push("declaration_missing");
  }

  // 8. Capacity.
  if (facts.openLoanExists) {
    reasons.push("open_loan_exists");
  }
  if (amountCents > facts.availableLiquidityCents) {
    reasons.push("insufficient_liquidity");
  }

  const primary = reasons[0] ?? null;
  return {
    decision: primary ? "decline" : "approve",
    reasons,
    primary,
    effectiveCapCents,
    approval: manualReview ? "manual_review_declined" : "auto",
    price,
  };
}
