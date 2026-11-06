/**
 * The adverse-action notice and the narrative inputs (P3 Task 4). Pure:
 * everything here is built from a decision already made by the rules
 * pipeline (`domain/rules.ts`) — the AI roles only ever *explain* it.
 *
 * - `buildAdverseAction` — the DECLINED payload: at most 4 principal
 *   reasons with their fixed text (`domain/reasons.ts`), the score, grade
 *   and score factors, the fixed notice, and the explanation (the loan
 *   officer's text, or its template).
 * - `loanOfficerInputFor` / `riskOfficerInputFor` — the allowlisted role
 *   inputs (amounts as `number` cents; no ids, emails or purpose text).
 * - `templateExplanation` — the deterministic explanation the handler
 *   returns before `finalize` replaces it.
 */
import { cleanList, cleanText } from "../ai/sanitize";
import type { LoanOfficerInput, LoanOfficerOutput, RiskOfficerInput, RiskOfficerOutput } from "../ai/schemas";
import { loanOfficerTemplate, riskOfficerTemplate } from "../ai/templates";
import { principalReasons, type ReasonCode } from "../domain/reasons";
import type { ApplicationDecision } from "../domain/rules";
import type { ScoreResult } from "../domain/scorecard";

/** Fixed notice text on every DECLINED application (Reg B–style; never generated). */
export const ADVERSE_ACTION_NOTICE =
  "Notice of adverse action: Mandate Bank has declined this credit application. The principal reasons are listed " +
  "in `reasons` (at most four). You have the right to a statement of specific reasons for this decision: call " +
  "get_application with this application_id at any time to receive it again. The decision was made by fixed " +
  "rules from your Agent Credit Score and the facts of this application; the explanation is informational and " +
  "does not change the decision.";

/** The loan officer's text as returned to the agent: `source` says whether the LLM wrote it. */
export interface Explanation extends LoanOfficerOutput {
  source: "ai" | "template";
}

/** The risk officer's memo as stored on the application (grade D; never sent to the agent). */
export interface RiskMemo extends RiskOfficerOutput {
  source: "ai" | "template";
}

export interface AdverseAction {
  reasons: Array<{ code: ReasonCode; text: string }>;
  score: number;
  grade: ScoreResult["grade"];
  score_factors: string[];
  notice: string;
  explanation: Explanation;
}

type DecisionFacts = Pick<ApplicationDecision, "decision" | "reasons" | "effectiveCapCents" | "price">;

export function loanOfficerInputFor(
  decision: DecisionFacts,
  credit: ScoreResult,
  amountCents: bigint,
  termDays: number,
): LoanOfficerInput {
  return {
    decision: decision.decision,
    reasons: decision.decision === "decline" ? principalReasons(decision.reasons) : [],
    score: credit.score,
    grade: credit.grade,
    scoreFactors: credit.factors.slice(0, 5),
    amountCents: Number(amountCents),
    termDays,
    feeCents: decision.price ? Number(decision.price.feeCents) : null,
    aprBps: decision.price ? decision.price.aprBps : null,
    effectiveCapCents: Number(decision.effectiveCapCents),
  };
}

export function riskOfficerInputFor(
  decision: Pick<ApplicationDecision, "decision" | "reasons" | "approval">,
  credit: ScoreResult,
  amountCents: bigint,
  termDays: number,
  invoiceCoverageBps: number | null,
): RiskOfficerInput {
  return {
    decision: decision.decision,
    approval: decision.approval,
    reasons: decision.decision === "decline" ? principalReasons(decision.reasons) : [],
    score: credit.score,
    grade: credit.grade,
    components: credit.components,
    scoreFactors: credit.factors.slice(0, 5),
    amountCents: Number(amountCents),
    termDays,
    invoiceCoverageBps,
  };
}

/** Loan-officer text made safe to store and show: no URLs, each string ≤ 200 chars. */
export function toExplanation(output: LoanOfficerOutput, source: Explanation["source"]): Explanation {
  return {
    source,
    summary: cleanText(output.summary),
    reasons_explained: output.reasons_explained.map((r) => ({ code: r.code, explanation: cleanText(r.explanation) })),
    next_steps: cleanList(output.next_steps),
  };
}

export function toRiskMemo(output: RiskOfficerOutput, source: RiskMemo["source"]): RiskMemo {
  return { source, memo: cleanText(output.memo, 2000), concerns: cleanList(output.concerns) };
}

export function templateExplanation(input: LoanOfficerInput): Explanation {
  return toExplanation(loanOfficerTemplate(input), "template");
}

export function templateRiskMemo(input: RiskOfficerInput): RiskMemo {
  return toRiskMemo(riskOfficerTemplate(input), "template");
}

export function buildAdverseAction(
  reasons: readonly ReasonCode[],
  credit: ScoreResult,
  explanation: Explanation,
): AdverseAction {
  return {
    reasons: principalReasons(reasons),
    score: credit.score,
    grade: credit.grade,
    score_factors: credit.factors,
    notice: ADVERSE_ACTION_NOTICE,
    explanation,
  };
}
