import type { ReasonCode } from "./reasons";

/**
 * P5 Task 3: the treasury policy (pure; P5 Global Constraints, "Treasury
 * policy"). Three gates on new loans and one on redemptions, all in
 * integer cents and bps. The services gather the facts under the note
 * series lock (`apply_for_loan`, `accept_offer`, `redeem_notes`, the
 * tick's redemption queue) and these functions decide.
 *
 * Terms:
 * - available liquidity = cash − loans disbursing − pending redemptions −
 *   cash owed to borrowers (`domain/liquidity.ts`): the cash the bank can
 *   still commit.
 * - notes outstanding = notes_payable − pending redemptions (those are
 *   already taken out of available liquidity, so they are not counted
 *   twice). Queued redemptions are still owed, so they stay in it.
 * - reserve floor = ceil(notes outstanding × reserve_floor_bps ÷ 10000).
 *
 * Loan gates (only when the pool can fund the amount at all — otherwise
 * `insufficient_liquidity` alone says why):
 * - `reserve_floor`: available liquidity − queued redemptions − principal
 *   < the reserve floor. Queued redemptions are paid before any new loan.
 * - `concentration_limit`: the principal's exposure (outstanding principal
 *   across all its agents' open loans) + principal > concentration_bps of
 *   (total loans + available liquidity). Lending moves money from the
 *   liquidity to the loans, so the base doesn't change with the loan.
 * - `daily_budget_exhausted`: principal accepted today + principal >
 *   daily_budget_bps of the available liquidity at the start of the sim day
 *   (snapshotted on that day's `economy_state`). No snapshot yet → no
 *   budget gate (the world's economy hasn't started).
 *
 * Redemption gate: a redemption of `a` is paid now only if available
 * liquidity − a ≥ the reserve floor on the notes left after it (notes
 * outstanding − a). Otherwise it is queued (FIFO) and paid by the tick
 * once that holds for it.
 */

export interface TreasuryPolicy {
  /** Cash kept ≥ this share of notes outstanding (bps). */
  reserveFloorBps: number;
  /** One principal's exposure ≤ this share of total loans + available liquidity (bps). */
  concentrationBps: number;
  /** New principal per sim day ≤ this share of the day's starting available liquidity (bps). */
  dailyBudgetBps: number;
}

export const TREASURY_DEFAULTS: TreasuryPolicy = {
  reserveFloorBps: 1500,
  concentrationBps: 3000,
  dailyBudgetBps: 4000,
};

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  if (numerator <= 0n) {
    return 0n;
  }
  return (numerator + denominator - 1n) / denominator;
}

/** ceil(notes × bps ÷ 10000); 0 for no notes. */
export function reserveFloorCents(notesOutstandingCents: bigint, reserveFloorBps: number): bigint {
  return ceilDiv(notesOutstandingCents * BigInt(reserveFloorBps), 10000n);
}

/** floor(base × bps ÷ 10000); 0 for a non-positive base. */
export function shareOfCents(baseCents: bigint, bps: number): bigint {
  return baseCents <= 0n ? 0n : (baseCents * BigInt(bps)) / 10000n;
}

export interface LoanTreasuryFacts {
  policy: TreasuryPolicy;
  availableLiquidityCents: bigint;
  /** Σ queued redemptions (owed, not yet paid). */
  queuedRedemptionCents: bigint;
  /** notes_payable − pending redemptions. */
  notesOutstandingCents: bigint;
  /** The principal's outstanding principal across its agents' open loans (before this one). */
  principalExposureCents: bigint;
  /** loans_receivable + Σ disbursing principal. */
  totalLoansCents: bigint;
  /** Available liquidity at the start of the sim day; `null` → no budget gate. */
  dayStartLiquidityCents: bigint | null;
  /** Principal of loans accepted earlier this sim day. */
  budgetUsedCents: bigint;
}

export interface LoanTreasuryLimits {
  reserveFloorCents: bigint;
  /** The most new principal the floor allows (≥ 0). */
  floorHeadroomCents: bigint;
  concentrationCapCents: bigint;
  /** `null` without a day-start snapshot. */
  dailyBudgetCents: bigint | null;
}

export function loanTreasuryLimits(facts: LoanTreasuryFacts): LoanTreasuryLimits {
  const floor = reserveFloorCents(facts.notesOutstandingCents, facts.policy.reserveFloorBps);
  const headroom = facts.availableLiquidityCents - facts.queuedRedemptionCents - floor;
  return {
    reserveFloorCents: floor,
    floorHeadroomCents: headroom > 0n ? headroom : 0n,
    concentrationCapCents: shareOfCents(facts.totalLoansCents + facts.availableLiquidityCents, facts.policy.concentrationBps),
    dailyBudgetCents:
      facts.dayStartLiquidityCents === null ? null : shareOfCents(facts.dayStartLiquidityCents, facts.policy.dailyBudgetBps),
  };
}

/** The treasury reasons a loan of `principalCents` fails, in pipeline order. */
export function loanTreasuryReasons(facts: LoanTreasuryFacts, principalCents: bigint): ReasonCode[] {
  if (principalCents > facts.availableLiquidityCents) {
    return []; // `insufficient_liquidity` already says why.
  }
  const limits = loanTreasuryLimits(facts);
  const reasons: ReasonCode[] = [];
  if (principalCents > limits.floorHeadroomCents) {
    reasons.push("reserve_floor");
  }
  if (facts.principalExposureCents + principalCents > limits.concentrationCapCents) {
    reasons.push("concentration_limit");
  }
  if (limits.dailyBudgetCents !== null && facts.budgetUsedCents + principalCents > limits.dailyBudgetCents) {
    reasons.push("daily_budget_exhausted");
  }
  return reasons;
}

/**
 * Whether a redemption of `amountCents` can be paid now: available liquidity
 * − amount ≥ the reserve floor on the notes left after it.
 */
export function redemptionPayable(
  availableLiquidityCents: bigint,
  notesOutstandingCents: bigint,
  amountCents: bigint,
  reserveFloorBps: number,
): boolean {
  const after = availableLiquidityCents - amountCents;
  if (after < 0n) {
    return false;
  }
  return after >= reserveFloorCents(notesOutstandingCents - amountCents, reserveFloorBps);
}

/**
 * Redemption statuses whose units are still reserved against the holder's
 * position: `pending` (payout enqueued or in flight) and, P5 Task 3,
 * `queued` (gated by the reserve floor, not paid yet). Both count against
 * the redeemable balance and, for Ruling P4-D, defer a charge-off's loss
 * share on those units.
 */
export const OPEN_REDEMPTION_STATUSES = ["pending", "queued"] as const;
