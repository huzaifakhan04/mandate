import { and, eq, gt, inArray, ne } from "drizzle-orm";

import { getSimNow } from "../clock/clock";
import type { Db } from "../db/client";
import { agentNotices, agents, events, loanInstallments, loans, repaymentLinks, repayments } from "../db/schema";
import { scoped } from "../db/scoped";
import {
  MAX_AGENT_MOVES,
  planOrder,
  replan,
  simDate,
  validateMove,
  validatePlan,
  type FailureSignal,
  type InstallmentState,
  type InstallmentStatus,
  type MoveErrorCode,
  type PaymentSignal,
  type PlanErrorCode,
} from "../domain/installments";
import { fromDbStatus, OPEN_LOAN_DB_STATUSES, type LoanState } from "../domain/loanMachine";
import { totalDueCents } from "./collections";

/**
 * P7 — agent-driven repayment plans (`domain/installments.ts` holds the
 * rules). The agent proposes up to 4 dated installments for its own open
 * loan (`plan_repayments`) and may move an unpaid one
 * (`reschedule_installment`); the tick then re-plans every open plan from
 * payment events (`replanWorldInstallments`): payments since the plan are
 * allocated in date order (paid early / partial), a refunded payment or a
 * failed PayPal capture fails an installment, and a day that ends
 * uncovered marks it missed (notice) and — if the agent opted in — moves
 * it to the next sim day once.
 *
 * Guidance only: nothing here posts a journal or changes what the loan
 * owes, and the delinquency ladder still runs off `loans.due_sim_at`.
 * Writes take the loan row lock only (never the note series), so they
 * can't deadlock with a capture (series → loan) or the ladder.
 */

type LoanRow = typeof loans.$inferSelect;
export type InstallmentRow = typeof loanInstallments.$inferSelect;

const PAYMENT_EVENT = "loan.repayment_received";
const REFUND_EVENT = "loan.payment_refunded";
const SETTLED_EVENTS = ["loan.repaid", "loan.recovered"];

async function appendEvent(
  tx: Db,
  worldId: string,
  event: { type: string; aggregateId: string; simAt: Date; payload: Record<string, unknown> },
): Promise<bigint> {
  const [row] = await scoped(tx, worldId).insert(events, {
    type: event.type,
    aggregateType: "loan",
    aggregateId: event.aggregateId,
    payload: event.payload,
    occurredSimAt: event.simAt,
  });
  return row!.seq;
}

/** The agent's loan by id, or its one open loan when no id is given — locked. */
async function lockAgentLoan(tx: Db, worldId: string, agentId: string, loanId: string | null): Promise<LoanRow | undefined> {
  const where = loanId
    ? and(eq(loans.id, loanId), eq(loans.agentId, agentId))!
    : and(eq(loans.agentId, agentId), inArray(loans.status, [...OPEN_LOAN_DB_STATUSES]))!;
  const [loan] = await scoped(tx, worldId).forUpdate(loans, where);
  return loan;
}

export async function loanInstallmentRows(db: Db, worldId: string, loanId: string): Promise<InstallmentRow[]> {
  return planOrder(await scoped(db, worldId).select(loanInstallments, eq(loanInstallments.loanId, loanId)));
}

// ---------------------------------------------------------------------
// plan_repayments
// ---------------------------------------------------------------------

export type PlanRepaymentsOutcome =
  | { outcome: "not_found" }
  | { outcome: "invalid_transition"; state: LoanState }
  | { outcome: "invalid_plan"; code: PlanErrorCode; message: string }
  | { outcome: "plan_exists"; loanId: string }
  | { outcome: "planned"; loanId: string; replay: boolean };

export async function planRepayments(
  tx: Db,
  worldId: string,
  agentId: string,
  simNow: Date,
  input: {
    loanId: string | null;
    installments: ReadonlyArray<{ date: string; amountCents: bigint }>;
    autoReschedule: boolean;
  },
): Promise<PlanRepaymentsOutcome> {
  const loan = await lockAgentLoan(tx, worldId, agentId, input.loanId);
  if (!loan) {
    return { outcome: "not_found" };
  }
  const existing = await loanInstallmentRows(tx, worldId, loan.id);
  if (existing.length > 0) {
    // Idempotent by content: the same plan again is a replay; a different one is a conflict.
    const original = existing.slice().sort((a, b) => a.seq - b.seq);
    const same =
      original.length === input.installments.length &&
      original.every(
        (row, i) =>
          simDate(row.originalDueOn) === input.installments[i]!.date &&
          row.amountCents === input.installments[i]!.amountCents &&
          row.autoReschedule === input.autoReschedule,
      );
    return same ? { outcome: "planned", loanId: loan.id, replay: true } : { outcome: "plan_exists", loanId: loan.id };
  }
  if (loan.status !== "active") {
    return { outcome: "invalid_transition", state: fromDbStatus(loan.status) };
  }
  const totalDue = totalDueCents(loan);
  const checked = validatePlan({ installments: input.installments, simNow, loanDueSimAt: loan.dueSimAt, totalDueCents: totalDue });
  if (!checked.ok) {
    return { outcome: "invalid_plan", code: checked.code, message: checked.message };
  }
  const planEventSeq = await appendEvent(tx, worldId, {
    type: "loan.repayment_planned",
    aggregateId: loan.id,
    simAt: simNow,
    payload: {
      auto_reschedule: input.autoReschedule,
      total_due_cents: Number(totalDue),
      installments: checked.rows.map((row) => ({ installment: row.seq, due_on: simDate(row.dueOn), amount_cents: Number(row.amountCents) })),
    },
  });
  for (const row of checked.rows) {
    await scoped(tx, worldId).insert(loanInstallments, {
      loanId: loan.id,
      agentId,
      seq: row.seq,
      dueOn: row.dueOn,
      originalDueOn: row.dueOn,
      amountCents: row.amountCents,
      autoReschedule: input.autoReschedule,
      planEventSeq,
      plannedTotalCents: totalDue,
    });
  }
  return { outcome: "planned", loanId: loan.id, replay: false };
}

// ---------------------------------------------------------------------
// reschedule_installment
// ---------------------------------------------------------------------

export type RescheduleOutcome =
  | { outcome: "not_found" }
  | { outcome: "no_plan" }
  | { outcome: "invalid_transition"; state: LoanState }
  | { outcome: "invalid_move"; code: MoveErrorCode; message: string }
  | { outcome: "moved"; loanId: string; from: string; to: string; movesLeft: number };

export async function rescheduleInstallment(
  tx: Db,
  worldId: string,
  agentId: string,
  simNow: Date,
  input: { loanId: string | null; installment: number; date: string },
): Promise<RescheduleOutcome> {
  const loan = await lockAgentLoan(tx, worldId, agentId, input.loanId);
  if (!loan) {
    return { outcome: "not_found" };
  }
  const rows = await loanInstallmentRows(tx, worldId, loan.id);
  if (rows.length === 0) {
    return { outcome: "no_plan" };
  }
  const row = rows.find((r) => r.seq === input.installment);
  if (!row) {
    return { outcome: "not_found" };
  }
  if (!["active", "late", "substandard"].includes(loan.status)) {
    return { outcome: "invalid_transition", state: fromDbStatus(loan.status) };
  }
  const checked = validateMove({ installment: row, newDate: input.date, simNow, loanDueSimAt: loan.dueSimAt });
  if (!checked.ok) {
    return { outcome: "invalid_move", code: checked.code, message: checked.message };
  }
  const from = simDate(row.dueOn);
  const updated = await scoped(tx, worldId).update(
    loanInstallments,
    { dueOn: checked.dueOn, moves: row.moves + 1, status: "planned", updatedAt: new Date() },
    and(eq(loanInstallments.id, row.id), eq(loanInstallments.moves, row.moves), ne(loanInstallments.status, "paid"))!,
  );
  if (updated.length !== 1) {
    throw new Error(`installment ${row.id} changed under the loan lock`);
  }
  await appendEvent(tx, worldId, {
    type: "loan.installment_rescheduled",
    aggregateId: loan.id,
    simAt: simNow,
    payload: { installment: row.seq, from, to: input.date, by: "agent", moves: row.moves + 1 },
  });
  return { outcome: "moved", loanId: loan.id, from, to: input.date, movesLeft: MAX_AGENT_MOVES - row.moves - 1 };
}

// ---------------------------------------------------------------------
// The tick: re-planning from payment events
// ---------------------------------------------------------------------

function toState(row: InstallmentRow): InstallmentState {
  return {
    id: row.id,
    seq: row.seq,
    dueOn: row.dueOn,
    amountCents: row.amountCents,
    paidCents: row.paidCents,
    status: row.status as InstallmentStatus,
    autoReschedule: row.autoReschedule,
    autoMoved: row.autoMoved,
    paidSimAt: row.paidSimAt,
    missedSimAt: row.missedSimAt,
    failedSimAt: row.failedSimAt,
    failureRef: row.failureRef,
  };
}

function payloadOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/** The payment signals since the plan: repayments received (net of refunded ones) and the settle time. */
async function paymentSignals(
  db: Db,
  worldId: string,
  loanId: string,
  planEventSeq: bigint,
): Promise<{ payments: PaymentSignal[]; settledAt: Date | null }> {
  const rows = (
    await scoped(db, worldId).select(
      events,
      and(
        eq(events.aggregateId, loanId),
        inArray(events.type, [PAYMENT_EVENT, REFUND_EVENT, ...SETTLED_EVENTS]),
        gt(events.seq, planEventSeq),
      )!,
    )
  ).sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0));
  const refunded = new Set(
    rows.filter((r) => r.type === REFUND_EVENT).map((r) => String(payloadOf(r.payload).repayment_id ?? "")),
  );
  const payments = rows
    .filter((r) => r.type === PAYMENT_EVENT)
    .map((r) => {
      const p = payloadOf(r.payload);
      const key = String(p.repayment_id ?? r.id);
      const applied = BigInt(Number(p.gross_cents ?? 0)) - BigInt(Number(p.remainder_cents ?? 0));
      return { key, simAt: r.occurredSimAt, appliedCents: applied > 0n ? applied : 0n, refunded: refunded.has(key) };
    });
  const settled = rows.filter((r) => SETTLED_EVENTS.includes(r.type)).pop();
  return { payments, settledAt: settled?.occurredSimAt ?? null };
}

/** Failed checkouts (direct or invoice) for the loan opened after the plan, oldest first. */
async function failureSignals(db: Db, worldId: string, loanId: string, plannedAt: Date): Promise<FailureSignal[]> {
  const links = await scoped(db, worldId).select(
    repaymentLinks,
    and(eq(repaymentLinks.loanId, loanId), eq(repaymentLinks.status, "failed"), inArray(repaymentLinks.kind, ["direct", "invoice"]))!,
  );
  return links
    .filter((l) => l.createdAt >= plannedAt)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .map((l) => ({ ref: `link:${l.id}`, simAt: l.createdAt }));
}

/** Re-plans one loan's installments; returns how many installments changed. */
export async function replanLoanInstallments(db: Db, worldId: string, loanId: string, simNow: Date): Promise<number> {
  return db.transaction(async (tx) => {
    const [loan] = await scoped(tx, worldId).forUpdate(loans, eq(loans.id, loanId));
    if (!loan) {
      return 0;
    }
    const rows = await loanInstallmentRows(tx, worldId, loanId);
    if (rows.length === 0) {
      return 0;
    }
    const planEventSeq = rows[0]!.planEventSeq;
    const plannedAt = rows.reduce((min, r) => (r.createdAt < min ? r.createdAt : min), rows[0]!.createdAt);
    const { payments, settledAt } = await paymentSignals(tx, worldId, loanId, planEventSeq);
    const failures = await failureSignals(tx, worldId, loanId, plannedAt);
    const settled = loan.status === "repaid" || loan.status === "recovered" ? { simAt: settledAt ?? simNow } : null;
    const changes = replan({
      installments: rows.map(toState),
      payments,
      failures,
      simNow,
      loanDueSimAt: loan.dueSimAt,
      settled,
    });
    const owner = changes.some((c) => c.notices.length > 0)
      ? await scoped(tx, worldId).findOne(agents, eq(agents.id, loan.agentId))
      : undefined;
    for (const change of changes) {
      const n = change.next;
      await scoped(tx, worldId).update(
        loanInstallments,
        {
          dueOn: n.dueOn,
          paidCents: n.paidCents,
          status: n.status,
          autoMoved: n.autoMoved,
          paidSimAt: n.paidSimAt,
          missedSimAt: n.missedSimAt,
          failedSimAt: n.failedSimAt,
          failureRef: n.failureRef,
          updatedAt: new Date(),
        },
        eq(loanInstallments.id, change.id),
      );
      for (const notice of change.notices) {
        await scoped(tx, worldId).insert(agentNotices, {
          agentId: loan.agentId,
          principalId: owner?.principalId ?? loan.principalId,
          kind: notice.kind,
          loanId: loan.id,
          simAt: simNow,
          body: notice.body,
        });
      }
      if (change.notices.some((x) => x.kind === "installment_rescheduled")) {
        await appendEvent(tx, worldId, {
          type: "loan.installment_rescheduled",
          aggregateId: loan.id,
          simAt: simNow,
          payload: { installment: n.seq, to: simDate(n.dueOn), by: "bank", reason: "missed" },
        });
      }
    }
    return changes.length;
  });
}

export interface ReplanReport {
  loans: number;
  changed: number;
  errors: Array<{ loanId: string; message: string }>;
}

/** The tick's step: every loan in the world with an installment not yet paid. */
export async function replanWorldInstallments(db: Db, worldId: string, simNow: Date): Promise<ReplanReport> {
  const open = await scoped(db, worldId).selectFields(
    loanInstallments,
    { loanId: loanInstallments.loanId },
    ne(loanInstallments.status, "paid"),
  );
  const loanIds = [...new Set(open.map((r) => r.loanId))].sort();
  const report: ReplanReport = { loans: loanIds.length, changed: 0, errors: [] };
  for (const loanId of loanIds) {
    try {
      report.changed += await replanLoanInstallments(db, worldId, loanId, simNow);
    } catch (err) {
      report.errors.push({ loanId, message: err instanceof Error ? err.message : String(err) });
    }
  }
  return report;
}

// ---------------------------------------------------------------------
// Refunds (webhook)
// ---------------------------------------------------------------------

/**
 * A PayPal refund or reversal of a repayment capture: records
 * `loan.payment_refunded` once per capture (the plan treats that payment
 * as not made). The ledger is untouched — refunds are handled by hand,
 * like a mismatched capture. Returns whether the capture was ours.
 */
export async function recordRepaymentRefund(
  db: Db,
  worldId: string,
  args: { captureId: string; reason: string },
): Promise<"recorded" | "duplicate" | "unknown"> {
  const repayment = await scoped(db, worldId).findOne(repayments, eq(repayments.captureId, args.captureId));
  if (!repayment) {
    return "unknown";
  }
  const prior = await scoped(db, worldId).select(
    events,
    and(eq(events.aggregateId, repayment.loanId), eq(events.type, REFUND_EVENT))!,
  );
  if (prior.some((e) => payloadOf(e.payload).repayment_id === repayment.id)) {
    return "duplicate";
  }
  await appendEvent(db, worldId, {
    type: REFUND_EVENT,
    aggregateId: repayment.loanId,
    simAt: await getSimNow(db, worldId),
    payload: { repayment_id: repayment.id, reason: args.reason },
  });
  console.warn(`[installments] repayment ${repayment.id} (loan ${repayment.loanId}) was ${args.reason} by PayPal`);
  return "recorded";
}

// ---------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------

export interface InstallmentView {
  installment: number;
  due_on: string;
  original_due_on: string;
  amount_cents: number;
  paid_cents: number;
  status: string;
  moves: number;
  moves_left: number;
  auto_moved: boolean;
  paid_sim_at: string | null;
  missed_sim_at: string | null;
  failed_sim_at: string | null;
}

export interface RepaymentPlanView {
  auto_reschedule: boolean;
  planned_total_cents: number;
  paid_cents: number;
  installments: InstallmentView[];
  next_due: { installment: number; due_on: string; amount_left_cents: number } | null;
}

export function planView(rows: readonly InstallmentRow[]): RepaymentPlanView | null {
  if (rows.length === 0) {
    return null;
  }
  const ordered = planOrder(rows);
  const next = ordered.find((r) => r.status !== "paid");
  return {
    auto_reschedule: ordered[0]!.autoReschedule,
    planned_total_cents: Number(ordered[0]!.plannedTotalCents),
    paid_cents: ordered.reduce((sum, r) => sum + Number(r.paidCents), 0),
    installments: ordered.map((r) => ({
      installment: r.seq,
      due_on: simDate(r.dueOn),
      original_due_on: simDate(r.originalDueOn),
      amount_cents: Number(r.amountCents),
      paid_cents: Number(r.paidCents),
      status: r.status.toUpperCase(),
      moves: r.moves,
      moves_left: Math.max(0, MAX_AGENT_MOVES - r.moves),
      auto_moved: r.autoMoved,
      paid_sim_at: r.paidSimAt?.toISOString() ?? null,
      missed_sim_at: r.missedSimAt?.toISOString() ?? null,
      failed_sim_at: r.failedSimAt?.toISOString() ?? null,
    })),
    next_due: next
      ? { installment: next.seq, due_on: simDate(next.dueOn), amount_left_cents: Number(next.amountCents - next.paidCents) }
      : null,
  };
}

export async function repaymentPlanView(db: Db, worldId: string, loanId: string): Promise<RepaymentPlanView | null> {
  return planView(await loanInstallmentRows(db, worldId, loanId));
}

