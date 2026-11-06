import { eq } from "drizzle-orm";

import { runRole } from "../ai/run";
import type { Db } from "../db/client";
import { applications } from "../db/schema";
import { scoped } from "../db/scoped";
import { templateRiskMemo, toExplanation, toRiskMemo, type Explanation, type RiskMemo } from "./adverseAction";
import type { NarrativeInputs } from "./loans";

/**
 * The underwriting narrative (P3 Task 4) — an AFTER-COMMIT module (listed
 * in `AI_CALLERS`, tests/unit/ai/noTransactionCalls.test.ts). It takes a
 * plain `db`, is called only from `apply_for_loan`'s `finalize` hook, and
 * never opens a transaction.
 *
 * The loan officer (always) and the risk officer (grade D) run in parallel
 * under one overall budget (`NARRATIVE_BUDGET_MS`); a role that misses it
 * is aborted and its template is used. The result is stored on the
 * application (`narrative`, `ai_run_id`, and the adverse-action notice's
 * explanation). Only text changes — status, reasons, price and limit were
 * fixed by the rules pipeline before commit, and nothing here writes them.
 */

export const NARRATIVE_BUDGET_MS = 12_000;

let budgetMs = NARRATIVE_BUDGET_MS;

/** Test hook: shortens the overall narrative budget. */
export function __setNarrativeBudgetMsForTests(ms: number): void {
  budgetMs = ms;
}

export function __resetNarrativeBudgetMsForTests(): void {
  budgetMs = NARRATIVE_BUDGET_MS;
}

export interface StoredNarrative {
  explanation: Explanation;
  memo: RiskMemo | null;
  ai_run_ids: { loan_officer: string | null; risk_officer: string | null };
}

async function loanOfficer(
  db: Db,
  worldId: string,
  applicationId: string,
  inputs: NarrativeInputs,
  signal: AbortSignal,
): Promise<{ explanation: Explanation; aiRunId: string | null }> {
  try {
    const run = await runRole(db, worldId, "loan_officer", inputs.loanOfficer, { signal, subject: applicationId });
    return { explanation: toExplanation(run.output, run.fallbackUsed ? "template" : "ai"), aiRunId: run.aiRunId };
  } catch (err) {
    // runRole throws only on a caller bug (input schema) or a failed ai_runs insert.
    console.error(`[narrative] loan officer failed for ${applicationId}: ${err instanceof Error ? err.name : "error"}`);
    return { explanation: inputs.templateExplanation, aiRunId: null };
  }
}

async function riskOfficer(
  db: Db,
  worldId: string,
  applicationId: string,
  inputs: NarrativeInputs,
  signal: AbortSignal,
): Promise<{ memo: RiskMemo | null; aiRunId: string | null }> {
  if (!inputs.riskOfficer) {
    return { memo: null, aiRunId: null };
  }
  try {
    const run = await runRole(db, worldId, "risk_officer", inputs.riskOfficer, { signal, subject: applicationId });
    return { memo: toRiskMemo(run.output, run.fallbackUsed ? "template" : "ai"), aiRunId: run.aiRunId };
  } catch (err) {
    console.error(`[narrative] risk officer failed for ${applicationId}: ${err instanceof Error ? err.name : "error"}`);
    return { memo: templateRiskMemo(inputs.riskOfficer), aiRunId: null };
  }
}

/**
 * Writes the narrative for `applicationId` and returns it. Never throws:
 * on any failure the template explanation stands. `templateOnly` (the
 * private-world bots: simulated volume, no LLM spend) skips the roles and
 * stores the templates without an `ai_runs` row.
 */
export async function narrateApplication(
  db: Db,
  worldId: string,
  applicationId: string,
  inputs: NarrativeInputs,
  options: { templateOnly?: boolean } = {},
): Promise<StoredNarrative> {
  const signal = AbortSignal.timeout(budgetMs);
  const [officer, risk] = options.templateOnly
    ? [
        { explanation: inputs.templateExplanation, aiRunId: null },
        { memo: inputs.riskOfficer ? templateRiskMemo(inputs.riskOfficer) : null, aiRunId: null },
      ]
    : await Promise.all([
        loanOfficer(db, worldId, applicationId, inputs, signal),
        riskOfficer(db, worldId, applicationId, inputs, signal),
      ]);
  const narrative: StoredNarrative = {
    explanation: officer.explanation,
    memo: risk.memo,
    ai_run_ids: { loan_officer: officer.aiRunId, risk_officer: risk.aiRunId },
  };

  try {
    const world = scoped(db, worldId);
    const [application] = await world.selectFields(
      applications,
      { adverseAction: applications.adverseAction },
      eq(applications.id, applicationId),
    );
    const adverse = application?.adverseAction as Record<string, unknown> | null | undefined;
    await scoped(db, worldId).update(
      applications,
      {
        narrative,
        aiRunId: officer.aiRunId,
        // Only the notice's explanation changes; its reasons, score and notice text stay as decided.
        ...(adverse ? { adverseAction: { ...adverse, explanation: officer.explanation } } : {}),
      },
      eq(applications.id, applicationId),
    );
  } catch (err) {
    console.error(`[narrative] storing the narrative failed for ${applicationId}: ${err instanceof Error ? err.name : "error"}`);
  }
  return narrative;
}
