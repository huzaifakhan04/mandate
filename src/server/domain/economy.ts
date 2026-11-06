import { intBetween, rngFor } from "../bots/rng";

/**
 * P5 Task 1: the world's simulated economy (pure; P5 Global Constraints,
 * "Base rate walk" and "Utilization"). One state per world per simulated
 * day, each computed from the day before with an RNG keyed by the world's
 * seed and the day — so the same seed always replays the same series, and
 * a day's draw never depends on how many other numbers were drawn.
 *
 * Base rate (annual bps): starts at 400. Each day
 *
 *   rate' = clamp(rate + step + reversion, 100, 1200)
 *   step      = uniform integer in −25..+25
 *   reversion = −10% × (rate − 400), rounded half away from zero
 *
 * Inflation: an annual rate (bps) that walks too — starts at 300, steps
 * −5..+5 a day, clamped to 200..600 (the plan's "2–6% a year"). The index
 * (bp, 10000 = 1.0000) grows each day by index × rate ÷ 365 ÷ 10000; the
 * whole bps are added and the fractional part is added as one more bp with
 * that probability (seeded), so the index never falls and its expected
 * growth is exactly the annual rate.
 *
 * Utilization = loans_receivable ÷ (cash_paypal + loans_receivable), bps.
 * Its premium on the cost of funds is 0 up to 50%, then linear to +600 bps
 * at 90%; above 90% new loans are declined (`pool_utilization_high`).
 */

export const BASE_RATE_START_BPS = 400;
export const BASE_RATE_MIN_BPS = 100;
export const BASE_RATE_MAX_BPS = 1200;
export const BASE_RATE_STEP_BPS = 25;
/** Mean reversion: 10% of the gap to 400 per day. */
export const BASE_RATE_REVERSION_PCT = 10;

export const INFLATION_INDEX_START_BP = 10000;
export const INFLATION_RATE_START_BPS = 300;
export const INFLATION_RATE_MIN_BPS = 200;
export const INFLATION_RATE_MAX_BPS = 600;
export const INFLATION_RATE_STEP_BPS = 5;

/** No premium at or below this utilization (bps). */
export const UTILIZATION_PREMIUM_FLOOR_BPS = 5000;
/** The premium's top (and the decline threshold: above this, no new loans). */
export const UTILIZATION_DECLINE_ABOVE_BPS = 9000;
export const UTILIZATION_PREMIUM_MAX_BPS = 600;

/** The day-to-day state the walk carries (the rest of `economy_state` is measured, not walked). */
export interface EconomyRates {
  baseRateBps: number;
  inflationIndexBp: number;
  /** The annual inflation rate in bps (the index's growth rate that day). */
  inflationRateBps: number;
}

export const ECONOMY_DEFAULTS: EconomyRates = {
  baseRateBps: BASE_RATE_START_BPS,
  inflationIndexBp: INFLATION_INDEX_START_BP,
  inflationRateBps: INFLATION_RATE_START_BPS,
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** −round(10% × (rate − 400)), half away from zero (symmetric above and below 400). */
export function meanReversionBps(rateBps: number): number {
  const gap = rateBps - BASE_RATE_START_BPS;
  const magnitude = Math.floor((Math.abs(gap) * BASE_RATE_REVERSION_PCT + 50) / 100);
  return magnitude === 0 ? 0 : gap > 0 ? -magnitude : magnitude;
}

/**
 * The rates for `simDay` from the previous day's. `seed` is the world's
 * seed (its bot seed, or its id). Pure and deterministic.
 */
export function stepRates(previous: EconomyRates, seed: string, simDay: number): EconomyRates {
  const rng = rngFor(seed, "economy", simDay);
  const step = intBetween(rng, -BASE_RATE_STEP_BPS, BASE_RATE_STEP_BPS);
  const baseRateBps = clamp(
    previous.baseRateBps + step + meanReversionBps(previous.baseRateBps),
    BASE_RATE_MIN_BPS,
    BASE_RATE_MAX_BPS,
  );
  const inflationRateBps = clamp(
    previous.inflationRateBps + intBetween(rng, -INFLATION_RATE_STEP_BPS, INFLATION_RATE_STEP_BPS),
    INFLATION_RATE_MIN_BPS,
    INFLATION_RATE_MAX_BPS,
  );
  // index × rate ÷ (365 × 10000): whole bps, plus one more with the remainder's probability.
  const numerator = previous.inflationIndexBp * inflationRateBps;
  const denominator = 365 * 10000;
  const whole = Math.floor(numerator / denominator);
  const extra = rng() * denominator < numerator % denominator ? 1 : 0;
  return { baseRateBps, inflationRateBps, inflationIndexBp: previous.inflationIndexBp + whole + extra };
}

/** The rates on `simDay` starting from day 0's defaults (test/replay helper; the service steps row by row). */
export function ratesSeries(seed: string, days: number): EconomyRates[] {
  const series: EconomyRates[] = [ECONOMY_DEFAULTS];
  for (let day = 1; day <= days; day += 1) {
    series.push(stepRates(series[day - 1]!, seed, day));
  }
  return series;
}

/** loans_receivable ÷ (cash + loans_receivable) in bps, floored, within 0..10000 (0 for an empty pool). */
export function utilizationBps(cashCents: bigint, loansReceivableCents: bigint): number {
  const loans = loansReceivableCents > 0n ? loansReceivableCents : 0n;
  const cash = cashCents > 0n ? cashCents : 0n;
  const pool = cash + loans;
  if (pool === 0n) {
    return 0;
  }
  return Number((loans * 10000n) / pool);
}

/**
 * The cost-of-funds premium (annual bps) for a utilization: 0 at or below
 * 50%, linear to 600 at 90% (rounded half-up), and held at 600 above it —
 * where new loans are declined anyway.
 */
export function utilizationPremiumBps(utilization: number): number {
  if (utilization <= UTILIZATION_PREMIUM_FLOOR_BPS) {
    return 0;
  }
  const capped = Math.min(utilization, UTILIZATION_DECLINE_ABOVE_BPS);
  const span = UTILIZATION_DECLINE_ABOVE_BPS - UTILIZATION_PREMIUM_FLOOR_BPS;
  return Math.floor(((capped - UTILIZATION_PREMIUM_FLOOR_BPS) * UTILIZATION_PREMIUM_MAX_BPS * 2 + span) / (2 * span));
}

/** Above 90% utilization new loans are declined. */
export function utilizationTooHigh(utilization: number): boolean {
  return utilization > UTILIZATION_DECLINE_ABOVE_BPS;
}

/** cash ÷ notes_payable in bps (0 when no notes are outstanding), capped at 1,000,000. */
export function reserveRatioBps(cashCents: bigint, notesPayableCents: bigint): number {
  if (notesPayableCents <= 0n) {
    return 0;
  }
  const cash = cashCents > 0n ? cashCents : 0n;
  const ratio = (cash * 10000n) / notesPayableCents;
  return ratio > 1_000_000n ? 1_000_000 : Number(ratio);
}

/**
 * Annualised return in bps: earned ÷ basis × 365 ÷ days × 10000, rounded
 * half-up toward +∞ on the magnitude; `null` without a basis or a holding period.
 */
export function annualisedReturnBps(earnedCents: bigint, basisCents: bigint, holdingDays: number): number | null {
  if (basisCents <= 0n || holdingDays <= 0) {
    return null;
  }
  const numerator = earnedCents * 365n * 10000n;
  const denominator = basisCents * BigInt(holdingDays);
  const sign = numerator < 0n ? -1n : 1n;
  const magnitude = (2n * (numerator * sign) + denominator) / (2n * denominator);
  return Number(sign * magnitude);
}
