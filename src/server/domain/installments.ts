/**
 * P7 — agent-driven repayment plans, as pure rules (no I/O). The services
 * (`services/installments.ts`) load rows and payment signals, call these,
 * and write the result; everything here is deterministic in its inputs.
 *
 * Days are sim days on the UTC calendar: an installment is "due on"
 * `YYYY-MM-DD` (stored as 00:00 UTC of that day) and is missed once the
 * world's sim clock passes the end of that day (00:00 UTC the day after)
 * without payments since the plan covering it.
 *
 * Plan rules (`validatePlan`): 1–4 installments, dates strictly increasing,
 * none before today (sim) nor after the loan's due date, positive amounts
 * summing exactly to the total due at plan time.
 *
 * Move rules (`validateMove`): an unpaid installment only, at most 2 agent
 * moves per installment, the new day at least 1 sim day ahead (tomorrow or
 * later) and never after the loan's due date.
 *
 * Re-planning (`replan`), run by the tick from payment events:
 * - payments since the plan (net of refunded ones) are allocated to the
 *   installments in date order — an early or larger payment marks the
 *   first ones `paid` and the rest of it shifts onto the next installment
 *   (a partial payment leaves that installment `planned` with
 *   `paid_cents` > 0);
 * - a once-paid installment whose payment was refunded → `failed`;
 * - each new failed PayPal capture for the loan → the first open
 *   installment `failed` (one signal fails one installment, once);
 * - a `planned` installment whose day ended uncovered → `missed` (notice);
 *   with `auto_reschedule` it is moved, once, to the next sim day (or
 *   today, if the clock already went past that) when that is still on or
 *   before the loan's due date, back to `planned`;
 * - a settled loan (REPAID / RECOVERED) → every installment `paid`.
 */

export const DAY_MS = 86_400_000;
export const MAX_INSTALLMENTS = 4;
export const MAX_AGENT_MOVES = 2;

export type InstallmentStatus = "planned" | "paid" | "missed" | "failed";

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** 00:00 UTC of the sim day `at` falls on. */
export function dayStart(at: Date): Date {
  return new Date(Math.floor(at.getTime() / DAY_MS) * DAY_MS);
}

/** The sim day of `at` as `YYYY-MM-DD`. */
export function simDate(at: Date): string {
  return dayStart(at).toISOString().slice(0, 10);
}

/** `YYYY-MM-DD` → 00:00 UTC of that day, or `null` for anything that isn't a real calendar date. */
export function parseSimDate(value: string): Date | null {
  const match = DATE_RE.exec(value);
  if (!match) {
    return null;
  }
  const at = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return simDate(at) === value ? at : null;
}

export function addDays(at: Date, days: number): Date {
  return new Date(at.getTime() + days * DAY_MS);
}

export type PlanErrorCode =
  | "too_many_installments"
  | "invalid_date"
  | "dates_not_increasing"
  | "date_in_past"
  | "date_after_due"
  | "amount_not_positive"
  | "amounts_do_not_sum";

export type PlanValidation =
  | { ok: true; rows: Array<{ seq: number; dueOn: Date; amountCents: bigint }> }
  | { ok: false; code: PlanErrorCode; message: string };

export function validatePlan(args: {
  installments: ReadonlyArray<{ date: string; amountCents: bigint }>;
  simNow: Date;
  loanDueSimAt: Date;
  totalDueCents: bigint;
}): PlanValidation {
  const { installments, simNow, loanDueSimAt, totalDueCents } = args;
  if (installments.length < 1 || installments.length > MAX_INSTALLMENTS) {
    return { ok: false, code: "too_many_installments", message: `Propose 1 to ${MAX_INSTALLMENTS} installments.` };
  }
  const today = dayStart(simNow);
  const lastDay = dayStart(loanDueSimAt);
  const rows: Array<{ seq: number; dueOn: Date; amountCents: bigint }> = [];
  let sum = 0n;
  for (const [index, item] of installments.entries()) {
    const dueOn = parseSimDate(item.date);
    if (!dueOn) {
      return { ok: false, code: "invalid_date", message: `Installment ${index + 1}: "${item.date}" is not a YYYY-MM-DD date.` };
    }
    if (dueOn < today) {
      return {
        ok: false,
        code: "date_in_past",
        message: `Installment ${index + 1} (${item.date}) is before today (${simDate(simNow)}, sim).`,
      };
    }
    if (dueOn > lastDay) {
      return {
        ok: false,
        code: "date_after_due",
        message: `Installment ${index + 1} (${item.date}) is after the loan's due date (${simDate(loanDueSimAt)}).`,
      };
    }
    const previous = rows[rows.length - 1];
    if (previous && dueOn <= previous.dueOn) {
      return { ok: false, code: "dates_not_increasing", message: "Installment dates must be strictly increasing." };
    }
    if (item.amountCents <= 0n) {
      return { ok: false, code: "amount_not_positive", message: `Installment ${index + 1} must be more than 0 cents.` };
    }
    sum += item.amountCents;
    rows.push({ seq: index + 1, dueOn, amountCents: item.amountCents });
  }
  if (sum !== totalDueCents) {
    return {
      ok: false,
      code: "amounts_do_not_sum",
      message: `Installments sum to ${sum.toString()} cents; they must sum to the ${totalDueCents.toString()} cents due now.`,
    };
  }
  return { ok: true, rows };
}

export type MoveErrorCode = "invalid_date" | "already_paid" | "move_limit" | "too_soon" | "date_after_due" | "same_date";

export type MoveValidation = { ok: true; dueOn: Date } | { ok: false; code: MoveErrorCode; message: string };

export function validateMove(args: {
  installment: { status: string; moves: number; dueOn: Date };
  newDate: string;
  simNow: Date;
  loanDueSimAt: Date;
}): MoveValidation {
  const { installment, newDate, simNow, loanDueSimAt } = args;
  const dueOn = parseSimDate(newDate);
  if (!dueOn) {
    return { ok: false, code: "invalid_date", message: `"${newDate}" is not a YYYY-MM-DD date.` };
  }
  if (installment.status === "paid") {
    return { ok: false, code: "already_paid", message: "That installment is already paid." };
  }
  if (installment.moves >= MAX_AGENT_MOVES) {
    return { ok: false, code: "move_limit", message: `An installment can be moved at most ${MAX_AGENT_MOVES} times.` };
  }
  const tomorrow = addDays(dayStart(simNow), 1);
  if (dueOn < tomorrow) {
    return {
      ok: false,
      code: "too_soon",
      message: `Move it at least 1 sim day ahead: ${simDate(tomorrow)} or later.`,
    };
  }
  if (dueOn > dayStart(loanDueSimAt)) {
    return {
      ok: false,
      code: "date_after_due",
      message: `${newDate} is after the loan's due date (${simDate(loanDueSimAt)}).`,
    };
  }
  if (dueOn.getTime() === installment.dueOn.getTime()) {
    return { ok: false, code: "same_date", message: `The installment is already due on ${newDate}.` };
  }
  return { ok: true, dueOn };
}

export interface InstallmentState {
  id: string;
  seq: number;
  dueOn: Date;
  amountCents: bigint;
  paidCents: bigint;
  status: InstallmentStatus;
  autoReschedule: boolean;
  autoMoved: boolean;
  paidSimAt: Date | null;
  missedSimAt: Date | null;
  failedSimAt: Date | null;
  failureRef: string | null;
}

/** A payment applied to the loan since the plan (`key` = the repayment id). */
export interface PaymentSignal {
  key: string;
  simAt: Date;
  appliedCents: bigint;
  refunded: boolean;
}

/** A failed PayPal capture/checkout for the loan (`ref` = `link:<id>`), oldest first. */
export interface FailureSignal {
  ref: string;
  simAt: Date;
}

export type InstallmentNoticeKind = "installment_missed" | "installment_rescheduled" | "installment_failed";

export interface ReplanChange {
  id: string;
  next: InstallmentState;
  notices: Array<{ kind: InstallmentNoticeKind; body: string }>;
}

function money(cents: bigint): string {
  return `$${(cents / 100n).toString()}.${(cents % 100n).toString().padStart(2, "0")}`;
}

/** Installments in plan order: by day, then by their position in the original plan. */
export function planOrder<T extends { dueOn: Date; seq: number }>(rows: readonly T[]): T[] {
  return rows.slice().sort((a, b) => a.dueOn.getTime() - b.dueOn.getTime() || a.seq - b.seq);
}

function same(a: InstallmentState, b: InstallmentState): boolean {
  return (
    a.dueOn.getTime() === b.dueOn.getTime() &&
    a.paidCents === b.paidCents &&
    a.status === b.status &&
    a.autoMoved === b.autoMoved &&
    (a.paidSimAt?.getTime() ?? null) === (b.paidSimAt?.getTime() ?? null) &&
    (a.missedSimAt?.getTime() ?? null) === (b.missedSimAt?.getTime() ?? null) &&
    (a.failedSimAt?.getTime() ?? null) === (b.failedSimAt?.getTime() ?? null) &&
    a.failureRef === b.failureRef
  );
}

export function replan(args: {
  installments: readonly InstallmentState[];
  payments: readonly PaymentSignal[];
  failures: readonly FailureSignal[];
  simNow: Date;
  loanDueSimAt: Date;
  /** REPAID / RECOVERED: the loan owes nothing more, so the plan is done. */
  settled: { simAt: Date } | null;
}): ReplanChange[] {
  const { simNow, loanDueSimAt, settled } = args;
  const ordered = planOrder(args.installments);
  const next = ordered.map((row) => ({ ...row }));
  const notices = new Map<string, ReplanChange["notices"]>(ordered.map((row) => [row.id, []]));

  // 1. Allocate payments (net of refunds) in date order.
  const queue = args.payments
    .filter((p) => !p.refunded && p.appliedCents > 0n)
    .slice()
    .sort((a, b) => a.simAt.getTime() - b.simAt.getTime())
    .map((p) => ({ ...p, left: p.appliedCents }));
  const refundedKeys = args.payments.filter((p) => p.refunded).map((p) => p.key);
  let qi = 0;
  for (const row of next) {
    let covered = 0n;
    let coveredAt: Date | null = null;
    while (covered < row.amountCents && qi < queue.length) {
      const payment = queue[qi]!;
      const take = payment.left < row.amountCents - covered ? payment.left : row.amountCents - covered;
      covered += take;
      payment.left -= take;
      coveredAt = payment.simAt;
      if (payment.left === 0n) {
        qi += 1;
      }
    }
    if (settled && covered < row.amountCents) {
      covered = row.amountCents;
      coveredAt = coveredAt ?? settled.simAt;
    }
    const wasPaid = row.status === "paid";
    row.paidCents = covered;
    if (covered >= row.amountCents) {
      if (!wasPaid) {
        row.status = "paid";
        row.paidSimAt = coveredAt ?? simNow;
      }
    } else if (wasPaid) {
      // Its payment was refunded (or reversed): no longer covered.
      const used = new Set(next.map((r) => r.failureRef).filter(Boolean));
      const ref = refundedKeys.map((key) => `refund:${key}`).find((key) => !used.has(key)) ?? "refund";
      row.status = "failed";
      row.paidSimAt = null;
      row.failedSimAt = simNow;
      row.failureRef = ref;
      notices.get(row.id)!.push({
        kind: "installment_failed",
        body:
          `The payment that covered installment ${row.seq} (${money(row.amountCents)}, due ${simDate(row.dueOn)}) was refunded, ` +
          "so it is unpaid again. Pay it with repay_loan or move it with reschedule_installment.",
      });
    }
  }

  // 2. New failed captures: each fails the first open installment, once.
  const consumed = new Set(next.map((r) => r.failureRef).filter((ref): ref is string => Boolean(ref)));
  for (const failure of args.failures) {
    if (consumed.has(failure.ref) || settled) {
      continue;
    }
    const target = next.find((r) => r.status === "planned" || r.status === "missed");
    if (!target) {
      break;
    }
    target.status = "failed";
    target.failedSimAt = simNow;
    target.failureRef = failure.ref;
    consumed.add(failure.ref);
    notices.get(target.id)!.push({
      kind: "installment_failed",
      body:
        `A PayPal payment for installment ${target.seq} (${money(target.amountCents - target.paidCents)} left, due ${simDate(target.dueOn)}) failed. ` +
        "Try again with repay_loan, or move it with reschedule_installment.",
    });
  }

  // 3. Days that ended uncovered → missed (and maybe moved once).
  const lastDay = dayStart(loanDueSimAt);
  for (const row of next) {
    if (row.status !== "planned") {
      continue;
    }
    const deadline = addDays(row.dueOn, 1);
    if (simNow < deadline) {
      continue;
    }
    row.status = "missed";
    row.missedSimAt = deadline;
    const left = row.amountCents - row.paidCents;
    const candidate = new Date(Math.max(deadline.getTime(), dayStart(simNow).getTime()));
    if (row.autoReschedule && !row.autoMoved && candidate <= lastDay) {
      const from = simDate(row.dueOn);
      row.dueOn = candidate;
      row.status = "planned";
      row.autoMoved = true;
      notices.get(row.id)!.push({
        kind: "installment_rescheduled",
        body:
          `Installment ${row.seq} (${money(left)} left) was missed on ${from}. You opted into auto-reschedule, ` +
          `so the bank moved it once, to ${simDate(candidate)}. A second miss stays missed.`,
      });
    } else {
      notices.get(row.id)!.push({
        kind: "installment_missed",
        body:
          `Installment ${row.seq} (${money(left)} left, due ${simDate(row.dueOn)}) was missed. ` +
          `Pay it with repay_loan, or move it with reschedule_installment. The loan itself is due ${simDate(loanDueSimAt)}; ` +
          "the late-fee ladder only starts after that date.",
      });
    }
  }

  const changes: ReplanChange[] = [];
  for (const [index, row] of next.entries()) {
    if (!same(row, ordered[index]!) || notices.get(row.id)!.length > 0) {
      changes.push({ id: row.id, next: row, notices: notices.get(row.id)! });
    }
  }
  return changes;
}
