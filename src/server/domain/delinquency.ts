/**
 * The delinquency ladder (P4 Global Constraints, "Ladder") as pure rules.
 * Sim days after `due_sim_at`, for a funded loan that still owes:
 *
 * | Day | Step          | Effect                                                              |
 * |-----|---------------|---------------------------------------------------------------------|
 * | +1  | `late`        | status LATE; late fee min(500, max(100, 5% × outstanding principal)) |
 * | +3  | `penalty`     | rate penalty starts: ceil(principal × 200 bps × days late ÷ 365)     |
 * | +7  | `substandard` | status SUBSTANDARD; the agent is restricted, the mandate frozen      |
 * | +10 | `charged_off` | status CHARGED_OFF; written off, holders share the loss, guarantee   |
 *
 * The penalty stops accruing at the charge-off day. The services (`services/collections.ts`)
 * apply each step exactly once; this file only decides amounts and order.
 */

const DAY_MS = 86_400_000;

export type LadderStep = "late" | "penalty" | "substandard" | "charged_off";

/** The steps in the order they must be applied, with their day offsets after the due date. */
export const LADDER: ReadonlyArray<{ step: LadderStep; day: number }> = [
  { step: "late", day: 1 },
  { step: "penalty", day: 3 },
  { step: "substandard", day: 7 },
  { step: "charged_off", day: 10 },
];

/** P4 Task 2: the charge-off day; the rate penalty accrues through this day at most. */
export const CHARGE_OFF_DAY = 10;

/** Days late the penalty accrues through at `simNow`: days late, capped at the charge-off day. */
export function penaltyDays(dueSimAt: Date, simNow: Date): number {
  return Math.min(daysLate(dueSimAt, simNow), CHARGE_OFF_DAY);
}

export const LATE_FEE_MIN_CENTS = 100n;
export const LATE_FEE_MAX_CENTS = 500n;
export const LATE_FEE_PERCENT = 5n;
export const PENALTY_RATE_BPS = 200n;
/**
 * Final fix (minor a): once the base principal + fee are fully paid, late
 * fees + penalty left at or below this are waived and the loan cures — a
 * cent of penalty accrued between a quote and its capture never keeps a
 * loan delinquent.
 */
export const SMALL_BALANCE_WAIVER_CENTS = 100n;
/** Score history entry recorded at the `late` step (the scorecard's late-repayment penalty). */
export const LATE_SCORE_DELTA = -15;

/** Whole sim days `simNow` is past `dueSimAt` (0 on or before the due date). */
export function daysLate(dueSimAt: Date, simNow: Date): number {
  const days = Math.floor((simNow.getTime() - dueSimAt.getTime()) / DAY_MS);
  return days > 0 ? days : 0;
}

/** The sim time a step falls due: `dueSimAt` + its day offset. */
export function stepDueAt(dueSimAt: Date, step: LadderStep): Date {
  const entry = LADDER.find((candidate) => candidate.step === step)!;
  return new Date(dueSimAt.getTime() + entry.day * DAY_MS);
}

/** The step applied before `step` (`null` for the first). */
export function previousStep(step: LadderStep): LadderStep | null {
  const index = LADDER.findIndex((candidate) => candidate.step === step);
  return index > 0 ? LADDER[index - 1]!.step : null;
}

/** The steps due at `days` late that come after `applied` (the loan's last applied step), in order. */
export function dueSteps(applied: string | null, days: number): LadderStep[] {
  const start = applied === null ? 0 : LADDER.findIndex((candidate) => candidate.step === applied) + 1;
  if (start <= 0 && applied !== null) {
    return []; // An unknown step: nothing here applies.
  }
  return LADDER.slice(start)
    .filter((candidate) => candidate.day <= days)
    .map((candidate) => candidate.step);
}

/** Late fee: min(500, max(100, floor(5% × outstanding principal))) cents. */
export function lateFeeCents(outstandingPrincipalCents: bigint): bigint {
  const pct = (outstandingPrincipalCents * LATE_FEE_PERCENT) / 100n;
  const floored = pct < LATE_FEE_MIN_CENTS ? LATE_FEE_MIN_CENTS : pct;
  return floored > LATE_FEE_MAX_CENTS ? LATE_FEE_MAX_CENTS : floored;
}

/** ceil(principal × 200 bps × days ÷ 365) cents (0 for no principal or no days). */
export function penaltyFor(principalCents: bigint, days: number): bigint {
  if (principalCents <= 0n || days <= 0) {
    return 0n;
  }
  const numerator = principalCents * PENALTY_RATE_BPS * BigInt(days);
  const denominator = 10000n * 365n;
  return (numerator + denominator - 1n) / denominator;
}

/**
 * The penalty to add when accrual moves from `fromDays` to `toDays` late
 * on the CURRENT outstanding principal: penaltyFor(P, to) − penaltyFor(P,
 * from). With a constant principal the running total is exactly
 * `penaltyFor(P, days late)`; after a partial repayment later days accrue
 * on the smaller principal. Never negative.
 */
export function penaltyIncrement(principalCents: bigint, fromDays: number, toDays: number): bigint {
  if (toDays <= fromDays) {
    return 0n;
  }
  const delta = penaltyFor(principalCents, toDays) - penaltyFor(principalCents, fromDays);
  return delta > 0n ? delta : 0n;
}
