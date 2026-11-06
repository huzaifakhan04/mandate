/** P5 Task 3 — the treasury policy's pure gates (`domain/treasury.ts`). */
import { describe, expect, it } from "vitest";

import { evaluateApplication, type ApplicationFacts } from "@/server/domain/rules";
import {
  loanTreasuryLimits,
  loanTreasuryReasons,
  redemptionPayable,
  reserveFloorCents,
  shareOfCents,
  TREASURY_DEFAULTS,
  type LoanTreasuryFacts,
} from "@/server/domain/treasury";

function facts(overrides: Partial<LoanTreasuryFacts> = {}): LoanTreasuryFacts {
  return {
    policy: { ...TREASURY_DEFAULTS },
    availableLiquidityCents: 100_000n,
    queuedRedemptionCents: 0n,
    notesOutstandingCents: 100_000n,
    principalExposureCents: 0n,
    totalLoansCents: 0n,
    dayStartLiquidityCents: 100_000n,
    budgetUsedCents: 0n,
    ...overrides,
  };
}

describe("treasury policy (pure)", () => {
  it("defaults: floor 1500, concentration 3000, budget 4000 bps", () => {
    expect(TREASURY_DEFAULTS).toEqual({ reserveFloorBps: 1500, concentrationBps: 3000, dailyBudgetBps: 4000 });
  });

  it("reserve floor rounds up; share rounds down; nothing for no notes", () => {
    expect(reserveFloorCents(10_001n, 1500)).toBe(1501n); // 1500.15 → 1501
    expect(reserveFloorCents(10_000n, 1500)).toBe(1500n);
    expect(reserveFloorCents(0n, 1500)).toBe(0n);
    expect(reserveFloorCents(-5n, 1500)).toBe(0n);
    expect(shareOfCents(10_001n, 4000)).toBe(4000n);
    expect(shareOfCents(-1n, 4000)).toBe(0n);
  });

  it("reserve_floor: available − queued − principal must stay ≥ the floor on notes outstanding", () => {
    // floor = 15000; headroom = 100000 − 15000 = 85000.
    expect(loanTreasuryLimits(facts()).floorHeadroomCents).toBe(85_000n);
    const lenient = facts({ policy: { ...TREASURY_DEFAULTS, concentrationBps: 10000, dailyBudgetBps: 10000 } });
    expect(loanTreasuryReasons(lenient, 85_000n)).toEqual([]);
    expect(loanTreasuryReasons(lenient, 85_001n)).toEqual(["reserve_floor"]);
    // Queued redemptions come first.
    expect(loanTreasuryReasons({ ...lenient, queuedRedemptionCents: 1n }, 85_000n)).toEqual(["reserve_floor"]);
  });

  it("concentration_limit: exposure + principal ≤ 30% of (loans + available)", () => {
    // base = 50000 + 100000 = 150000 → cap 45000.
    const f = facts({ totalLoansCents: 50_000n, principalExposureCents: 20_000n });
    expect(loanTreasuryLimits(f).concentrationCapCents).toBe(45_000n);
    expect(loanTreasuryReasons(f, 25_000n)).toEqual([]);
    expect(loanTreasuryReasons(f, 25_001n)).toEqual(["concentration_limit"]);
  });

  it("daily_budget_exhausted: used today + principal ≤ 40% of the day-start liquidity; no snapshot → no gate", () => {
    const f = facts({ budgetUsedCents: 30_000n, policy: { ...TREASURY_DEFAULTS, concentrationBps: 10000 } });
    expect(loanTreasuryReasons(f, 10_000n)).toEqual([]);
    expect(loanTreasuryReasons(f, 10_001n)).toEqual(["daily_budget_exhausted"]);
    expect(loanTreasuryReasons({ ...f, dayStartLiquidityCents: null }, 50_000n)).toEqual([]);
    expect(loanTreasuryLimits({ ...f, dayStartLiquidityCents: null }).dailyBudgetCents).toBeNull();
  });

  it("all three in pipeline order; none when the pool can't fund the amount at all", () => {
    const f = facts({ availableLiquidityCents: 20_000n, dayStartLiquidityCents: 10_000n });
    expect(loanTreasuryReasons(f, 19_000n)).toEqual(["reserve_floor", "concentration_limit", "daily_budget_exhausted"]);
    expect(loanTreasuryReasons(f, 20_001n)).toEqual([]);
  });

  it("the rules pipeline adds them after the capacity rules (insufficient_liquidity alone when unfundable)", () => {
    const base: ApplicationFacts = {
      amountCents: 10_000n,
      termDays: 14,
      purpose: "Working capital",
      credit: { score: 90, grade: "A", components: { identity: 25, history: 35, tenure: 10, collateral: 10, exposure: 10 } },
      hasHistory: true,
      tierCapCents: 25_000n,
      mandate: {
        maxPerLoanCents: 50_000n,
        maxTotalOwedCents: 100_000n,
        maxFeeBps: 2000,
        maxTermDays: 30,
        eligibleCollateral: ["none", "invoice_link"],
      },
      exposureCents: 0n,
      collateral: "none",
      invoiceCoverageBps: null,
      sanctions: { name: "a", operator: "b", list: [] },
      declarations: { noOtherDebt: true, attested: true },
      openLoanExists: false,
      availableLiquidityCents: 12_000n,
    };
    const tight = facts({ availableLiquidityCents: 12_000n, notesOutstandingCents: 20_000n });
    const decision = evaluateApplication({ ...base, treasury: tight });
    expect(decision.decision).toBe("decline");
    expect(decision.reasons).toEqual(["reserve_floor", "concentration_limit"]);
    expect(evaluateApplication(base).decision).toBe("approve");
    expect(evaluateApplication({ ...base, amountCents: 13_000n, treasury: tight }).reasons).toEqual(["insufficient_liquidity"]);
  });

  it("redemption gate: payable iff available − amount ≥ the floor on the notes left, never beyond cash", () => {
    // 100000 notes, 20000 available: redeeming 5000 leaves 15000 ≥ ceil(95000 × 15%) = 14250.
    expect(redemptionPayable(20_000n, 100_000n, 5_000n, 1500)).toBe(true);
    // 6000 leaves 14000 < 14100.
    expect(redemptionPayable(20_000n, 100_000n, 6_000n, 1500)).toBe(false);
    // The last holder redeeming everything: the floor on 0 notes is 0, but never more than the cash.
    expect(redemptionPayable(10_000n, 10_000n, 10_000n, 1500)).toBe(true);
    expect(redemptionPayable(9_999n, 10_000n, 10_000n, 1500)).toBe(false);
    expect(redemptionPayable(9_999n, 10_000n, 10_000n, 0)).toBe(false);
  });
});
