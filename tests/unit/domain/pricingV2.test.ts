import { describe, expect, it } from "vitest";

import { MIN_FEE_CENTS, priceLoan } from "@/server/domain/pricingV2";

/**
 * Pricing v2 goldens (P3 Global Constraints, "Pricing v2"; Review Focus 4).
 * Every number below is hand-computed:
 *
 *   cost of funds = round(400 × term ÷ 365)            (bps of principal for the term)
 *   expected loss = PD × LGD ÷ 10000                   (PD A 100, B 300, C 600, D 1200 bps;
 *                                                       LGD 6000 unsecured, 3500 if coverage ≥ 1.1)
 *   ops           = 50
 *   capital       = 800 × PD ÷ 10000                   (8% × PD)
 *   fee           = max(25, ceil(P × Σ ÷ 10000))
 *   APR bps       = round(fee ÷ P × 365 ÷ term × 10000)
 */
describe("priceLoan (pricing v2)", () => {
  it("golden (10000, 14 days, B, unsecured) → fee 269, APR 7013", () => {
    // CoF round(400×14/365 = 15.34) = 15; EL 300×6000/10000 = 180; ops 50; capital 800×300/10000 = 24.
    // Σ = 269 bps → fee ceil(10000 × 269 / 10000) = 269.
    // APR = 269/10000 × 365/14 × 10000 = 7013.2 → 7013 (> 3600 → flagged).
    expect(priceLoan({ principalCents: 10000n, termDays: 14, grade: "B", coverageBps: null })).toEqual({
      feeCents: 269n,
      aprBps: 7013,
      components: { costOfFundsBps: 15, expectedLossBps: 180, opsBps: 50, capitalBps: 24 },
      aprFlag: true,
      baseRateBps: 400,
      utilizationPremiumBps: 0,
    });
  });

  it("golden (10000, 14 days, B, invoice 1.5×) → fee 194, APR 5058", () => {
    // EL 300×3500/10000 = 105 (invoice-covered LGD 35%); Σ = 15 + 105 + 50 + 24 = 194 → fee 194.
    // APR = 194 × 365 / 14 = 5057.86 → 5058.
    expect(priceLoan({ principalCents: 10000n, termDays: 14, grade: "B", coverageBps: 15000 })).toEqual({
      feeCents: 194n,
      aprBps: 5058,
      components: { costOfFundsBps: 15, expectedLossBps: 105, opsBps: 50, capitalBps: 24 },
      aprFlag: true,
      baseRateBps: 400,
      utilizationPremiumBps: 0,
    });
  });

  it("golden (1000, 7 days, A, invoice) → the 25-cent minimum fee (Review Focus 4)", () => {
    // CoF round(400×7/365 = 7.67) = 8; EL 100×3500/10000 = 35; ops 50; capital 800×100/10000 = 8.
    // Σ = 101 → ceil(1000 × 101 / 10000 = 10.1) = 11 < 25 → fee 25.
    // APR = 25/1000 × 365/7 × 10000 = 13035.7 → 13036.
    expect(priceLoan({ principalCents: 1000n, termDays: 7, grade: "A", coverageBps: 15000 })).toEqual({
      feeCents: 25n,
      aprBps: 13036,
      components: { costOfFundsBps: 8, expectedLossBps: 35, opsBps: 50, capitalBps: 8 },
      aprFlag: true,
      baseRateBps: 400,
      utilizationPremiumBps: 0,
    });
    expect(MIN_FEE_CENTS).toBe(25n);
  });

  it("golden (50000, 30 days, D, no collateral) → fee 4495 (899 bps — over a 500-bps mandate cap)", () => {
    // CoF round(400×30/365 = 32.88) = 33; EL 1200×6000/10000 = 720; ops 50; capital 800×1200/10000 = 96.
    // Σ = 899 → fee ceil(50000 × 899 / 10000) = 4495.
    // APR = 4495/50000 × 365/30 × 10000 = 10937.8 → 10938.
    expect(priceLoan({ principalCents: 50000n, termDays: 30, grade: "D", coverageBps: null })).toEqual({
      feeCents: 4495n,
      aprBps: 10938,
      components: { costOfFundsBps: 33, expectedLossBps: 720, opsBps: 50, capitalBps: 96 },
      aprFlag: true,
      baseRateBps: 400,
      utilizationPremiumBps: 0,
    });
  });

  it("the newcomer's invoice-backed starter loan (1000, 7 days, D, invoice 1.5×) → fee 58", () => {
    // EL 1200×3500/10000 = 420; Σ = 8 + 420 + 50 + 96 = 574 → ceil(57.4) = 58.
    // APR = 58 × 365 × 10000 / (1000 × 7) = 30242.9 → 30243.
    expect(priceLoan({ principalCents: 1000n, termDays: 7, grade: "D", coverageBps: 15000 })).toMatchObject({
      feeCents: 58n,
      aprBps: 30243,
    });
  });

  it("coverage below 1.1× prices as unsecured; exactly 1.1× is covered", () => {
    const at = (coverageBps: number | null) =>
      priceLoan({ principalCents: 10000n, termDays: 14, grade: "C", coverageBps }).components.expectedLossBps;
    expect(at(null)).toBe(360); // 600 × 6000 / 10000
    expect(at(10999)).toBe(360);
    expect(at(11000)).toBe(210); // 600 × 3500 / 10000
  });

  it("the base rate is a parameter (P5 makes it dynamic)", () => {
    // round(800 × 14 / 365 = 30.68) = 31.
    const price = priceLoan({ principalCents: 10000n, termDays: 14, grade: "B", coverageBps: null, baseRateBps: 800 });
    expect(price.components.costOfFundsBps).toBe(31);
    expect(price.feeCents).toBe(285n); // 31 + 180 + 50 + 24
  });

  it("P5: the utilization premium adds to the base in the cost of funds", () => {
    // round((400 + 300) × 14 / 365 = 26.85) = 27; Σ = 27 + 180 + 50 + 24 = 281 → fee 281.
    const price = priceLoan({ principalCents: 10000n, termDays: 14, grade: "B", coverageBps: null, utilizationPremiumBps: 300 });
    expect(price).toMatchObject({ feeCents: 281n, baseRateBps: 400, utilizationPremiumBps: 300 });
    expect(price.components.costOfFundsBps).toBe(27);
  });

  it("P5: the newcomer loan stays 58 at 400 bps and no premium; 59 at the 600 bps premium cap", () => {
    expect(priceLoan({ principalCents: 1000n, termDays: 7, grade: "D", coverageBps: 15000, baseRateBps: 400, utilizationPremiumBps: 0 }).feeCents).toBe(58n);
    // round(1000 × 7 / 365 = 19.18) = 19; Σ = 19 + 420 + 50 + 96 = 585 → ceil(58.5) = 59.
    expect(priceLoan({ principalCents: 1000n, termDays: 7, grade: "D", coverageBps: 15000, utilizationPremiumBps: 600 }).feeCents).toBe(59n);
  });

  it("P5: rejects a negative or fractional utilization premium", () => {
    expect(() => priceLoan({ principalCents: 1000n, termDays: 7, grade: "A", coverageBps: null, utilizationPremiumBps: -1 })).toThrow();
    expect(() => priceLoan({ principalCents: 1000n, termDays: 7, grade: "A", coverageBps: null, utilizationPremiumBps: 1.5 })).toThrow();
  });

  it("rounds the fee up once, at the end, on integers", () => {
    // Σ 269 bps on 10001 cents = 269.0269 → 270.
    expect(priceLoan({ principalCents: 10001n, termDays: 14, grade: "B", coverageBps: null }).feeCents).toBe(270n);
  });

  it("an APR at or below 3600 bps is not flagged", () => {
    // A, 30 days, covered: 33 + 35 + 50 + 8 = 126 bps → fee 630 on 50000; APR 630/50000 × 365/30 × 10000 = 1533.
    const price = priceLoan({ principalCents: 50000n, termDays: 30, grade: "A", coverageBps: 20000 });
    expect(price).toMatchObject({ feeCents: 630n, aprBps: 1533, aprFlag: false });
  });

  it("is deterministic and integer-only", () => {
    const args = { principalCents: 12345n, termDays: 19, grade: "C" as const, coverageBps: 12000 };
    const first = priceLoan(args);
    expect(priceLoan(args)).toEqual(first);
    expect(typeof first.feeCents).toBe("bigint");
    for (const value of [first.aprBps, ...Object.values(first.components)]) {
      expect(Number.isInteger(value)).toBe(true);
    }
  });

  it("rejects a non-positive principal or term", () => {
    expect(() => priceLoan({ principalCents: 0n, termDays: 14, grade: "A", coverageBps: null })).toThrow();
    expect(() => priceLoan({ principalCents: 1000n, termDays: 0, grade: "A", coverageBps: null })).toThrow();
  });
});
