/**
 * The repayment waterfall (pure). P1: a gross payment pays the outstanding
 * fee first, then the outstanding principal; anything left over is a
 * remainder owed back to the borrower (an invoice paid in full by the
 * borrower's client usually exceeds P + F). P4 (collections) puts the
 * delinquency charges in front: late fees → rate penalty → fee →
 * principal → remainder.
 *
 * Every input is what is still OUTSTANDING when the payment lands, not
 * the loan's original terms — for a loan already repaid all are 0 and the
 * whole gross is remainder.
 *
 * - `shortfall` = what is still owed after this payment (`> 0` → the
 *   loan stays open with a reduced balance);
 * - `remainder` = what is left once nothing is owed.
 *
 * Invariants: `lateFee + penalty + fee + principal + remainder = gross`
 * and `lateFee + penalty + fee + principal + shortfall` = everything owed.
 */
export interface WaterfallInput {
  grossCents: bigint;
  principalCents: bigint;
  feeCents: bigint;
  /** P4: late fees outstanding (default 0). */
  lateFeeCents?: bigint;
  /** P4: rate penalty outstanding (default 0). */
  penaltyCents?: bigint;
}

export interface WaterfallResult {
  lateFee: bigint;
  penalty: bigint;
  fee: bigint;
  principal: bigint;
  remainder: bigint;
  shortfall: bigint;
}

function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

export function waterfall({
  grossCents,
  principalCents,
  feeCents,
  lateFeeCents = 0n,
  penaltyCents = 0n,
}: WaterfallInput): WaterfallResult {
  if (grossCents < 0n || principalCents < 0n || feeCents < 0n || lateFeeCents < 0n || penaltyCents < 0n) {
    throw new RangeError("waterfall: amounts must be non-negative");
  }
  let left = grossCents;
  const lateFee = min(left, lateFeeCents);
  left -= lateFee;
  const penalty = min(left, penaltyCents);
  left -= penalty;
  const fee = min(left, feeCents);
  left -= fee;
  const principal = min(left, principalCents);
  left -= principal;
  const owed = lateFeeCents + penaltyCents + feeCents + principalCents;
  return {
    lateFee,
    penalty,
    fee,
    principal,
    remainder: left,
    shortfall: owed - lateFee - penalty - fee - principal,
  };
}

/**
 * Note holders' share of a collected fee: floor(fee × 80 / 100); the bank
 * keeps the rest. P4: only the loan's base fee is shared — late fees and
 * the rate penalty are the bank's (`late_fee_income` / `penalty_income`).
 */
export const HOLDERS_SHARE_PERCENT = 80n;

export function holdersShare(feeCents: bigint): bigint {
  if (feeCents < 0n) {
    throw new RangeError("holdersShare: fee must be non-negative");
  }
  return (feeCents * HOLDERS_SHARE_PERCENT) / 100n;
}
