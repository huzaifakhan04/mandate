import { and, eq, gte, inArray, isNull, notInArray, or, sql } from "drizzle-orm";

import { runRole } from "../ai/run";
import type { Db } from "../db/client";
import { aiRuns, applications } from "../db/schema";
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

/**
 * P3 final review I4: at most this many applications per agent per real
 * (wall-clock) UTC day get an LLM narrative; beyond it the templates are
 * used with `error_code: rate_capped` (the `ai_runs` rows are still written).
 */
export const DAILY_LLM_NARRATIVES_PER_AGENT = 20;

/** Start of the current real UTC day (the cap is about OpenAI spend, so never the simulated clock). */
function utcDayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * How many of `agentId`'s applications already had the loan officer call
 * the model today (any outcome except `disabled` / `rate_capped`, which
 * never reached OpenAI). Bounded: it stops counting at the cap.
 */
export async function llmNarrativesToday(db: Db, worldId: string, agentId: string, now: Date = new Date()): Promise<number> {
  const rows = await scoped(db, worldId).selectFields(
    aiRuns,
    { subject: aiRuns.subject },
    and(
      eq(aiRuns.role, "loan_officer"),
      gte(aiRuns.createdAt, utcDayStart(now)),
      or(isNull(aiRuns.errorCode), notInArray(aiRuns.errorCode, ["disabled", "rate_capped"])),
      inArray(
        aiRuns.subject,
        sql`(select ${applications.id}::text from ${applications} where ${applications.worldId} = ${worldId} and ${applications.agentId} = ${agentId})`,
      ),
    ),
    undefined,
    DAILY_LLM_NARRATIVES_PER_AGENT * 2,
  );
  return new Set(rows.map((row) => row.subject)).size;
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
  capped: boolean,
): Promise<{ explanation: Explanation; aiRunId: string | null }> {
  try {
    const run = await runRole(db, worldId, "loan_officer", inputs.loanOfficer, {
      signal,
      subject: applicationId,
      ...(capped ? { skipModel: "rate_capped" as const } : {}),
    });
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
  capped: boolean,
): Promise<{ memo: RiskMemo | null; aiRunId: string | null }> {
  if (!inputs.riskOfficer) {
    return { memo: null, aiRunId: null };
  }
  try {
    const run = await runRole(db, worldId, "risk_officer", inputs.riskOfficer, {
      signal,
      subject: applicationId,
      ...(capped ? { skipModel: "rate_capped" as const } : {}),
    });
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
 * stores the templates without an `ai_runs` row. `agentId` (the
 * applicant) enables the daily per-agent LLM cap
 * (`DAILY_LLM_NARRATIVES_PER_AGENT`).
 */
export async function narrateApplication(
  db: Db,
  worldId: string,
  applicationId: string,
  inputs: NarrativeInputs,
  options: { templateOnly?: boolean; agentId?: string } = {},
): Promise<StoredNarrative> {
  const signal = AbortSignal.timeout(budgetMs);
  let capped = false;
  if (!options.templateOnly && options.agentId) {
    try {
      capped = (await llmNarrativesToday(db, worldId, options.agentId)) >= DAILY_LLM_NARRATIVES_PER_AGENT;
    } catch (err) {
      // Fail closed on spend: if the count can't be read, use the templates.
      console.error(`[narrative] daily cap check failed for ${applicationId}: ${err instanceof Error ? err.name : "error"}`);
      capped = true;
    }
  }
  const [officer, risk] = options.templateOnly
    ? [
        { explanation: inputs.templateExplanation, aiRunId: null },
        { memo: inputs.riskOfficer ? templateRiskMemo(inputs.riskOfficer) : null, aiRunId: null },
      ]
    : await Promise.all([
        loanOfficer(db, worldId, applicationId, inputs, signal, capped),
        riskOfficer(db, worldId, applicationId, inputs, signal, capped),
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
