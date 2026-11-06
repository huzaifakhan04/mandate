import { describe, expect, it } from "vitest";

import { PRICING_LIMITS, rangeReasons } from "@/server/domain/pricing";

/**
 * P3 Task 2: the flat P1 `price()` (1.5% per started week, capped at $25)
 * was removed — risk-based pricing v2 replaced it, and its goldens live in
 * `pricingV2.test.ts`. The product ranges remain.
 */
describe("P1 product ranges", () => {
  it("exposes the P1 ranges", () => {
    expect(PRICING_LIMITS).toEqual({
      minPrincipalCents: 1000n,
      maxPrincipalCents: 50000n,
      minTermDays: 7,
      maxTermDays: 30,
    });
  });

  it("reports amount_out_of_range / term_out_of_range at the edges", () => {
    expect(rangeReasons(1000n, 7)).toEqual([]);
    expect(rangeReasons(50000n, 30)).toEqual([]);
    expect(rangeReasons(999n, 7)).toEqual(["amount_out_of_range"]);
    expect(rangeReasons(50001n, 31)).toEqual(["amount_out_of_range", "term_out_of_range"]);
    expect(rangeReasons(1000n, 6)).toEqual(["term_out_of_range"]);
  });
});
