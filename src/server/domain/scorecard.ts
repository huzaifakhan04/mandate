/**
 * The Agent Credit Score (P3 Global Constraints, "Score"): 0–100, the sum
 * of five clamped components computed from DB facts only.
 *
 * | Component  | Points | Rule                                                                |
 * |------------|--------|---------------------------------------------------------------------|
 * | identity   | 0–25   | claimed 10 + active signing key 8 + approved KYA document 7         |
 * | history    | 0–35   | min(35, on-time repaid ×7) − 15 per late repayment − 35 if charged off |
 * | tenure     | 0–10   | floor(sim days since registration ÷ 3)                              |
 * | collateral | 0–20   | invoice coverage ≥ 1.5 → 20, ≥ 1.1 → 12, else / none → 0             |
 * | exposure   | 0–10   | floor(10 − 10 × principal exposure ÷ mandate max_total_owed), ≥ 0    |
 *
 * Grades: A ≥ 80, B ≥ 65, C ≥ 50, D ≥ 35, E < 35. Grade limit (cents):
 * A 50000, B 30000, C 20000, D 10000, E 0 (decline).
 *
 * Review Focus 3 (score gaming): the on-time part is capped at 35 and
 * only loans of ≥ 1000 cents count (`HISTORY_MIN_PRINCIPAL_CENTS`, applied
 * when the facts are gathered — `services/credit.ts`). An agent that pays
 * its own invoice link still counts as on time: accepted for P3.
 */

export type Grade = "A" | "B" | "C" | "D" | "E";

export interface ScoreFacts {
  /** Claimed by a verified principal. */
  claimed: boolean;
  /** Has an active (unrevoked) Ed25519 signing key. */
  hasSigningKey: boolean;
  /** Has ≥ 1 approved KYA document. */
  hasApprovedDocument: boolean;
  /** Repaid loans of ≥ 1000 cents whose final repayment came by `due_sim_at`. */
  onTimeRepaidLoans: number;
  /** Loans repaid after `due_sim_at`. */
  lateRepayments: number;
  /** Any loan of this agent was ever charged off. */
  everChargedOff: boolean;
  /** Whole sim days since registration. */
  tenureDays: number;
  /** Invoice face ÷ principal in bps for the application being scored; `null` = no invoice / no application. */
  invoiceCoverageBps: number | null;
  /** The principal's exposure across all their agents (`principalExposure`). */
  exposureCents: bigint;
  /** The current mandate's `max_total_owed`; `null` without a current mandate. */
  maxTotalOwedCents: bigint | null;
}

export interface ScoreComponents {
  identity: number;
  history: number;
  tenure: number;
  collateral: number;
  exposure: number;
}

export interface ScoreResult {
  score: number;
  grade: Grade;
  components: ScoreComponents;
  /** The three components losing the most points, as human-readable text. */
  factors: string[];
  /** The grade's per-loan limit in cents (0 = decline). */
  limitCents: number;
}

export const COMPONENT_MAX: ScoreComponents = { identity: 25, history: 35, tenure: 10, collateral: 20, exposure: 10 };

export const IDENTITY_POINTS = { claimed: 10, signingKey: 8, approvedDocument: 7 } as const;
export const ON_TIME_LOAN_POINTS = 7;
export const LATE_REPAYMENT_PENALTY = 15;
export const CHARGE_OFF_PENALTY = 35;
export const TENURE_DAYS_PER_POINT = 3;
/** Review Focus 3: loans below this principal never build history. */
export const HISTORY_MIN_PRINCIPAL_CENTS = 1000n;

export const GRADE_LIMIT_CENTS: Record<Grade, number> = { A: 50000, B: 30000, C: 20000, D: 10000, E: 0 };

const GRADE_FLOORS: ReadonlyArray<readonly [Grade, number]> = [
  ["A", 80],
  ["B", 65],
  ["C", 50],
  ["D", 35],
];

export function gradeFor(score: number): Grade {
  return GRADE_FLOORS.find(([, floor]) => score >= floor)?.[0] ?? "E";
}

function clamp(value: number, max: number): number {
  return Math.min(Math.max(value, 0), max);
}

function identityPoints(facts: ScoreFacts): number {
  return clamp(
    (facts.claimed ? IDENTITY_POINTS.claimed : 0) +
      (facts.hasSigningKey ? IDENTITY_POINTS.signingKey : 0) +
      (facts.hasApprovedDocument ? IDENTITY_POINTS.approvedDocument : 0),
    COMPONENT_MAX.identity,
  );
}

function historyPoints(facts: ScoreFacts): number {
  const onTime = Math.min(facts.onTimeRepaidLoans * ON_TIME_LOAN_POINTS, COMPONENT_MAX.history);
  const penalties = facts.lateRepayments * LATE_REPAYMENT_PENALTY + (facts.everChargedOff ? CHARGE_OFF_PENALTY : 0);
  return clamp(onTime - penalties, COMPONENT_MAX.history);
}

function tenurePoints(facts: ScoreFacts): number {
  return clamp(Math.floor(facts.tenureDays / TENURE_DAYS_PER_POINT), COMPONENT_MAX.tenure);
}

function collateralPoints(facts: ScoreFacts): number {
  if (facts.invoiceCoverageBps === null) {
    return 0;
  }
  if (facts.invoiceCoverageBps >= 15000) {
    return 20;
  }
  return facts.invoiceCoverageBps >= 11000 ? 12 : 0;
}

/** floor(10 − 10 × E ÷ M) = 10 − ceil(10E ÷ M), in integer math; 0 without a mandate. */
function exposurePoints(facts: ScoreFacts): number {
  const max = facts.maxTotalOwedCents;
  if (max === null || max <= 0n) {
    return 0;
  }
  const exposure = facts.exposureCents < 0n ? 0n : facts.exposureCents;
  const lost = (10n * exposure + max - 1n) / max;
  return clamp(10 - Number(lost > 10n ? 10n : lost), COMPONENT_MAX.exposure);
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function describe(component: keyof ScoreComponents, facts: ScoreFacts, points: number): string {
  const of = `(${points}/${COMPONENT_MAX[component]})`;
  switch (component) {
    case "identity": {
      const missing = [
        facts.claimed ? null : "not claimed by a verified human",
        facts.hasSigningKey ? null : "no signing key",
        facts.hasApprovedDocument ? null : "no approved KYA document",
      ].filter((text): text is string => text !== null);
      return `Identity: ${missing.length ? missing.join(", ") : "fully verified"} ${of}`;
    }
    case "history": {
      const parts = [`${plural(facts.onTimeRepaidLoans, "on-time repaid loan")}`];
      if (facts.lateRepayments > 0) {
        parts.push(plural(facts.lateRepayments, "late repayment"));
      }
      if (facts.everChargedOff) {
        parts.push("a charged-off loan");
      }
      return `Repayment history: ${parts.join(", ")} ${of}`;
    }
    case "tenure":
      return `Tenure: ${plural(Math.max(facts.tenureDays, 0), "sim day")} since registration ${of}`;
    case "collateral":
      return facts.invoiceCoverageBps === null
        ? `Collateral: none (scored only for an invoice-backed loan request) ${of}`
        : `Collateral: invoice covers ${(facts.invoiceCoverageBps / 10000).toFixed(2)}× the amount ${of}`;
    case "exposure":
      return facts.maxTotalOwedCents === null
        ? `Exposure: no current mandate ${of}`
        : `Exposure: your human owes ${facts.exposureCents.toString()} of ${facts.maxTotalOwedCents.toString()} cents allowed ${of}`;
  }
}

/** Fixed tie order for factors (most explanatory first). */
const FACTOR_ORDER: ReadonlyArray<keyof ScoreComponents> = ["history", "identity", "collateral", "exposure", "tenure"];

/** Pure: the score, grade, components, top-3 factors and grade limit for `facts`. */
export function computeScore(facts: ScoreFacts): ScoreResult {
  const components: ScoreComponents = {
    identity: identityPoints(facts),
    history: historyPoints(facts),
    tenure: tenurePoints(facts),
    collateral: collateralPoints(facts),
    exposure: exposurePoints(facts),
  };
  const score = clamp(
    components.identity + components.history + components.tenure + components.collateral + components.exposure,
    100,
  );
  const grade = gradeFor(score);
  const factors = [...FACTOR_ORDER]
    .map((key, order) => ({ key, order, lost: COMPONENT_MAX[key] - components[key] }))
    .sort((a, b) => b.lost - a.lost || a.order - b.order)
    .slice(0, 3)
    .map(({ key }) => describe(key, facts, components[key]));
  return { score, grade, components, factors, limitCents: GRADE_LIMIT_CENTS[grade] };
}
