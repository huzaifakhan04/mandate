import { describe, expect, it } from "vitest";

import {
  annualisedReturnBps,
  BASE_RATE_MAX_BPS,
  BASE_RATE_MIN_BPS,
  ECONOMY_DEFAULTS,
  meanReversionBps,
  ratesSeries,
  reserveRatioBps,
  stepRates,
  utilizationBps,
  utilizationPremiumBps,
  utilizationTooHigh,
} from "@/server/domain/economy";

/** P5 Task 1: the seeded base-rate walk, inflation index and utilization curve (pure). */
describe("economy walk (P5 Task 1)", () => {
  it("is deterministic: the same seed gives the same 60-day series; another seed differs", () => {
    const a = ratesSeries("seed-a", 60);
    expect(ratesSeries("seed-a", 60)).toEqual(a);
    expect(a).toHaveLength(61);
    expect(a[0]).toEqual(ECONOMY_DEFAULTS);
    expect(ratesSeries("seed-b", 60)).not.toEqual(a);
  });

  it("a day depends only on the previous day, the seed and the day number", () => {
    const series = ratesSeries("seed-a", 30);
    expect(stepRates(series[29]!, "seed-a", 30)).toEqual(series[30]);
  });

  it("each day moves by at most ±25 plus the mean reversion, and stays within 100..1200", () => {
    for (const seed of ["s1", "s2", "s3", "s4"]) {
      const series = ratesSeries(seed, 365);
      for (let day = 1; day < series.length; day += 1) {
        const prev = series[day - 1]!.baseRateBps;
        const next = series[day]!.baseRateBps;
        const unclamped = next - prev - meanReversionBps(prev);
        expect(next).toBeGreaterThanOrEqual(BASE_RATE_MIN_BPS);
        expect(next).toBeLessThanOrEqual(BASE_RATE_MAX_BPS);
        if (next > BASE_RATE_MIN_BPS && next < BASE_RATE_MAX_BPS) {
          expect(Math.abs(unclamped)).toBeLessThanOrEqual(25);
        }
      }
    }
  });

  it("mean reversion is −10% of the gap to 400 (half away from zero)", () => {
    expect(meanReversionBps(400)).toBe(0);
    expect(meanReversionBps(1000)).toBe(-60);
    expect(meanReversionBps(200)).toBe(20);
    expect(meanReversionBps(405)).toBe(-1); // 0.5 → 1
    expect(meanReversionBps(395)).toBe(1);
    expect(meanReversionBps(404)).toBe(0);
  });

  it("clamps: from the top it can't go above 1200 and is pulled down; from the bottom it can't go below 100", () => {
    for (let day = 1; day <= 50; day += 1) {
      const fromTop = stepRates({ ...ECONOMY_DEFAULTS, baseRateBps: 1200 }, "clamp", day).baseRateBps;
      // −80 reversion, step ≤ +25 → at most 1145.
      expect(fromTop).toBeLessThanOrEqual(1145);
      const fromBottom = stepRates({ ...ECONOMY_DEFAULTS, baseRateBps: 100 }, "clamp", day).baseRateBps;
      // +30 reversion, step ≥ −25 → at least 105.
      expect(fromBottom).toBeGreaterThanOrEqual(105);
    }
    // Stepping from beyond the bounds clamps.
    expect(stepRates({ ...ECONOMY_DEFAULTS, baseRateBps: 5000 }, "clamp", 1).baseRateBps).toBe(BASE_RATE_MAX_BPS);
    expect(stepRates({ ...ECONOMY_DEFAULTS, baseRateBps: -5000 }, "clamp", 1).baseRateBps).toBe(BASE_RATE_MIN_BPS);
  });

  it("mean-reverts: a 900 bps start comes back near 400 within 60 days", () => {
    let rates = { ...ECONOMY_DEFAULTS, baseRateBps: 900 };
    for (let day = 1; day <= 60; day += 1) {
      rates = stepRates(rates, "revert", day);
    }
    // Stationary band of the walk: ±25 steps against 10% reversion stays well inside ±150.
    expect(Math.abs(rates.baseRateBps - 400)).toBeLessThan(150);
  });

  it("inflation: the index never falls, the annual rate stays in 2–6%, and a year grows the index by 2–6%", () => {
    for (const seed of ["i1", "i2", "i3"]) {
      const series = ratesSeries(seed, 365);
      for (let day = 1; day < series.length; day += 1) {
        expect(series[day]!.inflationIndexBp).toBeGreaterThanOrEqual(series[day - 1]!.inflationIndexBp);
        expect(series[day]!.inflationRateBps).toBeGreaterThanOrEqual(200);
        expect(series[day]!.inflationRateBps).toBeLessThanOrEqual(600);
      }
      const yearGrowth = series[365]!.inflationIndexBp - 10000;
      expect(yearGrowth).toBeGreaterThanOrEqual(200);
      expect(yearGrowth).toBeLessThanOrEqual(600);
    }
  });
});

describe("utilization and its premium (P5 Task 1)", () => {
  it("utilization = loans ÷ (cash + loans) in bps, floored; 0 for an empty pool", () => {
    expect(utilizationBps(0n, 0n)).toBe(0);
    expect(utilizationBps(10000n, 0n)).toBe(0);
    expect(utilizationBps(3000n, 7000n)).toBe(7000);
    expect(utilizationBps(0n, 5000n)).toBe(10000);
    expect(utilizationBps(2n, 1n)).toBe(3333);
  });

  it("premium curve: ≤ 50% → 0, 70% → 300, 90% → 600, linear between", () => {
    expect(utilizationPremiumBps(0)).toBe(0);
    expect(utilizationPremiumBps(5000)).toBe(0);
    expect(utilizationPremiumBps(5001)).toBe(0); // 0.15 → 0
    expect(utilizationPremiumBps(6000)).toBe(150);
    expect(utilizationPremiumBps(7000)).toBe(300);
    expect(utilizationPremiumBps(8000)).toBe(450);
    expect(utilizationPremiumBps(9000)).toBe(600);
    expect(utilizationPremiumBps(9500)).toBe(600);
  });

  it("declines strictly above 90%", () => {
    expect(utilizationTooHigh(9000)).toBe(false);
    expect(utilizationTooHigh(9001)).toBe(true);
  });

  it("reserve ratio = cash ÷ notes payable (0 without notes)", () => {
    expect(reserveRatioBps(1500n, 10000n)).toBe(1500);
    expect(reserveRatioBps(1500n, 0n)).toBe(0);
  });

  it("annualised return: earned ÷ basis × 365 ÷ days", () => {
    // 100 on 10000 over 30 days = 1% × 365/30 = 12.17% → 1217.
    expect(annualisedReturnBps(100n, 10000n, 30)).toBe(1217);
    expect(annualisedReturnBps(0n, 10000n, 30)).toBe(0);
    expect(annualisedReturnBps(100n, 0n, 30)).toBeNull();
    expect(annualisedReturnBps(100n, 10000n, 0)).toBeNull();
  });
});
