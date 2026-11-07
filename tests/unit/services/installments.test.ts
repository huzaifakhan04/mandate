/**
 * P7 — agent-driven repayment plans: the planning and move rules (pure),
 * the plan_repayments / reschedule_installment tools, and the tick's
 * automatic re-planning from payment events — paid early, partial,
 * missed (+ one auto-move), failed capture and refund. The ledger is never
 * touched by any of it.
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { advanceClock, getSimNow } from "@/server/clock/clock";
import type { Db } from "@/server/db/client";
import { agentNotices, journalEntries, loanInstallments, loans, repaymentLinks, repayments } from "@/server/db/schema";
import { createTestDb } from "@/server/db/testing";
import {
  DAY_MS,
  addDays,
  dayStart,
  replan,
  simDate,
  validateMove,
  validatePlan,
  type InstallmentState,
} from "@/server/domain/installments";
import { runTick } from "@/server/jobs/tick";
import { trialBalance } from "@/server/ledger/trialBalance";
import { simApprove } from "@/server/rail/simHandler";
import { recordRepaymentRefund, replanWorldInstallments } from "@/server/services/installments";
import { createWorld } from "@/server/services/worlds";

import { call, createTestAgent, fundPool, type Data } from "../../helpers/world";

const D = (s: string) => new Date(`${s}T00:00:00Z`);

describe("plan rules (pure)", () => {
  const simNow = new Date("2026-03-01T10:00:00Z");
  const due = new Date("2026-03-15T09:00:00Z");

  it("accepts up to 4 increasing dates from today to the due date, summing to the total due", () => {
    const ok = validatePlan({
      installments: [
        { date: "2026-03-01", amountCents: 100n },
        { date: "2026-03-08", amountCents: 200n },
        { date: "2026-03-15", amountCents: 33n },
      ],
      simNow,
      loanDueSimAt: due,
      totalDueCents: 333n,
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.rows.map((r) => [r.seq, simDate(r.dueOn), r.amountCents])).toEqual([
        [1, "2026-03-01", 100n],
        [2, "2026-03-08", 200n],
        [3, "2026-03-15", 33n],
      ]);
    }
  });

  it.each([
    [[{ date: "2026-02-28", amountCents: 333 }], "date_in_past"],
    [[{ date: "2026-03-16", amountCents: 333 }], "date_after_due"],
    [[{ date: "2026-02-30", amountCents: 333 }], "invalid_date"],
    [
      [
        { date: "2026-03-05", amountCents: 100 },
        { date: "2026-03-05", amountCents: 233 },
      ],
      "dates_not_increasing",
    ],
    [[{ date: "2026-03-05", amountCents: 332 }], "amounts_do_not_sum"],
    [
      [
        { date: "2026-03-05", amountCents: 0 },
        { date: "2026-03-06", amountCents: 333 },
      ],
      "amount_not_positive",
    ],
    [
      ["02", "03", "04", "05", "06"].map((d) => ({ date: `2026-03-${d}`, amountCents: 1 })),
      "too_many_installments",
    ],
  ])("rejects %j as %s", (installments, code) => {
    const result = validatePlan({
      installments: installments.map((i) => ({ date: i.date, amountCents: BigInt(i.amountCents) })),
      simNow,
      loanDueSimAt: due,
      totalDueCents: 333n,
    });
    expect(result).toMatchObject({ ok: false, code });
  });

  it("moves: unpaid only, ≤ 2 agent moves, ≥ 1 sim day ahead, never after the due date", () => {
    const inst = { status: "planned", moves: 0, dueOn: D("2026-03-05") };
    expect(validateMove({ installment: inst, newDate: "2026-03-02", simNow, loanDueSimAt: due })).toMatchObject({ ok: true });
    expect(validateMove({ installment: inst, newDate: "2026-03-01", simNow, loanDueSimAt: due })).toMatchObject({ code: "too_soon" });
    expect(validateMove({ installment: inst, newDate: "2026-03-16", simNow, loanDueSimAt: due })).toMatchObject({
      code: "date_after_due",
    });
    expect(validateMove({ installment: inst, newDate: "2026-03-05", simNow, loanDueSimAt: due })).toMatchObject({ code: "same_date" });
    expect(
      validateMove({ installment: { ...inst, moves: 2 }, newDate: "2026-03-09", simNow, loanDueSimAt: due }),
    ).toMatchObject({ code: "move_limit" });
    expect(
      validateMove({ installment: { ...inst, status: "paid" }, newDate: "2026-03-09", simNow, loanDueSimAt: due }),
    ).toMatchObject({ code: "already_paid" });
    // A missed or failed installment can be moved (back to planned by the service).
    expect(
      validateMove({ installment: { ...inst, status: "missed" }, newDate: "2026-03-09", simNow, loanDueSimAt: due }),
    ).toMatchObject({ ok: true });
  });
});

describe("replan (pure)", () => {
  const due = new Date("2026-03-15T09:00:00Z");
  function inst(seq: number, day: string, amount: bigint, extra: Partial<InstallmentState> = {}): InstallmentState {
    return {
      id: `i${seq}`,
      seq,
      dueOn: D(day),
      amountCents: amount,
      paidCents: 0n,
      status: "planned",
      autoReschedule: false,
      autoMoved: false,
      paidSimAt: null,
      missedSimAt: null,
      failedSimAt: null,
      failureRef: null,
      ...extra,
    };
  }
  const plan = [inst(1, "2026-03-05", 100n), inst(2, "2026-03-10", 100n), inst(3, "2026-03-15", 133n)];
  const base = { failures: [], loanDueSimAt: due, settled: null };

  it("an early payment covering 1.5 installments: #1 paid on its payment day, the rest shifts onto #2 (partial)", () => {
    const changes = replan({
      ...base,
      installments: plan,
      payments: [{ key: "r1", simAt: new Date("2026-03-02T12:00:00Z"), appliedCents: 150n, refunded: false }],
      simNow: new Date("2026-03-02T13:00:00Z"),
    });
    const byId = new Map(changes.map((c) => [c.id, c.next]));
    expect(byId.get("i1")).toMatchObject({ status: "paid", paidCents: 100n, paidSimAt: new Date("2026-03-02T12:00:00Z") });
    expect(byId.get("i2")).toMatchObject({ status: "planned", paidCents: 50n });
    expect(byId.has("i3")).toBe(false);
  });

  it("a day that ends uncovered → missed with a notice; nothing changes before the end of the day", () => {
    expect(replan({ ...base, installments: plan, payments: [], simNow: new Date("2026-03-05T23:59:59Z") })).toEqual([]);
    const changes = replan({ ...base, installments: plan, payments: [], simNow: new Date("2026-03-06T00:00:00Z") });
    expect(changes).toHaveLength(1);
    expect(changes[0]!.next).toMatchObject({ id: "i1", status: "missed", missedSimAt: D("2026-03-06") });
    expect(changes[0]!.notices.map((n) => n.kind)).toEqual(["installment_missed"]);
  });

  it("auto_reschedule moves a missed installment to the next sim day once; a second miss stays missed", () => {
    const auto = plan.map((p) => ({ ...p, autoReschedule: true }));
    const first = replan({ ...base, installments: auto, payments: [], simNow: new Date("2026-03-06T01:00:00Z") });
    expect(first[0]!.next).toMatchObject({ status: "planned", dueOn: D("2026-03-06"), autoMoved: true });
    expect(first[0]!.notices.map((n) => n.kind)).toEqual(["installment_rescheduled"]);
    const moved = auto.map((p) => (p.id === "i1" ? first[0]!.next : p));
    const second = replan({ ...base, installments: moved, payments: [], simNow: new Date("2026-03-07T00:00:00Z") });
    expect(second[0]!.next).toMatchObject({ id: "i1", status: "missed", dueOn: D("2026-03-06") });
    expect(second[0]!.notices.map((n) => n.kind)).toEqual(["installment_missed"]);
  });

  it("a missed day after a long gap moves to today (not into the past), and never past the loan's due date", () => {
    const auto = [inst(1, "2026-03-05", 333n, { autoReschedule: true })];
    const late = replan({ ...base, installments: auto, payments: [], simNow: new Date("2026-03-09T08:00:00Z") });
    expect(late[0]!.next).toMatchObject({ status: "planned", dueOn: D("2026-03-09") });
    const last = [inst(1, "2026-03-15", 333n, { autoReschedule: true })];
    const end = replan({ ...base, installments: last, payments: [], simNow: new Date("2026-03-16T00:00:00Z") });
    expect(end[0]!.next).toMatchObject({ status: "missed", autoMoved: false });
  });

  it("a failed capture fails the first open installment once; a refunded payment un-pays the installment it covered", () => {
    const failed = replan({
      ...base,
      installments: plan,
      payments: [],
      failures: [{ ref: "link:a", simAt: new Date("2026-03-02T00:00:00Z") }],
      simNow: new Date("2026-03-02T00:00:00Z"),
    });
    expect(failed[0]!.next).toMatchObject({ id: "i1", status: "failed", failureRef: "link:a" });
    // Already consumed: the same signal does nothing more.
    const again = replan({
      ...base,
      installments: plan.map((p) => (p.id === "i1" ? failed[0]!.next : p)),
      payments: [],
      failures: [{ ref: "link:a", simAt: new Date("2026-03-02T00:00:00Z") }],
      simNow: new Date("2026-03-03T00:00:00Z"),
    });
    expect(again).toEqual([]);

    const paid = plan.map((p) => (p.id === "i1" ? { ...p, status: "paid" as const, paidCents: 100n, paidSimAt: D("2026-03-02") } : p));
    const refunded = replan({
      ...base,
      installments: paid,
      payments: [{ key: "r1", simAt: D("2026-03-02"), appliedCents: 100n, refunded: true }],
      simNow: new Date("2026-03-03T00:00:00Z"),
    });
    expect(refunded[0]!.next).toMatchObject({ id: "i1", status: "failed", paidCents: 0n, failureRef: "refund:r1" });
    expect(refunded[0]!.notices.map((n) => n.kind)).toEqual(["installment_failed"]);
  });

  it("a settled loan marks everything paid", () => {
    const changes = replan({
      ...base,
      installments: plan,
      payments: [],
      settled: { simAt: D("2026-03-03") },
      simNow: D("2026-03-04"),
    });
    expect(changes.map((c) => c.next.status)).toEqual(["paid", "paid", "paid"]);
  });
});

describe("repayment plans end to end (tools + tick)", () => {
  let db: Db;

  beforeEach(async () => {
    process.env.API_KEY_PEPPER = "test-pepper";
    db = await createTestDb();
  });

  afterEach(() => {
    delete process.env.API_KEY_PEPPER;
  });

  /** 25000 for 14 days at grade A, no invoice: total due 25333. */
  async function setup() {
    const worldId = (await createWorld(db, { name: "Plans", ownerPrincipalId: null, railMode: "sim" })).worldId;
    await fundPool(db, worldId, 30000);
    const borrower = await createTestAgent(db, worldId, "borrower@example.com");
    const applied = await call(db, "apply_for_loan", borrower.key, { amount_cents: 25000, term_days: 14, purpose: "Working capital" });
    const offer = applied.envelope.data as Data;
    const accepted = await call(db, "accept_offer", borrower.key, { offer_id: offer.offer_id, disclosure_hash: offer.disclosure_hash });
    expect(accepted.envelope.status).toBe("ACTIVE");
    const loanId = (accepted.envelope.data as Data).loan_id as string;
    const [loan] = await db.select().from(loans).where(eq(loans.id, loanId));
    const simNow = await getSimNow(db, worldId);
    const today = dayStart(simNow);
    return { worldId, ...borrower, loanId, due: loan!.dueSimAt, simNow, today };
  }

  async function repay(key: string, loanId: string, amountCents: number) {
    const started = await call(db, "repay_loan", key, { loan_id: loanId, amount_cents: amountCents });
    const checkoutId = (started.envelope.data as Data).checkout_id as string;
    await simApprove(db, checkoutId);
    const confirmed = await call(db, "confirm_checkout", key, { checkout_id: checkoutId });
    expect(confirmed.envelope.status).toBe("COMPLETED");
  }

  async function rows(loanId: string) {
    return (await db.select().from(loanInstallments).where(eq(loanInstallments.loanId, loanId))).sort((a, b) => a.seq - b.seq);
  }

  async function plan(key: string, loanId: string, today: Date, autoReschedule = false) {
    return call(db, "plan_repayments", key, {
      loan_id: loanId,
      auto_reschedule: autoReschedule,
      installments: [
        { date: simDate(addDays(today, 2)), amount_cents: 10000 },
        { date: simDate(addDays(today, 6)), amount_cents: 10000 },
        { date: simDate(addDays(today, 10)), amount_cents: 5333 },
      ],
    });
  }

  it("plan_repayments validates, is idempotent by content, and shows in get_loan / get_status", async () => {
    const s = await setup();
    const bad = await call(db, "plan_repayments", s.key, {
      installments: [{ date: simDate(addDays(s.today, 2)), amount_cents: 25000 }],
    });
    expect(bad.envelope).toMatchObject({ status: "INVALID_PLAN", reason_codes: ["amounts_do_not_sum"] });
    expect(bad.httpStatus).toBe(400);
    const afterDue = await call(db, "plan_repayments", s.key, {
      installments: [{ date: simDate(addDays(s.due, 1)), amount_cents: 25333 }],
    });
    expect(afterDue.envelope.reason_codes).toEqual(["date_after_due"]);

    const planned = await plan(s.key, s.loanId, s.today);
    expect(planned.envelope.status).toBe("PLANNED");
    const view = (planned.envelope.data as Data).repayment_plan as Data;
    expect(view).toMatchObject({ planned_total_cents: 25333, paid_cents: 0, auto_reschedule: false });
    expect((view.installments as Data[]).map((i) => i.status)).toEqual(["PLANNED", "PLANNED", "PLANNED"]);

    expect((await plan(s.key, s.loanId, s.today)).envelope.status).toBe("PLANNED");
    const other = await call(db, "plan_repayments", s.key, {
      installments: [{ date: simDate(addDays(s.today, 3)), amount_cents: 25333 }],
    });
    expect(other.envelope.status).toBe("PLAN_EXISTS");
    expect(await rows(s.loanId)).toHaveLength(3);

    const loan = await call(db, "get_loan", s.key, { loan_id: s.loanId });
    expect(((loan.envelope.data as Data).repayment_plan as Data).next_due).toEqual({
      installment: 1,
      due_on: simDate(addDays(s.today, 2)),
      amount_left_cents: 10000,
    });
    const status = await call(db, "get_status", s.key, {});
    expect(((status.envelope.data as Data).open_loan as Data).repayment_plan).toMatchObject({ planned_total_cents: 25333 });
  });

  it("reschedule_installment: ≥ 1 day ahead, never past the due date, at most 2 moves; another agent can't touch it", async () => {
    const s = await setup();
    await plan(s.key, s.loanId, s.today);
    const tooSoon = await call(db, "reschedule_installment", s.key, { installment: 1, date: simDate(s.today) });
    expect(tooSoon.envelope.reason_codes).toEqual(["too_soon"]);
    const pastDue = await call(db, "reschedule_installment", s.key, { installment: 1, date: simDate(addDays(s.due, 1)) });
    expect(pastDue.envelope.reason_codes).toEqual(["date_after_due"]);
    const first = await call(db, "reschedule_installment", s.key, { installment: 1, date: simDate(addDays(s.today, 3)) });
    expect(first.envelope).toMatchObject({ status: "RESCHEDULED", data: { moves_left: 1 } });
    const second = await call(db, "reschedule_installment", s.key, { installment: 1, date: simDate(addDays(s.today, 4)) });
    expect(second.envelope).toMatchObject({ status: "RESCHEDULED", data: { moves_left: 0 } });
    const third = await call(db, "reschedule_installment", s.key, { installment: 1, date: simDate(addDays(s.today, 5)) });
    expect(third.envelope.reason_codes).toEqual(["move_limit"]);
    expect((await rows(s.loanId))[0]).toMatchObject({ moves: 2, dueOn: addDays(s.today, 4), originalDueOn: addDays(s.today, 2) });

    const stranger = await createTestAgent(db, s.worldId, "stranger@example.com");
    const theirs = await call(db, "reschedule_installment", stranger.key, {
      loan_id: s.loanId,
      installment: 2,
      date: simDate(addDays(s.today, 7)),
    });
    expect(theirs.envelope.status).toBe("NOT_FOUND");
  });

  it("the tick re-plans: an early payment marks #1 PAID and shifts the rest; a partial leaves #2 PLANNED with paid_cents; ledger untouched", async () => {
    const s = await setup();
    await plan(s.key, s.loanId, s.today);
    await repay(s.key, s.loanId, 12000);
    const journalsBefore = (await db.select().from(journalEntries)).length;

    const report = await runTick(db);
    expect(report.installmentsReplanned).toBe(2);
    const [i1, i2, i3] = await rows(s.loanId);
    expect(i1).toMatchObject({ status: "paid", paidCents: 10000n });
    expect(i1!.paidSimAt!.getTime()).toBeLessThan(i1!.dueOn.getTime() + DAY_MS);
    expect(i2).toMatchObject({ status: "planned", paidCents: 2000n });
    expect(i3).toMatchObject({ status: "planned", paidCents: 0n });

    // Re-running changes nothing; re-planning posts no journal.
    expect((await runTick(db)).installmentsReplanned).toBe(0);
    const journalsAfterTick = (await db.select().from(journalEntries)).length;
    await db.update(loanInstallments).set({ status: "planned", paidCents: 0n, paidSimAt: null }).where(eq(loanInstallments.loanId, s.loanId));
    expect((await replanWorldInstallments(db, s.worldId, await getSimNow(db, s.worldId))).changed).toBe(2);
    expect((await db.select().from(journalEntries)).length).toBe(journalsAfterTick);
    expect(journalsAfterTick).toBeGreaterThanOrEqual(journalsBefore);
    expect((await trialBalance(db, s.worldId)).totalCents).toBe(0n);
    // The loan itself is untouched by the plan: still due on its own date.
    const [loan] = await db.select().from(loans).where(eq(loans.id, s.loanId));
    expect(loan!.dueSimAt).toEqual(s.due);
  });

  it("a missed installment (no payment by the end of its day) is flagged with a notice and auto-moved once when opted in", async () => {
    const s = await setup();
    await plan(s.key, s.loanId, s.today, true);
    await advanceClock(db, s.worldId, 3); // past the end of day +2
    await runTick(db);
    let [i1] = await rows(s.loanId);
    expect(i1).toMatchObject({ status: "planned", autoMoved: true, dueOn: addDays(s.today, 3) });
    expect(i1!.missedSimAt).toEqual(addDays(s.today, 3));
    const notices = await db.select().from(agentNotices).where(eq(agentNotices.loanId, s.loanId));
    expect(notices.map((n) => n.kind)).toEqual(["installment_rescheduled"]);
    expect(notices[0]!.principalId).toBe(s.principalId);

    await advanceClock(db, s.worldId, 1); // the moved day ends uncovered too
    await runTick(db);
    [i1] = await rows(s.loanId);
    expect(i1).toMatchObject({ status: "missed", autoMoved: true });
    const kinds = (await db.select().from(agentNotices).where(eq(agentNotices.loanId, s.loanId))).map((n) => n.kind).sort();
    expect(kinds).toEqual(["installment_missed", "installment_rescheduled"]);
    const status = await call(db, "get_status", s.key, {});
    expect(((status.envelope.data as Data).notices as Data[]).map((n) => n.kind)).toContain("installment_missed");

    // Paying it late still marks it paid; the agent can also move what's left.
    await repay(s.key, s.loanId, 10000);
    await replanWorldInstallments(db, s.worldId, await getSimNow(db, s.worldId));
    [i1] = await rows(s.loanId);
    expect(i1).toMatchObject({ status: "paid" });
  });

  it("a failed PayPal capture marks the next installment FAILED; moving it makes it PLANNED again", async () => {
    const s = await setup();
    await plan(s.key, s.loanId, s.today);
    const started = await call(db, "repay_loan", s.key, { loan_id: s.loanId, amount_cents: 10000 });
    expect(started.envelope.status).toBe("AWAITING_APPROVAL");
    // The capture was denied (webhook PAYMENT.CAPTURE.DENIED → the link's failure applier).
    await db.update(repaymentLinks).set({ status: "failed" }).where(eq(repaymentLinks.loanId, s.loanId));
    const report = await replanWorldInstallments(db, s.worldId, await getSimNow(db, s.worldId));
    expect(report.changed).toBe(1);
    let [i1] = await rows(s.loanId);
    expect(i1).toMatchObject({ status: "failed" });
    expect(i1!.failureRef).toMatch(/^link:/);
    expect((await db.select().from(agentNotices).where(eq(agentNotices.loanId, s.loanId))).map((n) => n.kind)).toEqual([
      "installment_failed",
    ]);
    // Same failure again: nothing new.
    expect((await replanWorldInstallments(db, s.worldId, await getSimNow(db, s.worldId))).changed).toBe(0);

    const moved = await call(db, "reschedule_installment", s.key, { installment: 1, date: simDate(addDays(s.today, 3)) });
    expect(moved.envelope.status).toBe("RESCHEDULED");
    [i1] = await rows(s.loanId);
    expect(i1).toMatchObject({ status: "planned", moves: 1 });
  });

  it("a refunded repayment un-pays the installment it covered (FAILED), recorded once per capture", async () => {
    const s = await setup();
    await plan(s.key, s.loanId, s.today);
    await repay(s.key, s.loanId, 10000);
    await replanWorldInstallments(db, s.worldId, await getSimNow(db, s.worldId));
    expect((await rows(s.loanId))[0]).toMatchObject({ status: "paid" });

    const [repayment] = await db.select().from(repayments).where(eq(repayments.loanId, s.loanId));
    expect(await recordRepaymentRefund(db, s.worldId, { captureId: repayment!.captureId!, reason: "refunded" })).toBe("recorded");
    expect(await recordRepaymentRefund(db, s.worldId, { captureId: repayment!.captureId!, reason: "refunded" })).toBe("duplicate");
    expect(await recordRepaymentRefund(db, s.worldId, { captureId: "NOPE", reason: "refunded" })).toBe("unknown");
    const journals = (await db.select().from(journalEntries)).length;

    await replanWorldInstallments(db, s.worldId, await getSimNow(db, s.worldId));
    const [i1] = await rows(s.loanId);
    expect(i1).toMatchObject({ status: "failed", paidCents: 0n, failureRef: `refund:${repayment!.id}` });
    expect((await db.select().from(journalEntries)).length).toBe(journals);
  });

  it("repaying the whole loan marks every installment PAID", async () => {
    const s = await setup();
    await plan(s.key, s.loanId, s.today);
    await repay(s.key, s.loanId, 25333);
    await runTick(db);
    expect((await rows(s.loanId)).map((r) => r.status)).toEqual(["paid", "paid", "paid"]);
    const loan = await call(db, "get_loan", s.key, { loan_id: s.loanId });
    expect(((loan.envelope.data as Data).repayment_plan as Data).next_due).toBeNull();
  });
});
