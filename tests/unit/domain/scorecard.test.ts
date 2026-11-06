/**
 * P3 Task 1: the Agent Credit Score (Global Constraints, "Score"). Golden
 * component vectors for the agent journeys the demo shows, the grade
 * boundaries, and Review Focus 3 (score gaming: history caps at 35).
 */
import { describe, expect, it } from "vitest";

import {
  GRADE_LIMIT_CENTS,
  computeScore,
  gradeFor,
  type ScoreFacts,
} from "@/server/domain/scorecard";

const FRESH: ScoreFacts = {
  claimed: false,
  hasSigningKey: false,
  hasApprovedDocument: false,
  onTimeRepaidLoans: 0,
  lateRepayments: 0,
  everChargedOff: false,
  tenureDays: 0,
  invoiceCoverageBps: null,
  exposureCents: 0n,
  maxTotalOwedCents: null,
};
const T1: ScoreFacts = { ...FRESH, claimed: true, maxTotalOwedCents: 100_000n };
const T2: ScoreFacts = { ...T1, hasSigningKey: true, hasApprovedDocument: true };

describe("computeScore — golden component vectors", () => {
  it("a fresh T0 agent scores 0 (no claim, no mandate → no exposure points)", () => {
    const result = computeScore(FRESH);
    expect(result.components).toEqual({ identity: 0, history: 0, tenure: 0, collateral: 0, exposure: 0 });
    expect(result).toMatchObject({ score: 0, grade: "E", limitCents: 0 });
  });

  it("a T1 agent (claimed + mandate, nothing owed) scores 20", () => {
    const result = computeScore(T1);
    expect(result.components).toEqual({ identity: 10, history: 0, tenure: 0, collateral: 0, exposure: 10 });
    expect(result).toMatchObject({ score: 20, grade: "E" });
  });

  it("a T2 agent (doc + key) scores 35 → grade D", () => {
    const result = computeScore(T2);
    expect(result.components).toEqual({ identity: 25, history: 0, tenure: 0, collateral: 0, exposure: 10 });
    expect(result).toMatchObject({ score: 35, grade: "D", limitCents: 10000 });
  });

  it("key and document each count on their own", () => {
    expect(computeScore({ ...T1, hasSigningKey: true }).components.identity).toBe(18);
    expect(computeScore({ ...T1, hasApprovedDocument: true }).components.identity).toBe(17);
  });

  it("3 on-time repaid loans give 21 history points", () => {
    const result = computeScore({ ...T2, onTimeRepaidLoans: 3, tenureDays: 30 });
    expect(result.components).toEqual({ identity: 25, history: 21, tenure: 10, collateral: 0, exposure: 10 });
    expect(result).toMatchObject({ score: 66, grade: "B", limitCents: 30000 });
  });

  it("collateral: coverage 1.5 → 20, 1.1 → 12, below 1.1 or none → 0", () => {
    expect(computeScore({ ...T1, invoiceCoverageBps: 15000 }).components.collateral).toBe(20);
    expect(computeScore({ ...T1, invoiceCoverageBps: 14999 }).components.collateral).toBe(12);
    expect(computeScore({ ...T1, invoiceCoverageBps: 11000 }).components.collateral).toBe(12);
    expect(computeScore({ ...T1, invoiceCoverageBps: 10999 }).components.collateral).toBe(0);
    expect(computeScore({ ...T1, invoiceCoverageBps: null }).components.collateral).toBe(0);
  });

  it("exposure: 0% → 10, 50% → 5, 100% → 0, over the cap floors at 0", () => {
    expect(computeScore({ ...T1, exposureCents: 0n }).components.exposure).toBe(10);
    expect(computeScore({ ...T1, exposureCents: 50_000n }).components.exposure).toBe(5);
    expect(computeScore({ ...T1, exposureCents: 100_000n }).components.exposure).toBe(0);
    expect(computeScore({ ...T1, exposureCents: 250_000n }).components.exposure).toBe(0);
    // Rounded down: any amount owed costs at least a fraction → conservative.
    expect(computeScore({ ...T1, exposureCents: 1n }).components.exposure).toBe(9);
  });

  it("tenure: sim days ÷ 3, floored, capped at 10", () => {
    expect(computeScore({ ...T1, tenureDays: 2 }).components.tenure).toBe(0);
    expect(computeScore({ ...T1, tenureDays: 7 }).components.tenure).toBe(2);
    expect(computeScore({ ...T1, tenureDays: 30 }).components.tenure).toBe(10);
    expect(computeScore({ ...T1, tenureDays: 400 }).components.tenure).toBe(10);
    expect(computeScore({ ...T1, tenureDays: -5 }).components.tenure).toBe(0);
  });

  it("history penalties: −15 per late repayment, −35 when ever charged off, floored at 0", () => {
    expect(computeScore({ ...T1, onTimeRepaidLoans: 3, lateRepayments: 1 }).components.history).toBe(6);
    expect(computeScore({ ...T1, onTimeRepaidLoans: 3, lateRepayments: 2 }).components.history).toBe(0);
    expect(computeScore({ ...T1, onTimeRepaidLoans: 5, everChargedOff: true }).components.history).toBe(0);
  });

  it("a perfect agent scores 100 → A", () => {
    const result = computeScore({ ...T2, onTimeRepaidLoans: 5, tenureDays: 30, invoiceCoverageBps: 20000 });
    expect(result).toMatchObject({ score: 100, grade: "A", limitCents: 50000 });
  });
});

describe("Review Focus 3 — score gaming", () => {
  it("on-time repaid loans ×7 cap at 35 however many tiny loans are repaid", () => {
    expect(computeScore({ ...T1, onTimeRepaidLoans: 5 }).components.history).toBe(35);
    expect(computeScore({ ...T1, onTimeRepaidLoans: 50 }).components.history).toBe(35);
    expect(computeScore({ ...T1, onTimeRepaidLoans: 10_000 }).components.history).toBe(35);
  });
  // Sub-1000-cent loans are excluded from `onTimeRepaidLoans` when the facts
  // are gathered — see tests/unit/services/credit.test.ts.
});

describe("grades and limits", () => {
  it("boundaries: A ≥ 80, B ≥ 65, C ≥ 50, D ≥ 35, E < 35", () => {
    expect(gradeFor(100)).toBe("A");
    expect(gradeFor(80)).toBe("A");
    expect(gradeFor(79)).toBe("B");
    expect(gradeFor(65)).toBe("B");
    expect(gradeFor(64)).toBe("C");
    expect(gradeFor(50)).toBe("C");
    expect(gradeFor(49)).toBe("D");
    expect(gradeFor(35)).toBe("D");
    expect(gradeFor(34)).toBe("E");
    expect(gradeFor(0)).toBe("E");
  });

  it("grade limits in cents", () => {
    expect(GRADE_LIMIT_CENTS).toEqual({ A: 50000, B: 30000, C: 20000, D: 10000, E: 0 });
  });
});

describe("score factors", () => {
  it("are the 3 components losing the most points, in a fixed tie order", () => {
    const result = computeScore(T1);
    // Lost: history 35, collateral 20, identity 15, tenure 10, exposure 0.
    expect(result.factors).toHaveLength(3);
    expect(result.factors[0]).toMatch(/^Repayment history/);
    expect(result.factors[1]).toMatch(/^Collateral/);
    expect(result.factors[2]).toMatch(/^Identity/);
  });

  it("are human-readable and include the points", () => {
    const result = computeScore({ ...T2, onTimeRepaidLoans: 1, exposureCents: 50_000n });
    expect(result.factors.join(" | ")).toContain("1 on-time repaid loan (7/35)");
  });

  it("is deterministic", () => {
    expect(computeScore(T2)).toEqual(computeScore(T2));
  });
});
