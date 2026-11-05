import { describe, expect, it } from "vitest";

import { holdersShare, waterfall } from "@/server/domain/waterfall";

describe("waterfall (fee first, then principal, then remainder)", () => {
  it("golden: invoice 40000 against P 25000 + F 750 → REPAID, remainder 14250", () => {
    expect(waterfall({ grossCents: 40000n, principalCents: 25000n, feeCents: 750n })).toEqual({
      principal: 25000n,
      fee: 750n,
      remainder: 14250n,
      shortfall: 0n,
    });
  });

  it("exact payoff → no remainder, no shortfall", () => {
    expect(waterfall({ grossCents: 25750n, principalCents: 25000n, feeCents: 750n })).toEqual({
      principal: 25000n,
      fee: 750n,
      remainder: 0n,
      shortfall: 0n,
    });
  });

  it("partial 10000 → fee 750 paid first, principal 9250, shortfall 15750", () => {
    expect(waterfall({ grossCents: 10000n, principalCents: 25000n, feeCents: 750n })).toEqual({
      principal: 9250n,
      fee: 750n,
      remainder: 0n,
      shortfall: 15750n,
    });
  });

  it("a payment smaller than the fee goes entirely to the fee", () => {
    expect(waterfall({ grossCents: 500n, principalCents: 25000n, feeCents: 750n })).toEqual({
      principal: 0n,
      fee: 500n,
      remainder: 0n,
      shortfall: 25250n,
    });
  });

  it("a 1-cent fee", () => {
    expect(waterfall({ grossCents: 1001n, principalCents: 1000n, feeCents: 1n })).toEqual({
      principal: 1000n,
      fee: 1n,
      remainder: 0n,
      shortfall: 0n,
    });
    expect(waterfall({ grossCents: 1n, principalCents: 1000n, feeCents: 1n })).toEqual({
      principal: 0n,
      fee: 1n,
      remainder: 0n,
      shortfall: 1000n,
    });
  });

  it("nothing owed (already repaid) → the whole gross is remainder", () => {
    expect(waterfall({ grossCents: 40000n, principalCents: 0n, feeCents: 0n })).toEqual({
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
