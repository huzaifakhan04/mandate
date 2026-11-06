/**
 * P5 Task 2 — the daily CECL-style allowance (booked inside
 * `stepEconomy`'s day) and its reconciliation with the P4 charge-off
 * (Review Focus 3): the charge-off releases the loan's reserve and
 * provisions only the shortfall, so the provision expense over the loan's
 * life is the loss, the allowance never goes negative, the trial balance
 * stays 0 and Ruling T holds. Also runs on real Postgres (`test:pg`).
 */
import { and, asc, eq, like } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { advanceClock } from "@/server/clock/clock";
import type { Db } from "@/server/db/client";
import { economyState, journalEntries, loanLadderSteps, loans, notePositions, offers, postings, principals } from "@/server/db/schema";
import { createTestDb } from "@/server/db/testing";
import { ceclLoanCents } from "@/server/domain/cecl";
import { getAccountBalance, getCodeBalance, trialBalance } from "@/server/ledger/trialBalance";
import { simApprove } from "@/server/rail/simHandler";
import { allowanceBalance, ceclTarget } from "@/server/services/cecl";
import { processDue } from "@/server/services/collections";
import { stepEconomy } from "@/server/services/economy";
import { advancePrivateWorld, createPrivateWorld } from "@/server/services/privateWorlds";

import { call, createSimWorld, createTestAgent, fundPool, type Data } from "../../helpers/world";

const DAY_MS = 86_400_000;

function at(due: Date, days: number): Date {
  return new Date(due.getTime() + days * DAY_MS);
}

describe("CECL allowance (P5 Task 2)", () => {
  let db: Db;
  let worldId: string;

  beforeEach(async () => {
    vi.stubEnv("SESSION_SECRET", "unit-test-session-secret-0123456789abcdef");
    vi.stubEnv("API_KEY_PEPPER", "test-pepper");
    db = await createTestDb();
    worldId = await createSimWorld(db);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function borrow(email: string, amountCents = 25000) {
    const borrower = await createTestAgent(db, worldId, email);
    const applied = await call(db, "apply_for_loan", borrower.key, {
      amount_cents: amountCents,
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
    const [loan] = await db.select().from(loans).where(eq(loans.id, loanId));
    const [offerRow] = await db.select().from(offers).where(eq(offers.id, loan!.offerId));
    const el = ((offerRow!.disclosure as Data).rate_components as Data).expected_loss_bps as number;
    expect(el).toBeGreaterThan(0);
    return { ...borrower, loanId, due: loan!.dueSimAt, el, principal: BigInt(amountCents) };
  }

  async function ceclJournals() {
    const entries = await db
      .select()
      .from(journalEntries)
      .where(and(eq(journalEntries.worldId, worldId), like(journalEntries.idempotencyKey, "cecl:%"))!)
      .orderBy(asc(journalEntries.idempotencyKey));
    return entries;
  }

  /** Σ of the provision_expense debits (+) / credits (−) of the CECL journals. */
  async function ceclProvisionTotal() {
    let total = 0n;
    for (const entry of await ceclJournals()) {
      const rows = await db.select().from(postings).where(eq(postings.entryId, entry.id));
      // The provision_expense leg is the one with the same sign as the delta; the pair sums to 0.
      const amounts = rows.map((row) => row.amountCents);
      expect(amounts.reduce((a, b) => a + b, 0n)).toBe(0n);
      total += (entry.memo ?? "").includes("release") ? -absMax(amounts) : absMax(amounts);
    }
    return total;
  }

  function absMax(amounts: bigint[]) {
    return amounts.reduce((max, a) => (a > max ? a : -a > max ? -a : max), 0n);
  }

  async function expectInvariants() {
    expect((await trialBalance(db, worldId)).totalCents).toBe(0n);
    expect(await allowanceBalance(db, worldId)).toBeGreaterThanOrEqual(0n);
    const positions = await db.select().from(notePositions).where(eq(notePositions.worldId, worldId));
    for (const position of positions) {
      expect(-(await getAccountBalance(db, worldId, "notes_payable", position.agentId))).toBe(position.units);
    }
  }

  it("books the delta daily: up when a loan opens, down (release) when one is repaid; cecl_reserve_cents stored", async () => {
    await fundPool(db, worldId, 60000);
    const first = await borrow("b1@example.com");
    const reserve1 = ceclLoanCents({ outstandingPrincipalCents: first.principal, expectedLossBps: first.el, delinquent: false });

    const day0 = await stepEconomy(db, worldId, 0);
    expect(day0.ceclReserveCents).toBe(reserve1);
    expect(await allowanceBalance(db, worldId)).toBe(reserve1);
    expect(await getCodeBalance(db, worldId, "provision_expense")).toBe(reserve1);
    expect((await ceclJournals()).map((entry) => entry.idempotencyKey)).toEqual([`cecl:${worldId}:0`]);

    const second = await borrow("b2@example.com", 10000);
    const reserve2 = ceclLoanCents({ outstandingPrincipalCents: second.principal, expectedLossBps: second.el, delinquent: false });
    const day1 = await stepEconomy(db, worldId, 1);
    expect(day1.ceclReserveCents).toBe(reserve1 + reserve2);
    expect(await allowanceBalance(db, worldId)).toBe(reserve1 + reserve2);
    expect(await ceclJournals()).toHaveLength(2);

    // Repay the first loan in full → the next day releases its reserve.
    const started = await call(db, "repay_loan", first.key, { loan_id: first.loanId });
    const checkoutId = (started.envelope.data as Data).checkout_id as string;
    await simApprove(db, checkoutId);
    expect((await call(db, "confirm_checkout", first.key, { checkout_id: checkoutId })).envelope.status).toBe("COMPLETED");
    const day2 = await stepEconomy(db, worldId, 2);
    expect(day2.ceclReserveCents).toBe(reserve2);
    expect(await allowanceBalance(db, worldId)).toBe(reserve2);
    const journals = await ceclJournals();
    expect(journals).toHaveLength(3);
    expect(journals[2]!.memo).toMatch(/release/);
    expect(await ceclProvisionTotal()).toBe(reserve2);
    // A day with no change books nothing (but still stores the reserve).
    const day3 = await stepEconomy(db, worldId, 3);
    expect(day3.ceclReserveCents).toBe(reserve2);
    expect(await ceclJournals()).toHaveLength(3);
    await expectInvariants();
  });

  it("is idempotent per day: re-stepping (also concurrently) never books a second delta", async () => {
    await fundPool(db, worldId, 60000);
    const loan = await borrow("b1@example.com");
    const reserve = ceclLoanCents({ outstandingPrincipalCents: loan.principal, expectedLossBps: loan.el, delinquent: false });
    await Promise.all([stepEconomy(db, worldId, 2), stepEconomy(db, worldId, 2), stepEconomy(db, worldId, 1)]);
    expect(await allowanceBalance(db, worldId)).toBe(reserve);
    expect(await ceclJournals()).toHaveLength(1);
    // A later loan doesn't change an already-stepped day.
    await borrow("b2@example.com", 10000);
    await stepEconomy(db, worldId, 2);
    await stepEconomy(db, worldId, 0);
    expect(await allowanceBalance(db, worldId)).toBe(reserve);
    expect(await ceclJournals()).toHaveLength(1);
    const stored = await db.select().from(economyState).where(eq(economyState.worldId, worldId));
    expect(stored).toHaveLength(3);
    await expectInvariants();
  });

  it("a late loan's reserve doubles; disbursing loans are excluded", async () => {
    await fundPool(db, worldId, 60000);
    const loan = await borrow("b1@example.com");
    const single = ceclLoanCents({ outstandingPrincipalCents: loan.principal, expectedLossBps: loan.el, delinquent: false });
    await stepEconomy(db, worldId, 0);
    expect(await allowanceBalance(db, worldId)).toBe(single);

    await processDue(db, worldId, at(loan.due, 1));
    expect((await db.select().from(loans).where(eq(loans.id, loan.loanId)))[0]!.status).toBe("late");
    const target = await ceclTarget(db, worldId);
    expect(target.loans).toHaveLength(1);
    await stepEconomy(db, worldId, 1);
    const doubled = ceclLoanCents({ outstandingPrincipalCents: loan.principal, expectedLossBps: loan.el, delinquent: true });
    expect(doubled).toBe(2n * single);
    expect(await allowanceBalance(db, worldId)).toBe(doubled);

    // A loan still disbursing owes nothing: not in the target.
    await db.update(loans).set({ status: "disbursing" }).where(eq(loans.id, loan.loanId));
    expect((await ceclTarget(db, worldId)).targetCents).toBe(0n);
    await db.update(loans).set({ status: "late" }).where(eq(loans.id, loan.loanId));
    await expectInvariants();
  });

  it("charge-off with a prior allowance releases the loan's reserve and provisions only the shortfall; total expense = the loss", async () => {
    await fundPool(db, worldId, 30000, "l1@example.com");
    await fundPool(db, worldId, 30000, "l2@example.com");
    const loan = await borrow("b1@example.com");
    // The other loan is due 12 days later: still current through the charge-off.
    await advanceClock(db, worldId, 12);
    const other = await borrow("b2@example.com", 10000);
    const otherReserve = ceclLoanCents({ outstandingPrincipalCents: other.principal, expectedLossBps: other.el, delinquent: false });

    await stepEconomy(db, worldId, 0);
    // +9: late and substandard; the day's CECL run reserves 2× for it.
    await processDue(db, worldId, at(loan.due, 9));
    expect((await db.select().from(loans).where(eq(loans.id, loan.loanId)))[0]!.status).toBe("substandard");
    await stepEconomy(db, worldId, 1);
    const loanReserve = ceclLoanCents({ outstandingPrincipalCents: loan.principal, expectedLossBps: loan.el, delinquent: true });
    expect(await allowanceBalance(db, worldId)).toBe(loanReserve + otherReserve);
    const expenseBefore = await getCodeBalance(db, worldId, "provision_expense");
    expect(expenseBefore).toBe(loanReserve + otherReserve);

    // +10: charged off.
    const run = await processDue(db, worldId, at(loan.due, 10));
    expect(run.steps.charged_off).toBe(1);
    const [step] = await db
      .select()
      .from(loanLadderSteps)
      .where(and(eq(loanLadderSteps.loanId, loan.loanId), eq(loanLadderSteps.step, "charged_off"))!);
    const detail = step!.detail as Data;
    expect(detail).toMatchObject({
      allowance_released_cents: Number(loanReserve),
      provision_cents: Number(loan.principal - loanReserve),
    });
    const [provision] = await db
      .select()
      .from(journalEntries)
      .where(eq(journalEntries.idempotencyKey, `charge_off:${loan.loanId}:provision`));
    const provisionLegs = await db.select().from(postings).where(eq(postings.entryId, provision!.id));
    expect(provisionLegs.map((leg) => leg.amountCents).sort()).toEqual(
      [loan.principal - loanReserve, -(loan.principal - loanReserve)].sort(),
    );

    // The other loan's reserve is untouched; the allowance never went negative.
    expect(await allowanceBalance(db, worldId)).toBe(otherReserve);
    // Over the loan's life: CECL (loanReserve) + charge-off provision (P − reserve) = P,
    // before the holders' share (Dr notes_payable / Cr provision_expense, unchanged).
    const [charged] = await db.select().from(loans).where(eq(loans.id, loan.loanId));
    const expenseAfter = await getCodeBalance(db, worldId, "provision_expense");
    expect(expenseAfter - expenseBefore + loanReserve + charged!.holdersLossCents).toBe(loan.principal);
    expect(charged!.holdersLossCents).toBe(loan.principal);
    await expectInvariants();

    // The next day's run trues up to the remaining loans only.
    await stepEconomy(db, worldId, 2);
    expect(await allowanceBalance(db, worldId)).toBe(otherReserve);
    await expectInvariants();
  });

  it("charge-off with a short allowance (reserved at 1× only) releases what is there; no CECL run → provisions P (P4 behaviour)", async () => {
    await fundPool(db, worldId, 60000);
    const loan = await borrow("b1@example.com");
    const single = ceclLoanCents({ outstandingPrincipalCents: loan.principal, expectedLossBps: loan.el, delinquent: false });
    await stepEconomy(db, worldId, 0); // reserved while active (1×)
    await processDue(db, worldId, at(loan.due, 9));
    await processDue(db, worldId, at(loan.due, 10)); // no CECL run in between
    const [step] = await db
      .select()
      .from(loanLadderSteps)
      .where(and(eq(loanLadderSteps.loanId, loan.loanId), eq(loanLadderSteps.step, "charged_off"))!);
    expect(step!.detail).toMatchObject({
      allowance_released_cents: Number(single),
      provision_cents: Number(loan.principal - single),
    });
    expect(await allowanceBalance(db, worldId)).toBe(0n);
    // Total expense before the holders' share = P.
    const [charged] = await db.select().from(loans).where(eq(loans.id, loan.loanId));
    expect((await getCodeBalance(db, worldId, "provision_expense")) + charged!.holdersLossCents).toBe(loan.principal);
    await expectInvariants();

    // A world that never booked CECL: the full principal is provisioned, as in P4.
    worldId = await createSimWorld(db);
    await fundPool(db, worldId, 60000);
    const bare = await borrow("b3@example.com");
    await processDue(db, worldId, at(bare.due, 9));
    await processDue(db, worldId, at(bare.due, 10));
    const [bareStep] = await db
      .select()
      .from(loanLadderSteps)
      .where(and(eq(loanLadderSteps.loanId, bare.loanId), eq(loanLadderSteps.step, "charged_off"))!);
    expect(bareStep!.detail).toMatchObject({ allowance_released_cents: 0, provision_cents: 25000 });
    expect(await allowanceBalance(db, worldId)).toBe(0n);
    await expectInvariants();
  });

  it("private world, 30 simulated days with bots: trial balance 0, Ruling T, allowance ≥ 0 after each day", async () => {
    const [owner] = await db
      .insert(principals)
      .values({ paypalPayerId: "CECL", email: "cecl@example.com", name: "Cecl", entityType: "individual", verifiedAt: new Date() })
      .returning();
    const created = await createPrivateWorld(db, owner!.id, { name: "Cecl", seed: "cecl-seed" });
    if (created.outcome !== "created") {
      throw new Error(`expected created, got ${created.outcome}`);
    }
    worldId = created.worldId;
    let sawReserve = false;
    for (let day = 0; day < 30; day += 1) {
      const advanced = await advancePrivateWorld(db, owner!.id, worldId, 1);
      expect(advanced.outcome).toBe("advanced");
      await expectInvariants();
      const [row] = await db
        .select()
        .from(economyState)
        .where(eq(economyState.worldId, worldId))
        .orderBy(asc(economyState.simDay))
        .limit(1)
        .offset(day + 1);
      expect(row).toBeDefined();
      expect(row!.ceclReserveCents).toBeGreaterThanOrEqual(0n);
      sawReserve ||= row!.ceclReserveCents > 0n;
    }
    // The bots' loans got reserved at some point.
    expect(sawReserve).toBe(true);
  });
});
