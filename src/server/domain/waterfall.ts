/**
 * The P1 repayment waterfall (pure): a gross payment pays the outstanding
 * fee first, then the outstanding principal; anything left over is a
 * remainder owed back to the borrower (an invoice paid in full by the
 * borrower's client usually exceeds P + F). P1 has no late fees.
 *
 * `principalCents` / `feeCents` are what is still OUTSTANDING when the
 * payment lands, not the loan's original terms — for a loan already
 * repaid both are 0 and the whole gross is remainder.
 *
 * - `shortfall` = what is still owed after this payment (`> 0` → the
 *   loan stays ACTIVE with a reduced outstanding balance);
 * - `remainder` = `gross − principal − fee` once nothing is owed.
 *
 * Invariants: `principal + fee + remainder = gross` and
 * `principal + fee + shortfall = principalCents + feeCents`.
 */
export interface WaterfallInput {
  grossCents: bigint;
  principalCents: bigint;
  feeCents: bigint;
}

export interface WaterfallResult {
  principal: bigint;
  fee: bigint;
  remainder: bigint;
  shortfall: bigint;
}

function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

export function waterfall({ grossCents, principalCents, feeCents }: WaterfallInput): WaterfallResult {
  if (grossCents < 0n || principalCents < 0n || feeCents < 0n) {
    throw new RangeError("waterfall: amounts must be non-negative");
  }
  const fee = min(grossCents, feeCents);
  const principal = min(grossCents - fee, principalCents);
  return {
    principal,
    fee,
    remainder: grossCents - fee - principal,
    shortfall: principalCents + feeCents - fee - principal,
  };
}

/** Note holders' share of a collected fee: floor(fee × 80 / 100); the bank keeps the rest. */
export const HOLDERS_SHARE_PERCENT = 80n;

export function holdersShare(feeCents: bigint): bigint {
  if (feeCents < 0n) {
    throw new RangeError("holdersShare: fee must be non-negative");
  }
  return (feeCents * HOLDERS_SHARE_PERCENT) / 100n;
}
