import { and, asc, eq, inArray, isNull, lte } from "drizzle-orm";

import type { Db } from "../db/client";
import { agentNotices, agents, events, loanLadderSteps, loans, noteSeries, scoreHistory } from "../db/schema";
import { scoped } from "../db/scoped";
import {
  LATE_SCORE_DELTA,
  daysLate,
  dueSteps,
  lateFeeCents,
  penaltyIncrement,
  previousStep,
  stepDueAt,
  type LadderStep,
} from "../domain/delinquency";
import { fromDbStatus, isOwingStatus, OWING_LOAN_DB_STATUSES, toDbStatus, transition } from "../domain/loanMachine";
import { scoreAgent } from "./credit";

/**
 * P4 Task 1 — collections: the delinquency ladder engine (`processDue`),
 * the daily rate-penalty accrual, notices and the cure-side agent restore.
 *
 * Accounting choice (P1 convention, documented): fees are recognised on
 * COLLECTION. A late fee or penalty is a memo balance on the loan
 * (`late_fee_outstanding_cents`, `penalty_outstanding_cents`) — assessing
 * it posts no journal, so the trial balance is untouched. The repayment
 * waterfall (late fees → penalty → fee → principal → remainder) credits
 * what it collects to `late_fee_income` / `penalty_income` in the same
 * repayment journal (`services/repayments.ts`). Note holders share the
 * base fee only.
 *
 * Exactly-once (Review Focus 1): every step runs in its own transaction
 * under the note series → loan row locks (the repayment capture's order),
 * re-reads the loan under the lock, requires the previous step to be the
 * loan's `delinquency_step`, inserts its `loan_ladder_steps` row (unique
 * `(world_id, loan_id, step)`, ON CONFLICT DO NOTHING) and only then makes
 * a conditional status update — so a concurrent tick and manual advance,
 * or a retry after a crash mid-step (the transaction rolled back), apply
 * each step once. The penalty accrual is keyed on `penalty_accrued_days`,
 * read and advanced under the same loan lock.
 */

const MANDATE_POOL_A_NAME = "Mandate Pool A";

type LoanRow = typeof loans.$inferSelect;

/** What a loan still owes, by bucket. A loan that isn't funded-and-owing owes nothing. */
export interface OutstandingParts {
  principalCents: bigint;
  feeCents: bigint;
  lateFeeCents: bigint;
  penaltyCents: bigint;
}

/**
 * What's still owed on a loan. `outstanding_cents` is the base principal +
 * fee still owed; the waterfall always pays the fee before principal, so
 * the fee/principal split is derived from it: paid so far = (P + F) −
 * outstanding, of which min(paid, F) went to the fee. Late fees and the
 * penalty are their own outstanding columns (P4).
 */
export function outstandingParts(loan: LoanRow): OutstandingParts {
  if (!isOwingStatus(loan.status)) {
    return { principalCents: 0n, feeCents: 0n, lateFeeCents: 0n, penaltyCents: 0n };
  }
  const paid = loan.principalCents + loan.feeCents - loan.outstandingCents;
  const feePaid = paid < loan.feeCents ? paid : loan.feeCents;
  const feeCents = loan.feeCents - feePaid;
  const principalCents = loan.outstandingCents - feeCents;
  if (paid < 0n || principalCents < 0n) {
    throw new Error(`loan ${loan.id} has an inconsistent outstanding balance ${loan.outstandingCents.toString()}`);
  }
  return {
    principalCents,
    feeCents,
    lateFeeCents: loan.lateFeeOutstandingCents,
    penaltyCents: loan.penaltyOutstandingCents,
  };
}

/** Everything a loan still owes: base outstanding + late fees + penalty (0 unless owing). */
export function totalDueCents(loan: LoanRow): bigint {
  if (!isOwingStatus(loan.status)) {
    return 0n;
  }
  return loan.outstandingCents + loan.lateFeeOutstandingCents + loan.penaltyOutstandingCents;
}

async function appendEvent(
  tx: Db,
  worldId: string,
  event: { type: string; aggregateType: string; aggregateId: string; simAt: Date; payload?: Record<string, unknown> },
): Promise<string> {
  const [row] = await scoped(tx, worldId).insert(events, {
    type: event.type,
    aggregateType: event.aggregateType,
    aggregateId: event.aggregateId,
    payload: event.payload ?? null,
    occurredSimAt: event.simAt,
  });
  return row!.id;
}

function dollars(cents: bigint): string {
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  return `${negative ? "-" : ""}$${(abs / 100n).toString()}.${(abs % 100n).toString().padStart(2, "0")}`;
}

/** Inserts a notice visible to the agent (get_status/get_loan) and its owner (dashboard). */
export async function insertNotice(
  tx: Db,
  worldId: string,
  notice: { agentId: string; principalId: string | null; kind: string; loanId: string | null; simAt: Date; body: string },
): Promise<void> {
  await scoped(tx, worldId).insert(agentNotices, {
    agentId: notice.agentId,
    principalId: notice.principalId,
    kind: notice.kind,
    loanId: notice.loanId,
    simAt: notice.simAt,
    body: notice.body,
  });
}

/** Locks the world's note series row then the loan row (the repayment capture's lock order). */
async function lockSeriesThenLoan(tx: Db, worldId: string, loanId: string): Promise<LoanRow | undefined> {
  await scoped(tx, worldId).forUpdate(noteSeries, eq(noteSeries.name, MANDATE_POOL_A_NAME));
  const [loan] = await scoped(tx, worldId).forUpdate(loans, eq(loans.id, loanId));
  return loan;
}

// ---------------------------------------------------------------------
// Penalty accrual
// ---------------------------------------------------------------------

/**
 * Accrues the rate penalty on a LOCKED loan row up to `simNow` (whole days
 * late), if the `penalty` step has started and the loan still owes.
 * Writes the loan row and returns it (unchanged when nothing accrued).
 * Callers hold the loan's row lock (processDue's accrual transaction, the
 * repayment capture — so a cure pays the penalty up to the cure date).
 */
export async function accruePenaltyLocked(tx: Db, worldId: string, loan: LoanRow, simNow: Date): Promise<LoanRow> {
  if (!isOwingStatus(loan.status) || loan.penaltyAccruedDays <= 0) {
    return loan;
  }
  const days = daysLate(loan.dueSimAt, simNow);
  if (days <= loan.penaltyAccruedDays) {
    return loan;
  }
  const add = penaltyIncrement(outstandingParts(loan).principalCents, loan.penaltyAccruedDays, days);
  const [updated] = await scoped(tx, worldId).update(
    loans,
    {
      penaltyAccruedDays: days,
      penaltyCents: loan.penaltyCents + add,
      penaltyOutstandingCents: loan.penaltyOutstandingCents + add,
    },
    and(eq(loans.id, loan.id), eq(loans.penaltyAccruedDays, loan.penaltyAccruedDays))!,
  );
  if (!updated) {
    throw new Error(`loan ${loan.id} penalty accrual changed under its row lock`);
  }
  return updated;
}

// ---------------------------------------------------------------------
// Ladder steps
// ---------------------------------------------------------------------

async function applyLateStep(tx: Db, worldId: string, loan: LoanRow, at: Date, days: number): Promise<Record<string, unknown>> {
  const fee = lateFeeCents(outstandingParts(loan).principalCents);
  const next = transition(fromDbStatus(loan.status), "MARK_LATE");
  const [updated] = await scoped(tx, worldId).update(
    loans,
    {
      status: toDbStatus(next),
      delinquencyStep: "late",
      dpd: days,
      lateFeesCents: loan.lateFeesCents + fee,
      lateFeeOutstandingCents: loan.lateFeeOutstandingCents + fee,
    },
    and(eq(loans.id, loan.id), eq(loans.status, loan.status), isNull(loans.delinquencyStep))!,
  );
  if (!updated) {
    throw new Error(`loan ${loan.id} changed under its row lock (late step)`);
  }
  const eventId = await appendEvent(tx, worldId, {
    type: "loan.late",
    aggregateType: "loan",
    aggregateId: loan.id,
    simAt: at,
    payload: { late_fee_cents: Number(fee), days_late: 1 },
  });
  const agent = await scoped(tx, worldId).findOne(agents, eq(agents.id, loan.agentId));
  await insertNotice(tx, worldId, {
    agentId: loan.agentId,
    principalId: agent?.principalId ?? null,
    kind: "late",
    loanId: loan.id,
    simAt: at,
    body:
      `Loan ${loan.id} is past due. A late fee of ${dollars(fee)} has been added. ` +
      "From 3 days late a rate penalty of 2% a year on the outstanding principal accrues daily; at 7 days late " +
      "the loan becomes substandard, the agent is restricted and its owner's mandate is frozen. " +
      "Repay with repay_loan (late fees and the penalty are paid first).",
  });
  // Score history: a late repayment costs 15 points (the scorecard derives it from the loan's status).
  const score = await scoreAgent(tx, worldId, loan.agentId, at);
  await scoped(tx, worldId).insert(scoreHistory, {
    subjectType: "agent",
    subjectId: loan.agentId,
    delta: LATE_SCORE_DELTA,
    reasonCode: "loan_late",
    sourceEventId: eventId,
    score: score.score,
    grade: score.grade,
    components: score.components,
    simAt: at,
  });
  return { late_fee_cents: Number(fee) };
}

async function applyPenaltyStep(
  tx: Db,
  worldId: string,
  loan: LoanRow,
  at: Date,
  simNow: Date,
): Promise<Record<string, unknown>> {
  const [started] = await scoped(tx, worldId).update(
    loans,
    { delinquencyStep: "penalty" },
    and(eq(loans.id, loan.id), eq(loans.delinquencyStep, "late"), eq(loans.penaltyAccruedDays, 0))!,
  );
  if (!started) {
    throw new Error(`loan ${loan.id} changed under its row lock (penalty step)`);
  }
  // Accrual starts at day 0 and runs to today's days late (≥ 3) in one go.
  const fromZero = await accrueFromZero(tx, worldId, started, simNow);
  await appendEvent(tx, worldId, {
    type: "loan.penalty_started",
    aggregateType: "loan",
    aggregateId: loan.id,
    simAt: at,
    payload: { penalty_cents: Number(fromZero.penaltyCents), days_late: fromZero.penaltyAccruedDays },
  });
  const agent = await scoped(tx, worldId).findOne(agents, eq(agents.id, loan.agentId));
  await insertNotice(tx, worldId, {
    agentId: loan.agentId,
    principalId: agent?.principalId ?? null,
    kind: "penalty",
    loanId: loan.id,
    simAt: at,
    body:
      `Loan ${loan.id} is 3 days past due: a rate penalty of 2% a year on the outstanding principal now ` +
      `accrues daily (${dollars(fromZero.penaltyCents)} so far). At 7 days late the loan becomes substandard.`,
  });
  return { penalty_cents: Number(fromZero.penaltyCents) };
}

/** Starts the penalty accrual (penalty_accrued_days 0 → days late) on the locked, just-updated row. */
async function accrueFromZero(tx: Db, worldId: string, loan: LoanRow, simNow: Date): Promise<LoanRow> {
  const days = daysLate(loan.dueSimAt, simNow);
  const add = penaltyIncrement(outstandingParts(loan).principalCents, 0, days);
  const [updated] = await scoped(tx, worldId).update(
    loans,
    {
      penaltyAccruedDays: days,
      penaltyCents: loan.penaltyCents + add,
      penaltyOutstandingCents: loan.penaltyOutstandingCents + add,
    },
    and(eq(loans.id, loan.id), eq(loans.penaltyAccruedDays, 0))!,
  );
  if (!updated) {
    throw new Error(`loan ${loan.id} penalty accrual changed under its row lock`);
  }
  return updated;
}

async function applySubstandardStep(tx: Db, worldId: string, loan: LoanRow, at: Date): Promise<Record<string, unknown>> {
  const next = transition(fromDbStatus(loan.status), "MARK_SUBSTANDARD");
  const [updated] = await scoped(tx, worldId).update(
    loans,
    { status: toDbStatus(next), delinquencyStep: "substandard" },
    and(eq(loans.id, loan.id), eq(loans.status, loan.status), eq(loans.delinquencyStep, "penalty"))!,
  );
  if (!updated) {
    throw new Error(`loan ${loan.id} changed under its row lock (substandard step)`);
  }
  await appendEvent(tx, worldId, {
    type: "loan.substandard",
    aggregateType: "loan",
    aggregateId: loan.id,
    simAt: at,
    payload: { total_due_cents: Number(totalDueCents(updated)) },
  });
  // The agent is restricted (can repay, can't borrow — runTool's MONEY_IN_TOOLS).
  // A frozen agent stays frozen (its owner's choice); unfreezing it lands on restricted.
  const restricted = await scoped(tx, worldId).update(
    agents,
    { status: "restricted" },
    and(eq(agents.id, loan.agentId), eq(agents.status, "active"))!,
  );
  if (restricted.length === 1) {
    await appendEvent(tx, worldId, {
      type: "agent.restricted",
      aggregateType: "agent",
      aggregateId: loan.agentId,
      simAt: at,
      payload: { reason: "loan_substandard", loan_id: loan.id },
    });
  }
  const agent = await scoped(tx, worldId).findOne(agents, eq(agents.id, loan.agentId));
  await insertNotice(tx, worldId, {
    agentId: loan.agentId,
    principalId: agent?.principalId ?? null,
    kind: "substandard",
    loanId: loan.id,
    simAt: at,
    body:
      `Loan ${loan.id} is 7 days past due and now substandard: ${dollars(totalDueCents(updated))} is owed. ` +
      "The agent is restricted (it can still repay, but cannot borrow) and the owner's mandate is frozen " +
      "for new loans across all of their agents until this is repaid. At 10 days late the loan is charged off " +
      "and the owner's guarantee is invoked.",
  });
  return { total_due_cents: Number(totalDueCents(updated)) };
}

export type StepResult = "applied" | "skipped";

/**
 * Applies ONE ladder step to a loan in its own transaction, exactly once
 * (see the file comment). `skipped` when the loan no longer owes, isn't
 * due for the step yet, the previous step isn't its last one, or the
 * step's row already exists.
 */
export async function applyLadderStep(
  db: Db,
  worldId: string,
  loanId: string,
  step: LadderStep,
  simNow: Date,
): Promise<StepResult> {
  return db.transaction(async (tx): Promise<StepResult> => {
    const loan = await lockSeriesThenLoan(tx, worldId, loanId);
    if (!loan || !isOwingStatus(loan.status) || totalDueCents(loan) <= 0n) {
      return "skipped";
    }
    const at = stepDueAt(loan.dueSimAt, step);
    if (at.getTime() > simNow.getTime()) {
      return "skipped";
    }
    if (loan.delinquencyStep !== previousStep(step)) {
      return "skipped";
    }
    const [row] = await scoped(tx, worldId).insertOnConflictDoNothing(
      loanLadderSteps,
      { loanId: loan.id, step, dueSimAt: at, appliedSimAt: simNow },
      [loanLadderSteps.worldId, loanLadderSteps.loanId, loanLadderSteps.step],
    );
    if (!row) {
      return "skipped";
    }
    const days = daysLate(loan.dueSimAt, simNow);
    let detail: Record<string, unknown>;
    switch (step) {
      case "late":
        detail = await applyLateStep(tx, worldId, loan, at, days);
        break;
      case "penalty":
        detail = await applyPenaltyStep(tx, worldId, loan, at, simNow);
        break;
      case "substandard":
        detail = await applySubstandardStep(tx, worldId, loan, at);
        break;
    }
    await scoped(tx, worldId).update(loanLadderSteps, { detail }, eq(loanLadderSteps.id, row.id));
    return "applied";
  });
}

/** Accrues the penalty (and refreshes `dpd`) for one loan up to `simNow`, in its own transaction. */
async function accrueLoan(db: Db, worldId: string, loanId: string, simNow: Date): Promise<boolean> {
  return db.transaction(async (tx) => {
    const loan = await lockSeriesThenLoan(tx, worldId, loanId);
    if (!loan || !isOwingStatus(loan.status)) {
      return false;
    }
    const after = await accruePenaltyLocked(tx, worldId, loan, simNow);
    const days = daysLate(loan.dueSimAt, simNow);
    if (loan.delinquencyStep && days > after.dpd) {
      await scoped(tx, worldId).update(loans, { dpd: days }, eq(loans.id, loan.id));
    }
    return after.penaltyCents !== loan.penaltyCents;
  });
}

export interface ProcessDueReport {
  loans: number;
  steps: { late: number; penalty: number; substandard: number };
  accrued: number;
  errors: { loanId: string; message: string }[];
}

/**
 * Runs the delinquency ladder for one world at `simNow` (the tick cron for
 * every active world; the private-world advance after each day). For each
 * ACTIVE/LATE/SUBSTANDARD loan more than a day past due: every step that
 * is due and not yet applied, in order, each in its own transaction; then
 * the daily penalty accrual. Idempotent — running it twice, or two runs at
 * once, applies each step once. A loan that fails is reported and the rest
 * continue. Never call inside a transaction.
 */
export async function processDue(db: Db, worldId: string, simNow: Date): Promise<ProcessDueReport> {
  const report: ProcessDueReport = { loans: 0, steps: { late: 0, penalty: 0, substandard: 0 }, accrued: 0, errors: [] };
  const lateBy = new Date(simNow.getTime() - 86_400_000);
  const candidates = await scoped(db, worldId).selectFields(
    loans,
    { id: loans.id, dueSimAt: loans.dueSimAt, delinquencyStep: loans.delinquencyStep },
    and(inArray(loans.status, [...OWING_LOAN_DB_STATUSES]), lte(loans.dueSimAt, lateBy))!,
    asc(loans.dueSimAt),
  );
  for (const candidate of candidates) {
    report.loans += 1;
    try {
      for (const step of dueSteps(candidate.delinquencyStep, daysLate(candidate.dueSimAt, simNow))) {
        if ((await applyLadderStep(db, worldId, candidate.id, step, simNow)) === "applied") {
          report.steps[step] += 1;
        }
      }
      if (await accrueLoan(db, worldId, candidate.id, simNow)) {
        report.accrued += 1;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[collections] loan ${candidate.id} in world ${worldId}: ${message}`);
      report.errors.push({ loanId: candidate.id, message });
    }
  }
  return report;
}

// ---------------------------------------------------------------------
// Cure
// ---------------------------------------------------------------------

/**
 * Inside the repayment transaction that cured a delinquent loan (LATE or
 * SUBSTANDARD → REPAID): a `restricted` agent with no other substandard
 * loan goes back to `active` (a frozen agent stays frozen), and a `cured`
 * notice is written.
 */
export async function onLoanCured(tx: Db, worldId: string, loan: LoanRow, simAt: Date): Promise<void> {
  const stillSubstandard = await scoped(tx, worldId).selectFields(
    loans,
    { id: loans.id },
    and(eq(loans.agentId, loan.agentId), eq(loans.status, "substandard"))!,
  );
  if (stillSubstandard.length === 0) {
    const restored = await scoped(tx, worldId).update(
      agents,
      { status: "active" },
      and(eq(agents.id, loan.agentId), eq(agents.status, "restricted"))!,
    );
    if (restored.length === 1) {
      await appendEvent(tx, worldId, {
        type: "agent.restored",
        aggregateType: "agent",
        aggregateId: loan.agentId,
        simAt,
        payload: { reason: "loan_cured", loan_id: loan.id },
      });
    }
  }
  await appendEvent(tx, worldId, {
    type: "loan.cured",
    aggregateType: "loan",
    aggregateId: loan.id,
    simAt,
    payload: { late_fees_cents: Number(loan.lateFeesCents), penalty_cents: Number(loan.penaltyCents) },
  });
  const agent = await scoped(tx, worldId).findOne(agents, eq(agents.id, loan.agentId));
  await insertNotice(tx, worldId, {
    agentId: loan.agentId,
    principalId: agent?.principalId ?? null,
    kind: "cured",
    loanId: loan.id,
    simAt,
    body:
      `Loan ${loan.id} is repaid in full, including ${dollars(loan.lateFeesCents)} in late fees and ` +
      `${dollars(loan.penaltyCents)} in rate penalty. ` +
      (stillSubstandard.length === 0 ? "Restrictions from this loan are lifted." : "Another loan is still substandard."),
  });
}

/** Whether `agentId` has a substandard loan (unfreezing such an agent lands on `restricted`). */
export async function agentHasSubstandardLoan(db: Db, worldId: string, agentId: string): Promise<boolean> {
  const rows = await scoped(db, worldId).selectFields(
    loans,
    { id: loans.id },
    and(eq(loans.agentId, agentId), eq(loans.status, "substandard"))!,
  );
  return rows.length > 0;
}

// ---------------------------------------------------------------------
// Notices (get_status / get_loan / ack_notices)
// ---------------------------------------------------------------------

export type NoticeRow = typeof agentNotices.$inferSelect;

/** The agent's unread notices (optionally for one loan), oldest first. */
export async function unreadNotices(db: Db, worldId: string, agentId: string, loanId?: string): Promise<NoticeRow[]> {
  const rows = await scoped(db, worldId).select(
    agentNotices,
    and(eq(agentNotices.agentId, agentId), isNull(agentNotices.readAt), loanId ? eq(agentNotices.loanId, loanId) : undefined)!,
  );
  return rows.sort((a, b) => a.simAt.getTime() - b.simAt.getTime() || a.createdAt.getTime() - b.createdAt.getTime());
}

/** Marks the agent's own notices read (all unread ones, or just `ids`); returns how many changed. */
export async function ackNotices(tx: Db, worldId: string, agentId: string, ids: string[] | null, readAt: Date): Promise<number> {
  const updated = await scoped(tx, worldId).update(
    agentNotices,
    { readAt },
    and(
      eq(agentNotices.agentId, agentId),
      isNull(agentNotices.readAt),
      ids ? inArray(agentNotices.id, ids) : undefined,
    )!,
  );
  return updated.length;
}

/** Notice view shared by get_status and get_loan. */
export function noticeView(row: NoticeRow) {
  return {
    notice_id: row.id,
    kind: row.kind,
    loan_id: row.loanId,
    sim_at: row.simAt.toISOString(),
    body: row.body,
  };
}
