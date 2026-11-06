import { describe, expect, it } from "vitest";

import { holdersShare, waterfall } from "@/server/domain/waterfall";

describe("waterfall (fee first, then principal, then remainder)", () => {
  it("golden: invoice 40000 against P 25000 + F 750 → REPAID, remainder 14250", () => {
    expect(waterfall({ grossCents: 40000n, principalCents: 25000n, feeCents: 750n })).toEqual({
      lateFee: 0n,
      penalty: 0n,
      principal: 25000n,
      fee: 750n,
      remainder: 14250n,
      shortfall: 0n,
    });
  });

  it("exact payoff → no remainder, no shortfall", () => {
    expect(waterfall({ grossCents: 25750n, principalCents: 25000n, feeCents: 750n })).toEqual({
      lateFee: 0n,
      penalty: 0n,
      principal: 25000n,
      fee: 750n,
      remainder: 0n,
      shortfall: 0n,
    });
  });

  it("partial 10000 → fee 750 paid first, principal 9250, shortfall 15750", () => {
    expect(waterfall({ grossCents: 10000n, principalCents: 25000n, feeCents: 750n })).toEqual({
      lateFee: 0n,
      penalty: 0n,
      principal: 9250n,
      fee: 750n,
      remainder: 0n,
      shortfall: 15750n,
    });
  });

  it("a payment smaller than the fee goes entirely to the fee", () => {
    expect(waterfall({ grossCents: 500n, principalCents: 25000n, feeCents: 750n })).toEqual({
      lateFee: 0n,
      penalty: 0n,
      principal: 0n,
      fee: 500n,
      remainder: 0n,
      shortfall: 25250n,
    });
  });

  it("a 1-cent fee", () => {
    expect(waterfall({ grossCents: 1001n, principalCents: 1000n, feeCents: 1n })).toEqual({
      lateFee: 0n,
      penalty: 0n,
      principal: 1000n,
      fee: 1n,
      remainder: 0n,
      shortfall: 0n,
    });
    expect(waterfall({ grossCents: 1n, principalCents: 1000n, feeCents: 1n })).toEqual({
      lateFee: 0n,
      penalty: 0n,
      principal: 0n,
      fee: 1n,
      remainder: 0n,
      shortfall: 1000n,
    });
  });

  it("nothing owed (already repaid) → the whole gross is remainder", () => {
    expect(waterfall({ grossCents: 40000n, principalCents: 0n, feeCents: 0n })).toEqual({
      lateFee: 0n,
      penalty: 0n,
      principal: 0n,
      fee: 0n,
      remainder: 40000n,
      shortfall: 0n,
    });
  });

  it("parts always sum to gross", () => {
    for (const [g, p, f] of [
      [0n, 100n, 5n],
      [3n, 100n, 5n],
      [104n, 100n, 5n],
      [105n, 100n, 5n],
      [999n, 100n, 5n],
    ] as const) {
      const r = waterfall({ grossCents: g, principalCents: p, feeCents: f });
      expect(r.principal + r.fee + r.remainder).toBe(g);
      expect(r.principal + r.fee + r.shortfall).toBe(p + f);
    }
  });

  it("P4: late fees, then penalty, then fee, then principal, then remainder", () => {
    const owed = { principalCents: 25000n, feeCents: 333n, lateFeeCents: 500n, penaltyCents: 7n };
    expect(waterfall({ grossCents: 300n, ...owed })).toEqual({
      lateFee: 300n,
      penalty: 0n,
      fee: 0n,
      principal: 0n,
      remainder: 0n,
      shortfall: 25540n,
    });
    expect(waterfall({ grossCents: 505n, ...owed })).toEqual({
      lateFee: 500n,
      penalty: 5n,
      fee: 0n,
      principal: 0n,
      remainder: 0n,
      shortfall: 25335n,
    });
    expect(waterfall({ grossCents: 1000n, ...owed })).toEqual({
      lateFee: 500n,
      penalty: 7n,
      fee: 333n,
      principal: 160n,
      remainder: 0n,
      shortfall: 24840n,
    });
    expect(waterfall({ grossCents: 26000n, ...owed })).toEqual({
      lateFee: 500n,
      penalty: 7n,
      fee: 333n,
      principal: 25000n,
      remainder: 160n,
      shortfall: 0n,
    });
  });

  it("P4: parts always sum to gross with late fees and penalty", () => {
    for (const g of [0n, 1n, 99n, 100n, 104n, 110n, 2000n]) {
      const r = waterfall({ grossCents: g, principalCents: 1000n, feeCents: 5n, lateFeeCents: 100n, penaltyCents: 4n });
      expect(r.lateFee + r.penalty + r.fee + r.principal + r.remainder).toBe(g);
      expect(r.lateFee + r.penalty + r.fee + r.principal + r.shortfall).toBe(1109n);
    }
    expect(() => waterfall({ grossCents: 1n, principalCents: 1n, feeCents: 1n, lateFeeCents: -1n })).toThrow();
  });

  it("rejects negative inputs", () => {
    expect(() => waterfall({ grossCents: -1n, principalCents: 1n, feeCents: 1n })).toThrow();
    expect(() => waterfall({ grossCents: 1n, principalCents: -1n, feeCents: 1n })).toThrow();
    expect(() => waterfall({ grossCents: 1n, principalCents: 1n, feeCents: -1n })).toThrow();
  });
});

describe("holdersShare (80% floor)", () => {
  it("golden: fee 750 → holders 600, bank 150", () => {
    expect(holdersShare(750n)).toBe(600n);
  });
  it("golden: fee 15 → holders 12", () => {
    expect(holdersShare(15n)).toBe(12n);
  });
  it("a 1-cent fee → holders 0 (floor), bank keeps the cent", () => {
    expect(holdersShare(1n)).toBe(0n);
  });
  it("zero fee → zero", () => {
    expect(holdersShare(0n)).toBe(0n);
  });
});
