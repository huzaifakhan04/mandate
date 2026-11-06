import { LGD_BPS, PD_BPS, type PricedGrade } from "./pricingV2";

/**
 * P5 Task 2 — the CECL-style allowance for expected losses (pure).
 *
 * A loan's expected loss is its outstanding principal × PD(grade at offer)
 * × LGD(collateral at offer). The offer's disclosure already carries that
 * product: `rate_components.expected_loss_bps` = PD × LGD ÷ 10000, exact
 * whole bps by construction (`pricingV2.ts`), so it is the loan's
 * expected-loss rate as quoted — the grade and the collateral as they were
 * at offer time, never re-scored. A late or substandard loan reserves
 * twice that (`CECL_DELINQUENT_MULTIPLIER`), capped at its outstanding
 * principal. Integer math, rounded half-up per loan.
 */

export const CECL_DELINQUENT_MULTIPLIER = 2n;

/** Statuses whose reserve is doubled. */
export const CECL_DELINQUENT_DB_STATUSES = ["late", "substandard"] as const;

/** The most conservative priced rate (grade D, unsecured) — for a legacy offer with no rate components. */
export const CECL_FALLBACK_EXPECTED_LOSS_BPS = (PD_BPS.D * LGD_BPS.unsecured) / 10000;

/**
 * The expected-loss rate (bps of principal) an offer was priced at, from
 * its stored disclosure: `rate_components.expected_loss_bps`, else PD of
 * `credit_grade` × the unsecured LGD, else grade D unsecured.
 */
export function expectedLossBpsAtOffer(disclosure: unknown): number {
  if (disclosure && typeof disclosure === "object") {
    const record = disclosure as Record<string, unknown>;
    const components = record.rate_components;
    if (components && typeof components === "object") {
      const el = (components as Record<string, unknown>).expected_loss_bps;
      if (typeof el === "number" && Number.isInteger(el) && el >= 0 && el <= 10000) {
        return el;
      }
    }
    const grade = record.credit_grade;
    if (typeof grade === "string" && grade in PD_BPS) {
      return (PD_BPS[grade as PricedGrade] * LGD_BPS.unsecured) / 10000;
    }
  }
  return CECL_FALLBACK_EXPECTED_LOSS_BPS;
}

export interface CeclLoanInput {
  outstandingPrincipalCents: bigint;
  expectedLossBps: number;
  /** Late or substandard: the reserve is doubled. */
  delinquent: boolean;
}

/** One loan's reserve: round_half_up(principal × EL bps × (2 if delinquent) ÷ 10000), capped at the principal. */
export function ceclLoanCents(input: CeclLoanInput): bigint {
  const principal = input.outstandingPrincipalCents;
  if (principal <= 0n) {
    return 0n;
  }
  if (!Number.isInteger(input.expectedLossBps) || input.expectedLossBps < 0) {
    throw new Error(`ceclLoanCents: expected loss must be a non-negative integer of bps, got ${input.expectedLossBps}`);
  }
  const multiplier = input.delinquent ? CECL_DELINQUENT_MULTIPLIER : 1n;
  const numerator = principal * BigInt(input.expectedLossBps) * multiplier;
  const reserve = (2n * numerator + 10000n) / 20000n;
  return reserve < principal ? reserve : principal;
}

export function isCeclDelinquentStatus(status: string): boolean {
  return (CECL_DELINQUENT_DB_STATUSES as readonly string[]).includes(status);
}

/**
 * The allowance a charge-off releases for the loan: its own reserve, but
 * never more than the pooled allowance actually holds (≥ 0) nor the
 * principal written off. The charge-off provisions only the shortfall,
 * P − release, so the allowance stays ≥ 0 after the write-off.
 */
export function chargeOffRelease(loanReserveCents: bigint, allowanceCents: bigint, principalCents: bigint): bigint {
  let release = loanReserveCents;
  if (allowanceCents < release) {
    release = allowanceCents;
  }
  if (principalCents < release) {
    release = principalCents;
  }
  return release > 0n ? release : 0n;
}
