/**
 * P4 Task 1 — the delinquency ladder (late +1, penalty +3, substandard +7),
 * notices, the updated waterfall (late fees → penalty → fee → principal →
 * remainder), cure, the mandate freeze and the private-world advance.
 *
 * Review Focus 1: each step exactly once under repeated and concurrent
 * `processDue` (this file also runs on real Postgres under `test:pg`).
 * Review Focus 2: partial repayments during the ladder keep the order and
 * the cure rules, and the trial balance stays 0 throughout.
 */
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { advanceClock, getSimNow } from "@/server/clock/clock";
import type { Db } from "@/server/db/client";
import {
  agentNotices,
  agents,
  events,
  loanLadderSteps,
  loans,
  principals,
  repaymentLinks,
  repayments,
  scoreHistory,
} from "@/server/db/schema";
import { createTestDb } from "@/server/db/testing";
import { daysLate, dueSteps, lateFeeCents, penaltyFor, penaltyIncrement } from "@/server/domain/delinquency";
import { runTick } from "@/server/jobs/tick";
import { getAccountBalance, trialBalance } from "@/server/ledger/trialBalance";
import { simApprove } from "@/server/rail/simHandler";
import { processDue } from "@/server/services/collections";
import { settleCheckoutByOrderId } from "@/server/services/checkouts";
import { setAgentFrozen } from "@/server/services/owner";
import { advancePrivateWorld } from "@/server/services/privateWorlds";
import { createWorld, ensureMainWorld } from "@/server/services/worlds";
import { clock } from "@/server/db/schema";

import { call, createTestAgent, fundPool, type Data } from "../../helpers/world";

const DAY_MS = 86_400_000;

/** No invoice, 25000 for 14 days at grade A: fee 333 (pricing v2). */
async function borrow(db: Db, worldId: string, kya: Parameters<typeof createTestAgent>[3] = {}) {
  const borrower = await createTestAgent(db, worldId, "borrower@example.com", kya);
  const applied = await call(db, "apply_for_loan", borrower.key, {
    amount_cents: 25000,
    term_days: 14,
    purpose: "Working capital",
  });
  expect(applied.envelope.status).toBe("OFFERED");
  const offer = applied.envelope.data as Data;
  const accepted = await call(db, "accept_offer", borrower.key, {
    offer_id: offer.offer_id,
    disclosure_hash: offer.disclosure_hash,
  });
  expect(accepted.envelope.status).toBe("ACTIVE");
  const loanId = (accepted.envelope.data as Data).loan_id as string;
  return { ...borrower, loanId };
}

async function loanRow(db: Db, loanId: string) {
  const [row] = await db.select().from(loans).where(eq(loans.id, loanId));
  return row!;
}

async function agentStatus(db: Db, agentId: string) {
  const [row] = await db.select().from(agents).where(eq(agents.id, agentId));
  return row!.status;
}

function at(due: Date, days: number, extraMs = 0): Date {
  return new Date(due.getTime() + days * DAY_MS + extraMs);
}

async function expectBalanced(db: Db, worldId: string) {
  expect((await trialBalance(db, worldId)).totalCents).toBe(0n);
}

/** Direct repayment through repay_loan → sim approve → confirm_checkout. */
async function repay(db: Db, key: string, loanId: string, amountCents?: number) {
  const started = await call(db, "repay_loan", key, {
    loan_id: loanId,
    ...(amountCents === undefined ? {} : { amount_cents: amountCents }),
  });
  expect(started.envelope.status).toBe("AWAITING_APPROVAL");
  const checkoutId = (started.envelope.data as Data).checkout_id as string;
  await simApprove(db, checkoutId);
  const confirmed = await call(db, "confirm_checkout", key, { checkout_id: checkoutId });
  expect(confirmed.envelope.status).toBe("COMPLETED");
  return confirmed.envelope.data as Data;
}

async function noticesFor(db: Db, loanId: string) {
  return db.select().from(agentNotices).where(eq(agentNotices.loanId, loanId));
}

async function stepsFor(db: Db, loanId: string) {
  return db.select().from(loanLadderSteps).where(eq(loanLadderSteps.loanId, loanId));
}

describe("delinquency rules (pure)", () => {
  it("late fee = min(500, max(100, 5% × principal))", () => {
    expect(lateFeeCents(25000n)).toBe(500n);
    expect(lateFeeCents(6000n)).toBe(300n);
    expect(lateFeeCents(1000n)).toBe(100n);
    expect(lateFeeCents(0n)).toBe(100n);
  });

  it("penalty = ceil(P × 200 bps × days ÷ 365); increments sum to the running total", () => {
    expect(penaltyFor(25000n, 3)).toBe(5n);
    expect(penaltyFor(25000n, 4)).toBe(6n);
    expect(penaltyFor(25000n, 7)).toBe(10n);
    expect(penaltyFor(0n, 7)).toBe(0n);
    let total = 0n;
    for (let day = 1; day <= 30; day += 1) {
      total += penaltyIncrement(25000n, day - 1, day);
    }
    expect(total).toBe(penaltyFor(25000n, 30));
  });

  it("steps come due in order and skip what was applied", () => {
    expect(dueSteps(null, 0)).toEqual([]);
    expect(dueSteps(null, 1)).toEqual(["late"]);
    expect(dueSteps(null, 9)).toEqual(["late", "penalty", "substandard"]);
    expect(dueSteps("late", 3)).toEqual(["penalty"]);
    expect(dueSteps("substandard", 9)).toEqual([]);
    expect(dueSteps("charged_off", 12)).toEqual([]);
    const due = new Date("2026-01-01T00:00:00Z");
    expect(daysLate(due, at(due, 1, -1))).toBe(0);
    expect(daysLate(due, at(due, 1))).toBe(1);
  });
});

describe("the delinquency ladder (P4 Task 1)", () => {
  let db: Db;

  beforeEach(async () => {
    process.env.API_KEY_PEPPER = "test-pepper";
    db = await createTestDb();
  });

  afterEach(() => {
    delete process.env.API_KEY_PEPPER;
  });

  it("+1 late fee 500, +3 penalty 5, +4 → 6, +7 substandard → restricted; each step once; no journal (trial balance 0)", async () => {
    const worldId = (await createWorld(db, { name: "Ladder", ownerPrincipalId: null, railMode: "sim" })).worldId;
    await fundPool(db, worldId, 30000);
    const borrower = await borrow(db, worldId);
    const due = (await loanRow(db, borrower.loanId)).dueSimAt;
    const before = (await loanRow(db, borrower.loanId)).outstandingCents;
    expect(before).toBe(25333n);

    // On the due date and just before +1: nothing.
    expect((await processDue(db, worldId, at(due, 1, -1))).steps).toEqual({ late: 0, penalty: 0, substandard: 0, charged_off: 0 });
    expect((await loanRow(db, borrower.loanId)).status).toBe("active");

    // +1: LATE, fee 500, notice, score history −15.
    const late = await processDue(db, worldId, at(due, 1));
    expect(late.steps).toEqual({ late: 1, penalty: 0, substandard: 0, charged_off: 0 });
    let loan = await loanRow(db, borrower.loanId);
    expect(loan.status).toBe("late");
    expect(loan.lateFeeOutstandingCents).toBe(500n);
    expect(loan.lateFeesCents).toBe(500n);
    expect(loan.outstandingCents).toBe(25333n);
    expect(loan.penaltyOutstandingCents).toBe(0n);
    expect((await noticesFor(db, borrower.loanId)).map((n) => n.kind)).toEqual(["late"]);
    const history = await db
      .select()
      .from(scoreHistory)
      .where(and(eq(scoreHistory.subjectId, borrower.agentId), eq(scoreHistory.reasonCode, "loan_late")));
    expect(history).toHaveLength(1);
    expect(history[0]!.delta).toBe(-15);
    await expectBalanced(db, worldId);

    // Repeated runs at +1 (and +2) change nothing.
    await processDue(db, worldId, at(due, 1));
    await processDue(db, worldId, at(due, 2));
    expect((await loanRow(db, borrower.loanId)).lateFeeOutstandingCents).toBe(500n);
    expect(await stepsFor(db, borrower.loanId)).toHaveLength(1);

    // +3: penalty ceil(25000 × 200 × 3 / 3650000) = 5.
    expect((await processDue(db, worldId, at(due, 3))).steps.penalty).toBe(1);
    loan = await loanRow(db, borrower.loanId);
    expect(loan.status).toBe("late");
    expect(loan.delinquencyStep).toBe("penalty");
    expect(loan.penaltyOutstandingCents).toBe(5n);
    expect(loan.penaltyAccruedDays).toBe(3);

    // +4: daily accrual → 6 (once, however often it runs).
    await processDue(db, worldId, at(due, 4));
    await processDue(db, worldId, at(due, 4, 3_600_000));
    expect((await loanRow(db, borrower.loanId)).penaltyOutstandingCents).toBe(6n);

    // get_status shows the delinquency and the unread notices.
    const status = await call(db, "get_status", borrower.key, {});
    const openLoan = (status.envelope.data as Data).open_loan as Data;
    expect(openLoan.status).toBe("LATE");
    expect(openLoan.late_fee_cents).toBe(500);
    expect(openLoan.penalty_cents).toBe(6);
    expect(openLoan.total_due_cents).toBe(25333 + 500 + 6);
    expect(((status.envelope.data as Data).notices as Data[]).map((n) => n.kind)).toEqual(["late", "penalty"]);

    // +7: SUBSTANDARD, agent restricted, penalty 10.
    expect((await processDue(db, worldId, at(due, 7))).steps.substandard).toBe(1);
    loan = await loanRow(db, borrower.loanId);
    expect(loan.status).toBe("substandard");
    expect(loan.penaltyOutstandingCents).toBe(10n);
    expect(await agentStatus(db, borrower.agentId)).toBe("restricted");
    expect((await noticesFor(db, borrower.loanId)).map((n) => n.kind).sort()).toEqual(["late", "penalty", "substandard"]);
    expect((await stepsFor(db, borrower.loanId)).map((s) => s.step).sort()).toEqual(["late", "penalty", "substandard"]);

    // get_loan shows it too.
    const got = await call(db, "get_loan", borrower.key, { loan_id: borrower.loanId });
    expect(got.envelope.data).toMatchObject({
      status: "SUBSTANDARD",
      days_late: expect.any(Number),
      late_fee_cents: 500,
      penalty_cents: 10,
      total_due_cents: 25333 + 500 + 10,
    });

    // Nothing posted for assessments: the trial balance is still 0.
    await expectBalanced(db, worldId);
  });

  it("concurrent processDue runs (tick + manual advance) apply each step exactly once", async () => {
    const worldId = (await createWorld(db, { name: "Race", ownerPrincipalId: null, railMode: "sim" })).worldId;
    await fundPool(db, worldId, 30000);
    const borrower = await borrow(db, worldId);
    const due = (await loanRow(db, borrower.loanId)).dueSimAt;

    const runs = await Promise.all([
      processDue(db, worldId, at(due, 8)),
      processDue(db, worldId, at(due, 8)),
      processDue(db, worldId, at(due, 8)),
    ]);
    const applied = runs.reduce((sum, r) => sum + r.steps.late + r.steps.penalty + r.steps.substandard, 0);
    expect(applied).toBe(3);
    expect(runs.flatMap((r) => r.errors)).toEqual([]);

    const loan = await loanRow(db, borrower.loanId);
    expect(loan.status).toBe("substandard");
    expect(loan.lateFeeOutstandingCents).toBe(500n);
    expect(loan.penaltyOutstandingCents).toBe(penaltyFor(25000n, 8));
    expect(await stepsFor(db, borrower.loanId)).toHaveLength(3);
    expect(await noticesFor(db, borrower.loanId)).toHaveLength(3);
    // M5: the penalty notice states the actual days late (the ladder caught up at +8).
    const penaltyNotice = (await noticesFor(db, borrower.loanId)).find((n) => n.kind === "penalty")!;
    expect(penaltyNotice.body).toContain("is 8 days past due");
    const late = await db
      .select()
      .from(events)
      .where(and(eq(events.aggregateId, borrower.loanId), eq(events.type, "loan.late")));
    expect(late).toHaveLength(1);
    await expectBalanced(db, worldId);
  });

  it("partial repayments during the ladder: late fees → penalty → fee → principal; cure → REPAID, agent active, trial balance 0", async () => {
    const worldId = (await createWorld(db, { name: "Partial", ownerPrincipalId: null, railMode: "sim" })).worldId;
    await fundPool(db, worldId, 30000);
    const borrower = await borrow(db, worldId);
    const due = (await loanRow(db, borrower.loanId)).dueSimAt;

    // Move the world clock past +7 so captures happen at that sim time too.
    const now = await getSimNow(db, worldId);
    const days = Math.ceil((at(due, 7).getTime() - now.getTime()) / DAY_MS);
    await advanceClock(db, worldId, days);
    const simNow = await getSimNow(db, worldId);
    await processDue(db, worldId, simNow);
    const penalty = penaltyFor(25000n, daysLate(due, simNow));
    let loan = await loanRow(db, borrower.loanId);
    expect(loan.status).toBe("substandard");
    expect(loan.penaltyOutstandingCents).toBe(penalty);
    expect(await agentStatus(db, borrower.agentId)).toBe("restricted");

    // A restricted agent cannot borrow …
    const blocked = await call(db, "apply_for_loan", borrower.key, { amount_cents: 1000, term_days: 7, purpose: "More working capital" });
    expect(blocked.envelope.status).toBe("AGENT_NOT_ACTIVE");
    // … but can repay and acknowledge notices. 300 → all to late fees.
    const first = await repay(db, borrower.key, borrower.loanId, 300);
    expect(first).toMatchObject({ applied_late_fee_cents: 300, applied_penalty_cents: 0, applied_fee_cents: 0 });
    loan = await loanRow(db, borrower.loanId);
    expect(loan.lateFeeOutstandingCents).toBe(200n);
    expect(loan.status).toBe("substandard");
    await expectBalanced(db, worldId);

    // 1000 → late 200, penalty, fee 333, rest principal.
    const second = await repay(db, borrower.key, borrower.loanId, 1000);
    expect(second).toMatchObject({
      applied_late_fee_cents: 200,
      applied_penalty_cents: Number(penalty),
      applied_fee_cents: 333,
      applied_principal_cents: 1000 - 200 - Number(penalty) - 333,
    });
    loan = await loanRow(db, borrower.loanId);
    expect(loan.lateFeeOutstandingCents).toBe(0n);
    expect(loan.penaltyOutstandingCents).toBe(0n);
    expect(loan.status).toBe("substandard");
    expect(await getAccountBalance(db, worldId, "late_fee_income", null)).toBe(-500n);
    expect(await getAccountBalance(db, worldId, "penalty_income", null)).toBe(-penalty);
    await expectBalanced(db, worldId);

    // Too much is refused; the exact rest cures the loan.
    const status = (await call(db, "get_status", borrower.key, {})).envelope.data as Data;
    const totalDue = (status.open_loan as Data).total_due_cents as number;
    const tooMuch = await call(db, "repay_loan", borrower.key, { loan_id: borrower.loanId, amount_cents: totalDue + 1 });
    expect(tooMuch.envelope.status).toBe("AMOUNT_EXCEEDS_OUTSTANDING");
    const last = await repay(db, borrower.key, borrower.loanId);
    expect(last.loan_status).toBe("REPAID");
    loan = await loanRow(db, borrower.loanId);
    expect(loan.status).toBe("repaid");
    expect(loan.outstandingCents).toBe(0n);
    expect(await agentStatus(db, borrower.agentId)).toBe("active");
    expect((await noticesFor(db, borrower.loanId)).map((n) => n.kind)).toContain("cured");
    const rows = await db.select().from(repayments).where(eq(repayments.loanId, borrower.loanId));
    expect(rows.reduce((sum, r) => sum + r.appliedLateFeeCents, 0n)).toBe(500n);
    expect(rows.reduce((sum, r) => sum + r.appliedPenaltyCents, 0n)).toBe(penalty);
    expect(await getAccountBalance(db, worldId, "loans_receivable", null)).toBe(0n);
    await expectBalanced(db, worldId);

    // A cured loan is no longer processed; acknowledged notices disappear from get_status.
    await processDue(db, worldId, at(due, 20));
    expect((await loanRow(db, borrower.loanId)).status).toBe("repaid");
    const acked = await call(db, "ack_notices", borrower.key, {});
    expect(acked.envelope.status).toBe("OK");
    expect((acked.envelope.data as Data).acknowledged).toBe(4);
    expect(((await call(db, "get_status", borrower.key, {})).envelope.data as Data).notices).toEqual([]);
  });

  it("a cure while only LATE (before substandard) pays the late fee first and goes straight to REPAID", async () => {
    const worldId = (await createWorld(db, { name: "Cure", ownerPrincipalId: null, railMode: "sim" })).worldId;
    await fundPool(db, worldId, 30000);
    const borrower = await borrow(db, worldId);
    const due = (await loanRow(db, borrower.loanId)).dueSimAt;
    const now = await getSimNow(db, worldId);
    await advanceClock(db, worldId, Math.ceil((at(due, 1).getTime() - now.getTime()) / DAY_MS));
    await processDue(db, worldId, await getSimNow(db, worldId));
    expect((await loanRow(db, borrower.loanId)).status).toBe("late");

    const paid = await repay(db, borrower.key, borrower.loanId);
    expect(paid).toMatchObject({ loan_status: "REPAID", applied_late_fee_cents: 500, applied_fee_cents: 333 });
    expect(await agentStatus(db, borrower.agentId)).toBe("active");
    // The late repayment counts in the scorecard once (repaid after due).
    const status = (await call(db, "get_status", borrower.key, {})).envelope.data as Data;
    expect(status.open_loan).toBeNull();
    await expectBalanced(db, worldId);
  });

  it("mandate freeze: while a loan is substandard, the principal's other agents decline with delinquent_principal; lifted on cure", async () => {
    const worldId = (await createWorld(db, { name: "Freeze", ownerPrincipalId: null, railMode: "sim" })).worldId;
    await fundPool(db, worldId, 60000);
    const borrower = await borrow(db, worldId);
    const sibling = await createTestAgent(db, worldId, "sibling@example.com", { principalId: borrower.principalId });
    const due = (await loanRow(db, borrower.loanId)).dueSimAt;

    const now = await getSimNow(db, worldId);
    await advanceClock(db, worldId, Math.ceil((at(due, 7).getTime() - now.getTime()) / DAY_MS));
    await processDue(db, worldId, await getSimNow(db, worldId));
    expect((await loanRow(db, borrower.loanId)).status).toBe("substandard");

    const declined = await call(db, "apply_for_loan", sibling.key, { amount_cents: 2000, term_days: 7, purpose: "Operations" });
    expect(declined.envelope.status).toBe("DECLINED");
    expect(declined.envelope.reason_codes).toContain("delinquent_principal");
    const eligibility = await call(db, "check_eligibility", sibling.key, { amount_cents: 2000, term_days: 7 });
    expect((eligibility.envelope.data as Data).reasons).toContain("delinquent_principal");

    // Cure lifts the freeze.
    await repay(db, borrower.key, borrower.loanId);
    const again = await call(db, "apply_for_loan", sibling.key, { amount_cents: 2000, term_days: 7, purpose: "Operations" });
    expect(again.envelope.reason_codes ?? []).not.toContain("delinquent_principal");
  });

  it("accept_offer is refused with MANDATE_FROZEN once a sibling's loan turns substandard", async () => {
    const worldId = (await createWorld(db, { name: "Freeze2", ownerPrincipalId: null, railMode: "sim" })).worldId;
    await fundPool(db, worldId, 60000);
    const borrower = await borrow(db, worldId);
    const sibling = await createTestAgent(db, worldId, "sibling@example.com", { principalId: borrower.principalId });
    const due = (await loanRow(db, borrower.loanId)).dueSimAt;

    // The sibling's offer is made while the loan is merely LATE …
    await processDue(db, worldId, at(due, 1));
    expect((await loanRow(db, borrower.loanId)).status).toBe("late");
    const applied = await call(db, "apply_for_loan", sibling.key, { amount_cents: 2000, term_days: 7, purpose: "Operations" });
    expect(applied.envelope.status).toBe("OFFERED");
    // … and the loan turns substandard before it is accepted (the ladder runs at a
    // sim time the world clock hasn't reached, so the offer hasn't expired).
    await processDue(db, worldId, at(due, 7));
    expect((await loanRow(db, borrower.loanId)).status).toBe("substandard");
    const offer = applied.envelope.data as Data;
    const accepted = await call(db, "accept_offer", sibling.key, {
      offer_id: offer.offer_id,
      disclosure_hash: offer.disclosure_hash,
    });
    expect(accepted.envelope.status).toBe("MANDATE_FROZEN");
    expect(accepted.envelope.reason_codes).toEqual(["delinquent_principal"]);
  });

  it("unfreezing an agent with a substandard loan lands on restricted, not active", async () => {
    const worldId = (await createWorld(db, { name: "Unfreeze", ownerPrincipalId: null, railMode: "sim" })).worldId;
    await fundPool(db, worldId, 30000);
    const borrower = await borrow(db, worldId);
    const due = (await loanRow(db, borrower.loanId)).dueSimAt;
    await processDue(db, worldId, at(due, 7));
    expect(await agentStatus(db, borrower.agentId)).toBe("restricted");
    expect(await setAgentFrozen(db, { principalId: borrower.principalId, agentId: borrower.agentId, frozen: true })).toBe("frozen");
    expect(await setAgentFrozen(db, { principalId: borrower.principalId, agentId: borrower.agentId, frozen: false })).toBe(
      "unfrozen",
    );
    expect(await agentStatus(db, borrower.agentId)).toBe("restricted");
  });

  it("the tick cron runs the ladder for every active world", async () => {
    const worldId = (await createWorld(db, { name: "Tick", ownerPrincipalId: null, railMode: "sim" })).worldId;
    await fundPool(db, worldId, 30000);
    const borrower = await borrow(db, worldId);
    const due = (await loanRow(db, borrower.loanId)).dueSimAt;
    const now = await getSimNow(db, worldId);
    await advanceClock(db, worldId, Math.ceil((at(due, 3).getTime() - now.getTime()) / DAY_MS));

    const report = await runTick(db);
    expect(report.ladderSteps).toBe(2);
    expect((await loanRow(db, borrower.loanId)).delinquencyStep).toBe("penalty");
    expect((await runTick(db)).ladderSteps).toBe(0);
    await expectBalanced(db, worldId);
  });

  it("private world: +7 +7 +1 advances run the ladder day by day (late notice on its day, substandard at +7)", async () => {
    // The borrower's principal owns a private (sim) world with no bots.
    const placeholder = await db
      .insert(principals)
      .values({ email: "owner@example.com", name: "Owner", entityType: "individual", verifiedAt: new Date() })
      .returning();
    const ownerId = placeholder[0]!.id;
    const { worldId } = await createWorld(db, { name: "Sandbox", ownerPrincipalId: ownerId, railMode: "sim", kind: "private" });
    await fundPool(db, worldId, 30000);
    const borrower = await borrow(db, worldId, { principalId: ownerId });
    const due = (await loanRow(db, borrower.loanId)).dueSimAt;

    expect((await advancePrivateWorld(db, ownerId, worldId, 7)).outcome).toBe("advanced");
    expect((await loanRow(db, borrower.loanId)).status).toBe("active");
    await advancePrivateWorld(db, ownerId, worldId, 7);
    // Day 14 since the anchor: the loan was disbursed a moment after the
    // anchor, so it falls due during day 14 and isn't a full day late yet.
    expect((await loanRow(db, borrower.loanId)).status).toBe("active");
    await advancePrivateWorld(db, ownerId, worldId, 2);
    const late = await loanRow(db, borrower.loanId);
    expect(late.status).toBe("late");
    const lateNotice = (await noticesFor(db, borrower.loanId)).find((n) => n.kind === "late")!;
    expect(lateNotice.simAt.getTime()).toBe(at(due, 1).getTime());

    await advancePrivateWorld(db, ownerId, worldId, 7);
    expect((await loanRow(db, borrower.loanId)).status).toBe("substandard");
    expect(await agentStatus(db, borrower.agentId)).toBe("restricted");
    await expectBalanced(db, worldId);
  });

  /** Starts a full-payoff repay_loan (a quote) and returns its PayPal checkout id (not yet approved). */
  async function quote(key: string, loanId: string) {
    const started = await call(db, "repay_loan", key, { loan_id: loanId });
    expect(started.envelope.status).toBe("AWAITING_APPROVAL");
    return started.envelope.data as Data;
  }

  async function payQuote(key: string, checkoutId: string) {
    await simApprove(db, checkoutId);
    const confirmed = await call(db, "confirm_checkout", key, { checkout_id: checkoutId });
    expect(confirmed.envelope.status).toBe("COMPLETED");
    return confirmed.envelope.data as Data;
  }

  async function advanceTo(worldId: string, target: Date) {
    const now = await getSimNow(db, worldId);
    const days = Math.ceil((target.getTime() - now.getTime()) / DAY_MS);
    if (days > 0) {
      await advanceClock(db, worldId, days);
    }
    return getSimNow(db, worldId);
  }

  it("Ruling P4-C: a payoff quoted at +4 and captured a day later (penalty accrued meanwhile) → REPAID, post-quote penalty waived", async () => {
    const worldId = (await createWorld(db, { name: "Quote", ownerPrincipalId: null, railMode: "sim" })).worldId;
    await fundPool(db, worldId, 30000);
    const borrower = await borrow(db, worldId);
    const due = (await loanRow(db, borrower.loanId)).dueSimAt;
    await processDue(db, worldId, await advanceTo(worldId, at(due, 4)));
    expect((await loanRow(db, borrower.loanId)).penaltyOutstandingCents).toBe(penaltyFor(25000n, 4));

    const quoted = await quote(borrower.key, borrower.loanId);
    expect(quoted.amount_cents).toBe(25333 + 500 + Number(penaltyFor(25000n, 4)));
    const [link] = await db.select().from(repaymentLinks).where(eq(repaymentLinks.loanId, borrower.loanId));
    expect(link!.quotedCents).toBe(BigInt(quoted.amount_cents as number));
    expect(link!.quoteSimAt).not.toBeNull();

    // A day passes and the ladder accrues one more day of penalty before the payer approves.
    await advanceClock(db, worldId, 1);
    await processDue(db, worldId, await getSimNow(db, worldId));
    expect((await loanRow(db, borrower.loanId)).penaltyOutstandingCents).toBe(penaltyFor(25000n, 5));

    const paid = await payQuote(borrower.key, quoted.checkout_id as string);
    expect(paid.loan_status).toBe("REPAID");
    const loan = await loanRow(db, borrower.loanId);
    expect(loan.status).toBe("repaid");
    expect(loan.waivedCents).toBe(penaltyFor(25000n, 5) - penaltyFor(25000n, 4));
    expect(loan.penaltyOutstandingCents).toBe(0n);
    const waived = await db
      .select()
      .from(events)
      .where(and(eq(events.aggregateId, borrower.loanId), eq(events.type, "loan.charges_waived")));
    expect(waived).toHaveLength(1);
    expect(await getAccountBalance(db, worldId, "penalty_income", null)).toBe(-penaltyFor(25000n, 4));
    expect(await getAccountBalance(db, worldId, "loans_receivable", null)).toBe(0n);
    await expectBalanced(db, worldId);
  });

  it("Ruling P4-C: a quote whose capture lands before the next ladder run accrues the penalty only to the quote time", async () => {
    const worldId = (await createWorld(db, { name: "Quote2", ownerPrincipalId: null, railMode: "sim" })).worldId;
    await fundPool(db, worldId, 30000);
    const borrower = await borrow(db, worldId);
    const due = (await loanRow(db, borrower.loanId)).dueSimAt;
    await processDue(db, worldId, await advanceTo(worldId, at(due, 4)));
    const quoted = await quote(borrower.key, borrower.loanId);
    await advanceClock(db, worldId, 2); // no processDue in between
    const paid = await payQuote(borrower.key, quoted.checkout_id as string);
    expect(paid).toMatchObject({ loan_status: "REPAID", applied_penalty_cents: Number(penaltyFor(25000n, 4)) });
    expect((await loanRow(db, borrower.loanId)).waivedCents).toBe(0n);
    await expectBalanced(db, worldId);
  });

  it("Ruling P4-C: quoted on the due day, approved after +1 (late fee assessed meanwhile) → REPAID with the late fee waived", async () => {
    const worldId = (await createWorld(db, { name: "Quote3", ownerPrincipalId: null, railMode: "sim" })).worldId;
    await fundPool(db, worldId, 30000);
    const borrower = await borrow(db, worldId);
    const due = (await loanRow(db, borrower.loanId)).dueSimAt;
    const onDueDay = await advanceTo(worldId, due);
    expect(daysLate(due, onDueDay)).toBe(0);
    const quoted = await quote(borrower.key, borrower.loanId);
    expect(quoted.amount_cents).toBe(25333);

    await advanceClock(db, worldId, 1);
    await processDue(db, worldId, await getSimNow(db, worldId));
    expect((await loanRow(db, borrower.loanId)).status).toBe("late");

    const paid = await payQuote(borrower.key, quoted.checkout_id as string);
    expect(paid).toMatchObject({ loan_status: "REPAID", applied_late_fee_cents: 0, applied_fee_cents: 333 });
    const loan = await loanRow(db, borrower.loanId);
    expect(loan.waivedCents).toBe(500n);
    expect(loan.lateFeeOutstandingCents).toBe(0n);
    expect(await agentStatus(db, borrower.agentId)).toBe("active");
    expect(await getAccountBalance(db, worldId, "late_fee_income", null)).toBe(0n);
    await expectBalanced(db, worldId);
  });

  it("Ruling P4-C: a partial repay_loan amount is not a quote (no waiver); invoice links accrue the penalty to the capture", async () => {
    const worldId = (await createWorld(db, { name: "Invoice", ownerPrincipalId: null, railMode: "sim" })).worldId;
    await fundPool(db, worldId, 30000);
    // Invoice-backed: 40000 invoice, fee 270 at grade A with 1.6× collateral.
    const borrower = await createTestAgent(db, worldId, "borrower@example.com");
    const applied = await call(db, "apply_for_loan", borrower.key, {
      amount_cents: 25000,
      term_days: 14,
      purpose: "Working capital",
      invoice: { client_email: "client@example.com", amount_cents: 40000, due_in_days: 14, description: "Build" },
    });
    const offer = applied.envelope.data as Data;
    const accepted = await call(db, "accept_offer", borrower.key, {
      offer_id: offer.offer_id,
      disclosure_hash: offer.disclosure_hash,
    });
    const loanId = (accepted.envelope.data as Data).loan_id as string;
    const due = (await loanRow(db, loanId)).dueSimAt;
    await processDue(db, worldId, await advanceTo(worldId, at(due, 3)));

    // A partial direct repayment carries no quote.
    const partial = await call(db, "repay_loan", borrower.key, { loan_id: loanId, amount_cents: 100 });
    const [direct] = await db
      .select()
      .from(repaymentLinks)
      .where(and(eq(repaymentLinks.loanId, loanId), eq(repaymentLinks.kind, "direct")));
    expect(partial.envelope.status).toBe("AWAITING_APPROVAL");
    expect(direct!.quotedCents).toBeNull();

    // The client pays the invoice two days later: the penalty is accrued to the capture (5 days), nothing waived.
    await advanceClock(db, worldId, 2);
    const [invoice] = await db
      .select()
      .from(repaymentLinks)
      .where(and(eq(repaymentLinks.loanId, loanId), eq(repaymentLinks.kind, "invoice")));
    expect(invoice!.quotedCents).toBeNull();
    await simApprove(db, invoice!.paypalOrderId!);
    await settleCheckoutByOrderId(db, worldId, invoice!.paypalOrderId!);
    const loan = await loanRow(db, loanId);
    expect(loan.status).toBe("repaid");
    expect(loan.waivedCents).toBe(0n);
    const [paid] = await db.select().from(repayments).where(eq(repayments.loanId, loanId));
    expect(paid!.appliedLateFeeCents).toBe(500n);
    expect(paid!.appliedPenaltyCents).toBe(penaltyFor(25000n, 5));
    await expectBalanced(db, worldId);
  });

  it("M1: an unfreeze racing the cure of the agent's last substandard loan ends active (agent row lock)", async () => {
    const worldId = (await createWorld(db, { name: "Race2", ownerPrincipalId: null, railMode: "sim" })).worldId;
    await fundPool(db, worldId, 30000);
    const borrower = await borrow(db, worldId);
    const due = (await loanRow(db, borrower.loanId)).dueSimAt;
    await processDue(db, worldId, await advanceTo(worldId, at(due, 7)));
    expect(await agentStatus(db, borrower.agentId)).toBe("restricted");
    expect(await setAgentFrozen(db, { principalId: borrower.principalId, agentId: borrower.agentId, frozen: true })).toBe("frozen");

    // A frozen agent may still repay; the payer approves, then the capture and the unfreeze race.
    const quoted = await quote(borrower.key, borrower.loanId);
    await simApprove(db, quoted.checkout_id as string);
    const [confirmed, unfrozen] = await Promise.all([
      call(db, "confirm_checkout", borrower.key, { checkout_id: quoted.checkout_id }),
      setAgentFrozen(db, { principalId: borrower.principalId, agentId: borrower.agentId, frozen: false }),
    ]);
    expect(confirmed.envelope.status).toBe("COMPLETED");
    expect(unfrozen).toBe("unfrozen");
    expect((await loanRow(db, borrower.loanId)).status).toBe("repaid");
    expect(await agentStatus(db, borrower.agentId)).toBe("active");
  });

  it("M2: get_status reports 0 days late for a loan that isn't funded yet", async () => {
    const worldId = (await createWorld(db, { name: "M2", ownerPrincipalId: null, railMode: "sim" })).worldId;
    await fundPool(db, worldId, 30000);
    const borrower = await borrow(db, worldId);
    await db.update(loans).set({ status: "disbursing", dueSimAt: new Date(0) }).where(eq(loans.id, borrower.loanId));
    const status = (await call(db, "get_status", borrower.key, {})).envelope.data as Data;
    expect((status.open_loan as Data).days_late).toBe(0);
  });

  it("Ruling P4-A: the main world's clock runs at speed 1", async () => {
    const { worldId } = await ensureMainWorld(db);
    const [row] = await db.select().from(clock).where(eq(clock.worldId, worldId));
    expect(Number(row!.speed)).toBe(1);
  });
});
