/** Pure: a loan's credit grade (A–E) for read models. */

const LOAN_GRADES = new Set(["A", "B", "C", "D", "E"]);

/**
 * A loan's credit grade for the console: the loan's own `risk_grade` when
 * set, else the `credit_grade` its offer was priced at (from the stored
 * disclosure), else null. Loans never had `risk_grade` written, so the
 * offer's disclosure is the real source.
 */
export function loanGrade(riskGrade: string | null | undefined, disclosure: unknown): string | null {
  if (typeof riskGrade === "string" && LOAN_GRADES.has(riskGrade)) {
    return riskGrade;
  }
  if (disclosure && typeof disclosure === "object") {
    const grade = (disclosure as Record<string, unknown>).credit_grade;
    if (typeof grade === "string" && LOAN_GRADES.has(grade)) {
      return grade;
    }
  }
  return null;
}
