import type { Grade } from "./scorecard";

/**
 * Risk-based pricing v2 (P3 Global Constraints, "Pricing v2"; replaces the
 * flat P1 `price()`). Every component is in bps of the principal for the
 * whole term:
 *
 *   cost of funds = round(base APR bps × term ÷ 365)     (base 400; P5 makes it dynamic)
 *   expected loss = PD × LGD ÷ 10000                      (PD by grade; LGD 6000 unsecured,
 *                                                          3500 when an invoice covers ≥ 1.1×)
 *   ops           = 50
 *   capital       = 8% × PD = 800 × PD ÷ 10000
 *   fee           = max(25, ceil(principal × Σ ÷ 10000))
 *   APR bps       = round(fee ÷ principal × 365 ÷ term × 10000)
 *
 * Pure and integer-only. The components are whole bps (only the cost of
 * funds needs rounding — half-up — and every PD × LGD / capital product
 * divides exactly), so the disclosed components reproduce the fee
 * exactly; the fee is rounded up once, at the end, in `bigint` cents.
 * Grade E is never priced — it always declines (`domain/rules.ts`).
 */

export type PricedGrade = Exclude<Grade, "E">;

/** Probability of default by grade, in bps. */
export const PD_BPS: Record<PricedGrade, number> = { A: 100, B: 300, C: 600, D: 1200 };
/** Loss given default, in bps: unsecured vs covered by an invoice of ≥ 1.1× the principal. */
export const LGD_BPS = { unsecured: 6000, invoiceCovered: 3500 } as const;
/** Invoice coverage (invoice ÷ principal, bps) from which the covered LGD applies. */
export const COVERED_MIN_COVERAGE_BPS = 11000;
export const BASE_RATE_BPS = 400;
export const OPS_BPS = 50;
/** Capital charge: 8% of PD. */
export const CAPITAL_PCT_OF_PD_BPS = 800;
export const MIN_FEE_CENTS = 25n;
/** The disclosure flags an APR above 36% (CA/NY-style state caps). */
export const APR_FLAG_THRESHOLD_BPS = 3600;

export interface PriceLoanInput {
  principalCents: bigint;
  termDays: number;
  grade: PricedGrade;
  /** Invoice face ÷ principal in bps; `null` = no invoice (unsecured). */
  coverageBps: number | null;
  /** The annual cost-of-funds base in bps (default 400). */
  baseRateBps?: number;
}

export interface PriceComponents {
  costOfFundsBps: number;
  expectedLossBps: number;
  opsBps: number;
  capitalBps: number;
}

export interface LoanPrice {
  feeCents: bigint;
  aprBps: number;
  components: PriceComponents;
  /** APR above 3600 bps. */
  aprFlag: boolean;
}

/** round(n ÷ d), half-up, for non-negative bigints. */
function roundDiv(numerator: bigint, denominator: bigint): bigint {
  return (2n * numerator + denominator) / (2n * denominator);
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

export function totalBps(components: PriceComponents): number {
  return components.costOfFundsBps + components.expectedLossBps + components.opsBps + components.capitalBps;
}

/** APR bps = round(fee × 365 × 10000 ÷ (principal × term)), half-up on integers. */
export function aprBpsFor(feeCents: bigint, principalCents: bigint, termDays: number): number {
  return Number(roundDiv(feeCents * 365n * 10000n, principalCents * BigInt(termDays)));
}

export function priceLoan(input: PriceLoanInput): LoanPrice {
  const { principalCents, termDays, grade, coverageBps } = input;
  const baseRateBps = input.baseRateBps ?? BASE_RATE_BPS;
  if (principalCents <= 0n) {
    throw new Error(`priceLoan: principal must be positive, got ${principalCents.toString()}`);
  }
  if (!Number.isInteger(termDays) || termDays <= 0) {
    throw new Error(`priceLoan: term_days must be a positive integer, got ${termDays}`);
  }
  if (!Number.isInteger(baseRateBps) || baseRateBps < 0) {
    throw new Error(`priceLoan: base rate must be a non-negative integer of bps, got ${baseRateBps}`);
  }
  const pd = PD_BPS[grade];
  if (pd === undefined) {
    throw new Error(`priceLoan: grade ${String(grade)} is not priced (grade E always declines)`);
  }

  const covered = coverageBps !== null && coverageBps >= COVERED_MIN_COVERAGE_BPS;
  const lgd = covered ? LGD_BPS.invoiceCovered : LGD_BPS.unsecured;
  const components: PriceComponents = {
    costOfFundsBps: Number(roundDiv(BigInt(baseRateBps) * BigInt(termDays), 365n)),
    expectedLossBps: (pd * lgd) / 10000,
    opsBps: OPS_BPS,
    capitalBps: (CAPITAL_PCT_OF_PD_BPS * pd) / 10000,
  };

  const computed = ceilDiv(principalCents * BigInt(totalBps(components)), 10000n);
  const feeCents = computed < MIN_FEE_CENTS ? MIN_FEE_CENTS : computed;
  const aprBps = aprBpsFor(feeCents, principalCents, termDays);
  return { feeCents, aprBps, components, aprFlag: aprBps > APR_FLAG_THRESHOLD_BPS };
}
