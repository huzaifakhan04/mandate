import { and, asc, eq, inArray, isNull, lte } from "drizzle-orm";

import type { Db } from "../db/client";
import {
  agentNotices,
  agents,
  events,
  loanHolderLosses,
  loanLadderSteps,
  loans,
  noteSeries,
  notePositions,
  noteTransactions,
  principals,
  repaymentLinks,
  scoreHistory,
} from "../db/schema";
import { scoped } from "../db/scoped";
import {
  LATE_SCORE_DELTA,
  daysLate,
  dueSteps,
  lateFeeCents,
  penaltyDays,
  penaltyIncrement,
  previousStep,
  stepDueAt,
  type LadderStep,
} from "../domain/delinquency";
import { distribute } from "../domain/distribution";
import {
  DELINQUENT_LOAN_DB_STATUSES,
  fromDbStatus,
  isOwingStatus,
  OWING_LOAN_DB_STATUSES,
  toDbStatus,
  transition,
} from "../domain/loanMachine";
import { postJournal } from "../ledger/postJournal";
import { buildCreateOrderRequest, enqueueOperation } from "../paypal/operations";
import { scoreAgent } from "./credit";
import { checkoutUrl, refreshGuaranteeLink } from "./paymentLinks";
import { railForWorld } from "./worlds";

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

/**
 * Everything a loan still owes: base outstanding + late fees + penalty
 * while owing; for a CHARGED_OFF loan (P4 Task 2) what is still
 * recoverable — the written-off total less what has been recovered; 0
 * otherwise.
 */
export function totalDueCents(loan: LoanRow): bigint {
  if (loan.status === "charged_off") {
    return recoverableCents(loan);
  }
  if (!isOwingStatus(loan.status)) {
    return 0n;
  }
  return loan.outstandingCents + loan.lateFeeOutstandingCents + loan.penaltyOutstandingCents;
}

/** P4 Task 2: what a charged-off loan can still recover (0 for any other status). */
export function recoverableCents(loan: LoanRow): bigint {
  if (loan.status !== "charged_off") {
    return 0n;
  }
  const left = loan.chargeOffTotalCents - loan.recoveredCents;
  return left > 0n ? left : 0n;
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
  // P4 Task 2: the penalty stops at the charge-off day.
  const days = penaltyDays(loan.dueSimAt, simNow);
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
  const days = penaltyDays(loan.dueSimAt, simNow);
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

/**
 * P4 Task 2 — the +10 charge-off, on the LOCKED loan row (series → loan
 * locks held; positions are locked here, after the loan). In this one
 * transaction:
 * - the penalty is accrued through the charge-off day (and stops there);
 * - SUBSTANDARD → CHARGED_OFF; the base outstanding, late fees and penalty
 *   are written off (buckets → 0) and recorded on the loan
 *   (`charge_off_principal_cents`, `charge_off_total_cents`);
 * - journal: Dr `provision_expense` / Cr `allowance_for_losses` (P), then
 *   Dr `allowance_for_losses` / Cr `loans_receivable` (P). The base fee,
 *   late fees and penalty were never journaled (fee income on collection,
 *   P1/Task 1) — writing them off posts nothing;
 * - note holders bear the principal loss pro rata by their units at this
 *   moment (less their own pending redemptions, so a redemption already
 *   in flight can't drive units negative): L = min(P, Σ units), shares by
 *   `distribute` (Σ = L), Dr `notes_payable[holder_i]` / Cr
 *   `provision_expense` L, units reduced by the same amounts (Ruling T:
 *   units == −notes_payable[holder]); the bank's capital absorbs P − L;
 *   each share recorded in `loan_holder_losses` for recovery;
 * - the principal's guarantee: a `guarantee` `repayment_links` row for
 *   the written-off total, payable by the owner, and its queued
 *   `order.create` (purpose `guarantee`, sourceId = loan id) — executed
 *   after commit by `processDue` (and the reconcile cron);
 * - `loan.charged_off` event and a notice to the agent and the owner.
 * The agent stays restricted and the mandate frozen until recovery.
 */
async function applyChargeOffStep(
  tx: Db,
  worldId: string,
  locked: LoanRow,
  at: Date,
): Promise<Record<string, unknown>> {
  const loan = await accruePenaltyLocked(tx, worldId, locked, at);
  const parts = outstandingParts(loan);
  const total = parts.principalCents + parts.feeCents + parts.lateFeeCents + parts.penaltyCents;
  const next = transition(fromDbStatus(loan.status), "CHARGE_OFF");

  // Holders' share of the principal loss, by units at this moment.
  const [series] = await scoped(tx, worldId).select(noteSeries, eq(noteSeries.name, MANDATE_POOL_A_NAME));
  const positions = series
    ? await scoped(tx, worldId).forUpdate(notePositions, eq(notePositions.seriesId, series.id))
    : [];
  const pending = positions.length
    ? await scoped(tx, worldId).select(
        noteTransactions,
        and(
          inArray(
            noteTransactions.positionId,
            positions.map((position) => position.id),
          ),
          eq(noteTransactions.kind, "redeem"),
          eq(noteTransactions.status, "pending"),
        )!,
      )
    : [];
  const available = positions.map((position) => {
    const pendingCents = pending
      .filter((row) => row.positionId === position.id)
      .reduce((sum, row) => sum + row.amountCents, 0n);
    const units = position.units - pendingCents;
    return { agentId: position.agentId, units: units > 0n ? units : 0n };
  });
  const totalUnits = available.reduce((sum, holder) => sum + holder.units, 0n);
  const holdersLoss = parts.principalCents < totalUnits ? parts.principalCents : totalUnits;
  const shares = distribute(available, holdersLoss).filter((share) => share.cents > 0n);

  const [updated] = await scoped(tx, worldId).update(
    loans,
    {
      status: toDbStatus(next),
      delinquencyStep: "charged_off",
      chargedOffAt: at,
      chargeOffPrincipalCents: parts.principalCents,
      chargeOffTotalCents: total,
      holdersLossCents: holdersLoss,
      dpd: daysLate(loan.dueSimAt, at),
      outstandingCents: 0n,
      lateFeeOutstandingCents: 0n,
      penaltyOutstandingCents: 0n,
    },
    and(eq(loans.id, loan.id), eq(loans.status, "substandard"), eq(loans.delinquencyStep, "substandard"))!,
  );
  if (!updated) {
    throw new Error(`loan ${loan.id} changed under its row lock (charge-off step)`);
  }

  if (parts.principalCents > 0n) {
    await postJournal(tx, {
      worldId,
      memo: "Loan charged off: provision",
      sourceType: "loans",
      sourceId: loan.id,
      simAt: at,
      idempotencyKey: `charge_off:${loan.id}:provision`,
      postings: [
        { accountCode: "provision_expense", amountCents: parts.principalCents },
        { accountCode: "allowance_for_losses", amountCents: -parts.principalCents },
      ],
    });
    await postJournal(tx, {
      worldId,
      memo: "Loan charged off: written off",
      sourceType: "loans",
      sourceId: loan.id,
      simAt: at,
      idempotencyKey: `charge_off:${loan.id}:write_off`,
      postings: [
        { accountCode: "allowance_for_losses", amountCents: parts.principalCents },
        { accountCode: "loans_receivable", amountCents: -parts.principalCents },
      ],
    });
  }
  if (shares.length > 0) {
    await postJournal(tx, {
      worldId,
      memo: "Loan charged off: note holders' share of the loss",
      sourceType: "loans",
      sourceId: loan.id,
      simAt: at,
      idempotencyKey: `charge_off:${loan.id}:holders`,
      postings: [
        ...shares.map((share) => ({
          accountCode: "notes_payable" as const,
          ownerRef: share.agentId,
          amountCents: share.cents,
        })),
        { accountCode: "provision_expense", amountCents: -holdersLoss },
      ],
    });
    for (const share of shares) {
      const position = positions.find((row) => row.agentId === share.agentId)!;
      await scoped(tx, worldId).update(notePositions, { units: position.units - share.cents }, eq(notePositions.id, position.id));
      await scoped(tx, worldId).insert(loanHolderLosses, { loanId: loan.id, agentId: share.agentId, lossCents: share.cents });
    }
  }

  // The principal's guarantee: a checkout for everything written off.
  const agent = await scoped(tx, worldId).findOne(agents, eq(agents.id, loan.agentId));
  const ownerId = loan.principalId ?? agent?.principalId ?? null;
  const owner = ownerId ? await tx.select().from(principals).where(eq(principals.id, ownerId)).limit(1) : [];
  const rail = await railForWorld(tx, worldId);
  const { operationId } = await enqueueOperation(tx, {
    worldId,
    rail,
    kind: "order.create",
    purpose: "guarantee",
    sourceId: loan.id,
    request: buildCreateOrderRequest({
      amountCents: total,
      description: `Guarantee: Mandate loan ${loan.id} to ${agent?.name ?? "your agent"} was charged off`.slice(0, 127),
      customId: loan.id,
      returnUrl: checkoutUrl("/checkout/guarantee/return"),
      cancelUrl: checkoutUrl("/checkout/guarantee/cancel"),
    }),
  });
  await scoped(tx, worldId).insert(repaymentLinks, {
    loanId: loan.id,
    kind: "guarantee",
    amountCents: total,
    payerHint: owner[0]?.email ?? null,
    status: "pending",
    createOpId: operationId,
  });

  const detail = {
    principal_cents: Number(parts.principalCents),
    fee_cents: Number(parts.feeCents),
    late_fee_cents: Number(parts.lateFeeCents),
    penalty_cents: Number(parts.penaltyCents),
    written_off_cents: Number(total),
    holders_loss_cents: Number(holdersLoss),
    bank_loss_cents: Number(parts.principalCents - holdersLoss),
    holders: shares.map((share) => ({ agent_id: share.agentId, loss_cents: Number(share.cents) })),
  };
  await appendEvent(tx, worldId, {
    type: "loan.charged_off",
    aggregateType: "loan",
    aggregateId: loan.id,
    simAt: at,
    payload: detail,
  });
  await insertNotice(tx, worldId, {
    agentId: loan.agentId,
    principalId: ownerId,
    kind: "charged_off",
    loanId: loan.id,
    simAt: at,
    body:
      `Loan ${loan.id} is 10 days past due and has been charged off: ${dollars(total)} is written off ` +
      `(${dollars(parts.principalCents)} principal, ${dollars(parts.feeCents)} fee, ${dollars(parts.lateFeeCents)} late fees, ` +
      `${dollars(parts.penaltyCents)} rate penalty). The owner's guarantee is invoked: a payment link for ${dollars(total)} ` +
      "is on the owner's dashboard. Any payment from now on — the guarantee, the invoice link or repay_loan — is a recovery; " +
      "the agent stays restricted and the mandate frozen until the full amount is recovered.",
  });
  return detail;
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
      case "charged_off":
        detail = await applyChargeOffStep(tx, worldId, loan, at);
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
  steps: Record<LadderStep, number>;
  accrued: number;
  errors: { loanId: string; message: string }[];
}

/**
 * Runs the delinquency ladder for one world at `simNow` (the tick cron for
 * every active world; the private-world advance after each day). For each
 * ACTIVE/LATE/SUBSTANDARD loan more than a day past due: every step that
 * is due and not yet applied, in order, each in its own transaction (P4
 * Task 2: after a `charged_off` step commits, the guarantee's order is
 * created); then the daily penalty accrual (which stops at charge-off). Idempotent — running it twice, or two runs at
 * once, applies each step once. A loan that fails is reported and the rest
 * continue. Never call inside a transaction.
 */
export async function processDue(db: Db, worldId: string, simNow: Date): Promise<ProcessDueReport> {
  const report: ProcessDueReport = {
    loans: 0,
    steps: { late: 0, penalty: 0, substandard: 0, charged_off: 0 },
    accrued: 0,
    errors: [],
  };
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
          if (step === "charged_off") {
            // After commit: create the guarantee's order (the reconcile cron retries a failure).
            await refreshGuaranteeLink(db, worldId, candidate.id, { ignoreBackoff: true }).catch((err: unknown) => {
              console.error(`[collections] guarantee link for loan ${candidate.id}: ${err instanceof Error ? err.message : String(err)}`);
            });
          }
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
  const cleared = await restoreAgentIfClear(tx, worldId, loan, simAt, "loan_cured");
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
      (cleared ? "Restrictions from this loan are lifted." : "Another loan is still substandard."),
  });
}

/**
 * A `restricted` agent with no other substandard or charged-off loan goes
 * back to `active` (a frozen agent stays frozen). Returns whether the
 * agent has no such loan left. Inside the cure / recovery transaction.
 */
async function restoreAgentIfClear(tx: Db, worldId: string, loan: LoanRow, simAt: Date, reason: string): Promise<boolean> {
  const stillDelinquent = await scoped(tx, worldId).selectFields(
    loans,
    { id: loans.id },
    and(eq(loans.agentId, loan.agentId), inArray(loans.status, [...DELINQUENT_LOAN_DB_STATUSES]))!,
  );
  if (stillDelinquent.length > 0) {
    return false;
  }
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
      payload: { reason, loan_id: loan.id },
    });
  }
  return true;
}

/**
 * P4 Task 2: inside the capture transaction that recovered on a
 * charged-off loan. `recovered` (→ RECOVERED, everything written off is
 * back): the agent is restored when it has no other delinquent loan, and
 * the freeze lifts; a `recovered` notice. Partial: a `recovery` notice.
 */
export async function onLoanRecovery(
  tx: Db,
  worldId: string,
  loan: LoanRow,
  simAt: Date,
  args: { recoveredNowCents: bigint; fullyRecovered: boolean },
): Promise<void> {
  const cleared = args.fullyRecovered ? await restoreAgentIfClear(tx, worldId, loan, simAt, "loan_recovered") : false;
  const agent = await scoped(tx, worldId).findOne(agents, eq(agents.id, loan.agentId));
  const left = loan.chargeOffTotalCents - loan.recoveredCents;
  await insertNotice(tx, worldId, {
    agentId: loan.agentId,
    principalId: loan.principalId ?? agent?.principalId ?? null,
    kind: args.fullyRecovered ? "recovered" : "recovery",
    loanId: loan.id,
    simAt,
    body: args.fullyRecovered
      ? `Loan ${loan.id}: the ${dollars(loan.chargeOffTotalCents)} written off at charge-off is fully recovered. ` +
        (cleared ? "Restrictions from this loan are lifted." : "Another loan is still substandard or charged off.")
      : `Loan ${loan.id}: ${dollars(args.recoveredNowCents)} recovered on the charged-off loan; ${dollars(left)} is still owed.`,
  });
}

/**
 * Whether `agentId` has a substandard (or, P4 Task 2, charged-off and not
 * yet recovered) loan — unfreezing such an agent lands on `restricted`.
 */
export async function agentHasSubstandardLoan(db: Db, worldId: string, agentId: string): Promise<boolean> {
  const rows = await scoped(db, worldId).selectFields(
    loans,
    { id: loans.id },
    and(eq(loans.agentId, agentId), inArray(loans.status, [...DELINQUENT_LOAN_DB_STATUSES]))!,
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
