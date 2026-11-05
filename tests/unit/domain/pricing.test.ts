import { describe, expect, it } from "vitest";

import { price, PRICING_LIMITS } from "@/server/domain/pricing";

describe("price (fixed P1 pricing)", () => {
  it("golden: 25000 cents for 14 days → fee 750, APR 7821 bps", () => {
    expect(price(25000n, 14)).toEqual({ feeCents: 750n, aprBps: 7821 });
  });

  it("golden: 1000 cents for 7 days → fee 15", () => {
    expect(price(1000n, 7).feeCents).toBe(15n);
  });

  it("golden: 50000 cents for 30 days → fee capped at 2500", () => {
    // Uncapped: ceil(50000 × 150 × 5 / 10000) = 3750.
    expect(price(50000n, 30).feeCents).toBe(2500n);
  });

  it("rounds the fee up (ceil) and counts started weeks", () => {
    // 1001 × 150 × 1 / 10000 = 15.015 → 16.
    expect(price(1001n, 7).feeCents).toBe(16n);
    // 8 days is two started weeks: 10000 × 150 × 2 / 10000 = 300.
    expect(price(10000n, 8).feeCents).toBe(300n);
  });

  it("APR is round(fee / principal × 365 / term × 10000)", () => {
    // 15 / 1000 × 365 / 7 × 10000 = 7821.43 → 7821.
    expect(price(1000n, 7).aprBps).toBe(7821);
    // 2500 / 50000 × 365 / 30 × 10000 = 6083.33 → 6083.
    expect(price(50000n, 30).aprBps).toBe(6083);
  });

  it("exposes the P1 ranges", () => {
    expect(PRICING_LIMITS).toEqual({
      minPrincipalCents: 1000n,
      maxPrincipalCents: 50000n,
      minTermDays: 7,
      maxTermDays: 30,
    });
  });

  it("rejects a non-positive principal or term", () => {
    expect(() => price(0n, 14)).toThrow();
    expect(() => price(1000n, 0)).toThrow();
  });
});
