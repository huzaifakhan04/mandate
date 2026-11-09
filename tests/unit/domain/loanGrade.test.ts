/** The console's loan grade: the loan's risk_grade, else its offer disclosure's credit_grade. */
import { describe, expect, it } from "vitest";

import { loanGrade } from "@/server/domain/loanGrade";
import { showsDueEvent } from "@/server/services/timeline";

describe("loanGrade", () => {
  it("prefers the loan's own risk_grade", () => {
    expect(loanGrade("B", { credit_grade: "D" })).toBe("B");
  });
  it("falls back to the offer disclosure's credit_grade", () => {
    expect(loanGrade(null, { credit_grade: "D", credit_score: 41 })).toBe("D");
    expect(loanGrade(undefined, { credit_grade: "A" })).toBe("A");
  });
  it("is null with no grade, a junk grade or no disclosure", () => {
    expect(loanGrade(null, null)).toBeNull();
    expect(loanGrade(null, {})).toBeNull();
    expect(loanGrade("Z", { credit_grade: "AA" })).toBeNull();
    expect(loanGrade(null, "D")).toBeNull();
  });
});

describe("showsDueEvent", () => {
  it("shows a due date only for loans that are in flight, owing or charged off", () => {
    for (const s of ["disbursing", "active", "late", "substandard", "charged_off"]) {
      expect(showsDueEvent(s)).toBe(true);
    }
    for (const s of ["repaid", "recovered", "accepted", "disbursement_failed", "closed"]) {
      expect(showsDueEvent(s)).toBe(false);
    }
  });
});
