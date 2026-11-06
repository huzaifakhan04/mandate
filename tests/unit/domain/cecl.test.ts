/** P5 Task 2 — the CECL reserve per loan (pure). */
import { describe, expect, it } from "vitest";

import {
  CECL_FALLBACK_EXPECTED_LOSS_BPS,
  ceclLoanCents,
  chargeOffRelease,
  expectedLossBpsAtOffer,
  isCeclDelinquentStatus,
} from "@/server/domain/cecl";
import { LGD_BPS, PD_BPS } from "@/server/domain/pricingV2";

describe("CECL reserve (P5 Task 2)", () => {
  it("expected loss at offer = the disclosure's PD × LGD (rate_components.expected_loss_bps)", () => {
    expect(expectedLossBpsAtOffer({ credit_grade: "C", rate_components: { expected_loss_bps: 360 } })).toBe(360);
    // Grade only (no components): PD × the unsecured LGD.
    expect(expectedLossBpsAtOffer({ credit_grade: "B" })).toBe((PD_BPS.B * LGD_BPS.unsecured) / 10000);
    // Nothing usable: grade D unsecured, the most conservative priced rate.
    expect(expectedLossBpsAtOffer(null)).toBe(CECL_FALLBACK_EXPECTED_LOSS_BPS);
    expect(CECL_FALLBACK_EXPECTED_LOSS_BPS).toBe(720);
    expect(expectedLossBpsAtOffer({ rate_components: { expected_loss_bps: "x" } })).toBe(720);
  });

  it("principal × EL bps ÷ 10000, half-up per loan", () => {
    // 25000 × 180 / 10000 = 450 exactly.
    expect(ceclLoanCents({ outstandingPrincipalCents: 25000n, expectedLossBps: 180, delinquent: false })).toBe(450n);
    // 1250 × 60 / 10000 = 7.5 → 8 (half up); 1249 × 60 / 10000 = 7.494 → 7.
    expect(ceclLoanCents({ outstandingPrincipalCents: 1250n, expectedLossBps: 60, delinquent: false })).toBe(8n);
    expect(ceclLoanCents({ outstandingPrincipalCents: 1249n, expectedLossBps: 60, delinquent: false })).toBe(7n);
    expect(ceclLoanCents({ outstandingPrincipalCents: 0n, expectedLossBps: 720, delinquent: true })).toBe(0n);
  });

  it("late and substandard double the reserve, capped at the outstanding principal", () => {
    expect(ceclLoanCents({ outstandingPrincipalCents: 25000n, expectedLossBps: 180, delinquent: true })).toBe(900n);
    // 1250 × 60 × 2 / 10000 = 15 exactly (not 2 × the rounded 8).
    expect(ceclLoanCents({ outstandingPrincipalCents: 1250n, expectedLossBps: 60, delinquent: true })).toBe(15n);
    expect(ceclLoanCents({ outstandingPrincipalCents: 100n, expectedLossBps: 6000, delinquent: true })).toBe(100n);
    expect(isCeclDelinquentStatus("late")).toBe(true);
    expect(isCeclDelinquentStatus("substandard")).toBe(true);
    expect(isCeclDelinquentStatus("active")).toBe(false);
  });

  it("a charge-off releases min(the loan's reserve, the allowance, P), never negative", () => {
    expect(chargeOffRelease(900n, 5000n, 25000n)).toBe(900n);
    expect(chargeOffRelease(900n, 450n, 25000n)).toBe(450n);
    expect(chargeOffRelease(900n, 0n, 25000n)).toBe(0n);
    expect(chargeOffRelease(900n, -3n, 25000n)).toBe(0n);
    expect(chargeOffRelease(900n, 5000n, 500n)).toBe(500n);
  });
});
