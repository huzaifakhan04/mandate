/**
 * P5 Task 3 — the treasury policy: the loan gates (reserve floor,
 * concentration, daily lending budget) at apply and again at accept under
 * the series lock (Review Focus 2), and the redemption gate with its FIFO
 * queue (Review Focus 4): queued redemptions never pay beyond cash, keep
 * their order, can be cancelled, and count as pending for Ruling P4-D.
 * Also runs on real Postgres (`test:pg`); the overlapping races are in
 * tests/pg/concurrency.test.ts.
 */
import { readFileSync } from "fs";
import path from "path";

import { and, asc, eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { advanceClock, getSimNow } from "@/server/clock/clock";
import type { Db } from "@/server/db/client";
import {
  economyState,
  loanHolderLosses,
  loans,
  notePositions,
  noteTransactions,
  paypalOperations,
  treasuryPolicy,
} from "@/server/db/schema";
import { createTestDb } from "@/server/db/testing";
import { availableLiquidity } from "@/server/domain/liquidity";
import { REASON_TEXT } from "@/server/domain/reasons";
import { runTick } from "@/server/jobs/tick";
import { getAccountBalance, getCodeBalance, trialBalance } from "@/server/ledger/trialBalance";
import { simApprove } from "@/server/rail/simHandler";
import { processDue } from "@/server/services/collections";
import { stepEconomyToNow } from "@/server/services/economy";
import { applyRedemptionPayoutOutcome, processRedemptionQueue, queuedRedemptionsFor } from "@/server/services/notes";
import { getTreasuryPolicy, setTreasuryPolicy, treasuryDefaultsDisabled } from "@/server/services/treasury";
import { createWorld, ensureMainWorld } from "@/server/services/worlds";

import { call, createSimWorld, createTestAgent, fundPool, type Data } from "../../helpers/world";

const DAY_MS = 86_400_000;
/** Only the gate under test binds. */
const ONLY_FLOOR = { reserveFloorBps: 1500, concentrationBps: 10000, dailyBudgetBps: 10000 };

describe("treasury policy (P5 Task 3)", () => {
  let db: Db;
  let worldId: string;

  beforeEach(async () => {
    vi.stubEnv("API_KEY_PEPPER", "test-pepper");
    db = await createTestDb();
    worldId = await createSimWorld(db);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function apply(key: string, amountCents: number) {
    return call(db, "apply_for_loan", key, { amount_cents: amountCents, term_days: 14, purpose: "Working capital" });
  }

  async function accept(key: string, offer: Data) {
    return call(db, "accept_offer", key, { offer_id: offer.offer_id, disclosure_hash: offer.disclosure_hash });
  }

  async function borrow(email: string, amountCents: number) {
    const borrower = await createTestAgent(db, worldId, email);
    const applied = await apply(borrower.key, amountCents);
    expect(applied.envelope.status).toBe("OFFERED");
    const accepted = await accept(borrower.key, applied.envelope.data as Data);
    expect(accepted.envelope.status).toBe("ACTIVE");
    return { ...borrower, loanId: (accepted.envelope.data as Data).loan_id as string };
  }

  async function repayInFull(key: string, loanId: string) {
    const started = await call(db, "repay_loan", key, { loan_id: loanId });
    expect(started.envelope.status).toBe("AWAITING_APPROVAL");
    const checkoutId = (started.envelope.data as Data).checkout_id as string;
    await simApprove(db, checkoutId);
    expect((await call(db, "confirm_checkout", key, { checkout_id: checkoutId })).envelope.status).toBe("COMPLETED");
  }

  async function redemption(id: string) {
    const [row] = await db.select().from(noteTransactions).where(eq(noteTransactions.id, id));
    return row!;
  }

  async function units(agentId: string) {
    const [row] = await db.select().from(notePositions).where(eq(notePositions.agentId, agentId));
    return row!.units;
  }

  async function expectInvariants() {
    expect((await trialBalance(db, worldId)).totalCents).toBe(0n);
    expect(await getCodeBalance(db, worldId, "cash_paypal")).toBeGreaterThanOrEqual(0n);
    // Ruling T.
    for (const position of await db.select().from(notePositions).where(eq(notePositions.worldId, worldId))) {
      expect(-(await getAccountBalance(db, worldId, "notes_payable", position.agentId))).toBe(position.units);
    }
  }

  // ------------------------------------------------------------------ policy

  it("a world without a row gets the defaults (gates on); a row overrides them", async () => {
    vi.stubEnv("TREASURY_POLICY_DISABLED", "");
    expect(await getTreasuryPolicy(db, worldId)).toEqual({ reserveFloorBps: 1500, concentrationBps: 3000, dailyBudgetBps: 4000 });
    await setTreasuryPolicy(db, worldId, { reserveFloorBps: 2000 });
    expect(await getTreasuryPolicy(db, worldId)).toEqual({ reserveFloorBps: 2000, concentrationBps: 3000, dailyBudgetBps: 4000 });
    await expect(setTreasuryPolicy(db, worldId, { concentrationBps: 10001 })).rejects.toThrow(/0\.\.10000/);
  });

  it("Ruling P5-A: TREASURY_POLICY_DISABLED is ignored when NODE_ENV=production (the defaults apply)", async () => {
    vi.stubEnv("TREASURY_POLICY_DISABLED", "1");
    expect(await getTreasuryPolicy(db, worldId)).toBeNull();
    vi.stubEnv("NODE_ENV", "production");
    expect(treasuryDefaultsDisabled()).toBe(false);
    expect(await getTreasuryPolicy(db, worldId)).toEqual({ reserveFloorBps: 1500, concentrationBps: 3000, dailyBudgetBps: 4000 });
  });

  it("Ruling P5-A: the main world has its own policy row (budget 100%, concentration 50%, floor 15%), seeded once and never replaced", async () => {
    const { worldId: mainId } = await ensureMainWorld(db);
    expect(await getTreasuryPolicy(db, mainId)).toEqual({ reserveFloorBps: 1500, concentrationBps: 5000, dailyBudgetBps: 10000 });
    await setTreasuryPolicy(db, mainId, { reserveFloorBps: 2000 });
    await ensureMainWorld(db);
    expect(await getTreasuryPolicy(db, mainId)).toEqual({ reserveFloorBps: 2000, concentrationBps: 5000, dailyBudgetBps: 10000 });
    expect(await db.select().from(treasuryPolicy).where(eq(treasuryPolicy.worldId, mainId))).toHaveLength(1);
    // Other worlds get no row.
    expect(await db.select().from(treasuryPolicy).where(eq(treasuryPolicy.worldId, worldId))).toHaveLength(0);
  });

  it("Ruling P5-A: migration 0028 back-fills an existing main world's policy row (and leaves a present one alone)", async () => {
    const { worldId: mainId } = await ensureMainWorld(db);
    await db.delete(treasuryPolicy).where(eq(treasuryPolicy.worldId, mainId));
    const statement = readFileSync(path.resolve(__dirname, "../../../drizzle/0028_p5_stress.sql"), "utf8")
      .split("--> statement-breakpoint")
      .find((part) => part.includes("INSERT INTO"))!;
    await db.execute(sql.raw(statement));
    expect(await getTreasuryPolicy(db, mainId)).toEqual({ reserveFloorBps: 1500, concentrationBps: 5000, dailyBudgetBps: 10000 });
    await setTreasuryPolicy(db, mainId, { concentrationBps: 4000 });
    await db.execute(sql.raw(statement));
    expect((await getTreasuryPolicy(db, mainId))!.concentrationBps).toBe(4000);
    expect(await db.select().from(treasuryPolicy).where(eq(treasuryPolicy.worldId, worldId))).toHaveLength(0);
  });

  // -------------------------------------------------------------- loan gates

  it("concentration_limit (defaults, no row): a principal over 30% of loans + liquidity is declined with the fixed text", async () => {
    vi.stubEnv("TREASURY_POLICY_DISABLED", "");
    await fundPool(db, worldId, 30000);
    const available = await availableLiquidity(db, worldId);
    const cap = (available * 3000n) / 10000n;
    const borrower = await createTestAgent(db, worldId, "big@example.com");

    const declined = await apply(borrower.key, Number(cap) + 1);
    expect(declined.envelope.status).toBe("DECLINED");
    expect(declined.envelope.reason_codes).toEqual(["concentration_limit"]);
    const text = JSON.stringify(declined.envelope.data);
    expect(text).toContain(REASON_TEXT.concentration_limit);
    expect(text).toContain("repay your human's open loans first");

    expect((await apply(borrower.key, Number(cap))).envelope.status).toBe("OFFERED");
  });

  it("concentration counts the whole principal: a sibling agent's open loan uses the same headroom", async () => {
    await setTreasuryPolicy(db, worldId, { reserveFloorBps: 0, concentrationBps: 3000, dailyBudgetBps: 10000 });
    await fundPool(db, worldId, 60000);
    const a = await borrow("a@example.com", 10000);
    const sibling = await createTestAgent(db, worldId, "sib@example.com", { principalId: a.principalId });
    const stranger = await createTestAgent(db, worldId, "x@example.com");
    // base = loans 10000 + available; cap = 30% of it; the principal already has 10000.
    const base = 10000n + (await availableLiquidity(db, worldId));
    const room = (base * 3000n) / 10000n - 10000n;
    expect((await apply(sibling.key, Number(room) + 1)).envelope.reason_codes).toEqual(["concentration_limit"]);
    expect((await apply(sibling.key, Number(room))).envelope.status).toBe("OFFERED");
    expect((await apply(stranger.key, Number(room) + 1)).envelope.status).toBe("OFFERED");
  });

  it("reserve_floor: a loan that would take available cash below 15% of notes outstanding is declined", async () => {
    await setTreasuryPolicy(db, worldId, { reserveFloorBps: 9000, concentrationBps: 10000, dailyBudgetBps: 10000 });
    await fundPool(db, worldId, 30000);
    const available = await availableLiquidity(db, worldId);
    const headroom = available - 27000n; // 90% of 30000 notes
    const borrower = await createTestAgent(db, worldId, "b@example.com");
    const declined = await apply(borrower.key, Number(headroom) + 1);
    expect(declined.envelope.reason_codes).toEqual(["reserve_floor"]);
    expect(JSON.stringify(declined.envelope.data)).toContain(REASON_TEXT.reserve_floor);
    expect((await apply(borrower.key, Number(headroom))).envelope.status).toBe("OFFERED");
  });

  it("daily_budget_exhausted: 40% of the day-start liquidity per sim day, counted on accepted principal; resets the next day", async () => {
    await setTreasuryPolicy(db, worldId, { reserveFloorBps: 0, concentrationBps: 10000, dailyBudgetBps: 4000 });
    await fundPool(db, worldId, 30000);
    const start = await availableLiquidity(db, worldId);
    const row = await stepEconomyToNow(db, worldId);
    expect(row.dayStartLiquidityCents).toBe(start);
    const budget = (start * 4000n) / 10000n;

    await borrow("a@example.com", 10000);
    const b = await createTestAgent(db, worldId, "b@example.com");
    const declined = await apply(b.key, Number(budget - 10000n) + 1);
    expect(declined.envelope.reason_codes).toEqual(["daily_budget_exhausted"]);
    expect(JSON.stringify(declined.envelope.data)).toContain("the next simulated day");
    // An offer within what is left is fine.
    expect((await apply(b.key, Number(budget - 10000n))).envelope.status).toBe("OFFERED");

    // Next sim day: a fresh snapshot, nothing used yet.
    await advanceClock(db, worldId, 1);
    const next = await stepEconomyToNow(db, worldId);
    expect(next.dayStartLiquidityCents).toBe(await availableLiquidity(db, worldId));
    expect((await apply(b.key, Number(budget - 10000n) + 1)).envelope.status).toBe("OFFERED");
  });

  it("accept_offer re-checks the budget under the series lock: the second of two in-budget offers gets 409 TREASURY_LIMIT", async () => {
    await setTreasuryPolicy(db, worldId, { reserveFloorBps: 0, concentrationBps: 10000, dailyBudgetBps: 4000 });
    await fundPool(db, worldId, 30000);
    await stepEconomyToNow(db, worldId);
    const a = await createTestAgent(db, worldId, "a@example.com");
    const b = await createTestAgent(db, worldId, "b@example.com");
    const offerA = (await apply(a.key, 10000)).envelope.data as Data;
    const offerB = (await apply(b.key, 10000)).envelope.data as Data;
    expect(offerA.offer_id && offerB.offer_id).toBeTruthy();

    expect((await accept(a.key, offerA)).envelope.status).toBe("ACTIVE");
    const refused = await accept(b.key, offerB);
    expect(refused.envelope.status).toBe("TREASURY_LIMIT");
    expect(refused.httpStatus).toBe(409);
    expect(refused.envelope.reason_codes).toEqual(["daily_budget_exhausted"]);
    expect(refused.envelope.summary).toBe(REASON_TEXT.daily_budget_exhausted);
    expect(refused.envelope.data).toMatchObject({ daily_budget_used_cents: 10000 });
    expect(await db.select().from(loans).where(eq(loans.worldId, worldId))).toHaveLength(1);
  });

  it("accept_offer re-checks concentration and the reserve floor too", async () => {
    await setTreasuryPolicy(db, worldId, { reserveFloorBps: 0, concentrationBps: 3000, dailyBudgetBps: 10000 });
    await fundPool(db, worldId, 60000);
    const a = await createTestAgent(db, worldId, "a@example.com");
    const sibling = await createTestAgent(db, worldId, "s@example.com", { principalId: a.principalId });
    const base = await availableLiquidity(db, worldId);
    const half = Number((base * 3000n) / 10000n / 2n) + 100;
    const offerA = (await apply(a.key, half)).envelope.data as Data;
    const offerS = (await apply(sibling.key, half)).envelope.data as Data;
    expect((await accept(a.key, offerA)).envelope.status).toBe("ACTIVE");
    const refused = await accept(sibling.key, offerS);
    expect(refused.envelope.status).toBe("TREASURY_LIMIT");
    expect(refused.envelope.reason_codes).toEqual(["concentration_limit"]);

    // Floor: raise it between offer and acceptance.
    const c = await createTestAgent(db, worldId, "c@example.com");
    const offerC = (await apply(c.key, 5000)).envelope.data as Data;
    await setTreasuryPolicy(db, worldId, { reserveFloorBps: 10000, concentrationBps: 10000 });
    const floored = await accept(c.key, offerC);
    expect(floored.envelope.status).toBe("TREASURY_LIMIT");
    expect(floored.envelope.reason_codes).toEqual(["reserve_floor"]);
  });

  // -------------------------------------------------------- redemption gate

  /** L1 30000 + L2 5000 of notes; a 25000 loan; then L1 redeems all available cash (queued) and L2 1000 (queued behind). */
  async function queuedPair() {
    await setTreasuryPolicy(db, worldId, ONLY_FLOOR);
    const l1 = await fundPool(db, worldId, 30000, "l1@example.com");
    const l2 = await fundPool(db, worldId, 5000, "l2@example.com");
    const borrower = await borrow("borrower@example.com", 25000);
    const available = await availableLiquidity(db, worldId);

    const first = await call(db, "redeem_notes", l1.key, { amount_cents: Number(available) });
    expect(first.envelope.status).toBe("QUEUED");
    const q1 = first.envelope.data as Data;
    expect(q1.queue).toMatchObject({ position: 1, ahead_cents: 0, reason: "reserve_floor" });
    expect(first.envelope.reason_codes).toEqual(["redemption_queued", "reserve_floor"]);
    expect(first.envelope.summary).toMatch(/queued at position 1: paying it now would take the bank's available cash/);
    expect(first.envelope.next_actions).toContainEqual({ tool: "cancel_redemption", args: { note_tx_id: q1.note_tx_id } });

    const second = await call(db, "redeem_notes", l2.key, { amount_cents: 1000 });
    expect(second.envelope.status).toBe("QUEUED");
    const q2 = second.envelope.data as Data;
    // 1000 alone would be payable — it waits only because the queue is FIFO.
    expect(q2.queue).toMatchObject({ position: 2, ahead_cents: Number(available), reason: "queue_ahead" });
    expect(second.envelope.summary).toMatch(/1 earlier redemption\(s\)/);
    return { l1, l2, borrower, available, q1Id: q1.note_tx_id as string, q2Id: q2.note_tx_id as string };
  }

  it("a gated redemption is QUEUED (no payout, units reserved); later ones queue behind it", async () => {
    const { l1, available, q1Id, q2Id } = await queuedPair();
    const row = await redemption(q1Id);
    expect(row).toMatchObject({ status: "queued", opId: null, amountCents: available });
    expect(row.queuedAt).toBeInstanceOf(Date);
    expect((await redemption(q2Id)).status).toBe("queued");
    // Queued units count against the redeemable balance.
    const more = await call(db, "redeem_notes", l1.key, { amount_cents: Number(30000n - available) + 1 });
    expect(more.envelope.status).toBe("INSUFFICIENT_NOTE_BALANCE");
    expect(await queuedRedemptionsFor(db, worldId, l1.agentId)).toEqual([
      expect.objectContaining({ noteTxId: q1Id, position: 1, amountCents: available }),
    ]);
    const status = await call(db, "get_status", l1.key, {});
    expect((status.envelope.data as Data).queued_redemptions).toEqual([
      expect.objectContaining({ note_tx_id: q1Id, position: 1, amount_cents: Number(available) }),
    ]);
    // Queued redemptions come before new loans.
    const borrower2 = await createTestAgent(db, worldId, "b2@example.com");
    expect((await apply(borrower2.key, 1000)).envelope.reason_codes).toEqual(["reserve_floor"]);
    await expectInvariants();
  });

  it("the tick pays the queue FIFO only when cash allows: a payable later one never jumps the head; never beyond cash", async () => {
    const { l1, l2, borrower, available, q1Id, q2Id } = await queuedPair();

    const idle = await runTick(db);
    expect(idle.queuedRedemptionsPaid).toBe(0);
    expect((await redemption(q1Id)).status).toBe("queued");
    expect((await redemption(q2Id)).status).toBe("queued"); // payable alone, but behind the head
    expect(await processRedemptionQueue(db, worldId)).toEqual({ paid: 0, failed: 0, remaining: 2 });

    await repayInFull(borrower.key, borrower.loanId);
    const ticked = await runTick(db);
    expect(ticked.queuedRedemptionsPaid).toBe(2);
    expect((await redemption(q1Id)).status).toBe("completed");
    expect((await redemption(q2Id)).status).toBe("completed");
    // FIFO: the head's payout was enqueued first.
    const ops = await db
      .select()
      .from(paypalOperations)
      .where(and(eq(paypalOperations.worldId, worldId), eq(paypalOperations.purpose, "note_redemption"))!)
      .orderBy(asc(paypalOperations.createdAt));
    expect(ops.map((op) => op.sourceId)).toEqual([q1Id, q2Id]);
    expect(await units(l2.agentId)).toBeGreaterThanOrEqual(4000n);
    expect(await units(l1.agentId)).toBeGreaterThanOrEqual(30000n - available);
    await expectInvariants();
  });

  it("final review I1: a frozen private world's tick still pays a queued redemption once cash arrives, with the ladder skipped", async () => {
    const { worldId: privateWorldId } = await createWorld(db, {
      name: "Frozen Private",
      ownerPrincipalId: null,
      railMode: "sim",
      kind: "private",
    });
    await setTreasuryPolicy(db, privateWorldId, ONLY_FLOOR);

    const lender = await fundPool(db, privateWorldId, 30000, "frozen-lender@example.com");
    const borrower = await createTestAgent(db, privateWorldId, "frozen-borrower@example.com");
    const offered = await call(db, "apply_for_loan", borrower.key, {
      amount_cents: 25000,
      term_days: 14,
      purpose: "Working capital",
    });
    expect(offered.envelope.status).toBe("OFFERED");
    const accepted = await call(db, "accept_offer", borrower.key, {
      offer_id: (offered.envelope.data as Data).offer_id,
      disclosure_hash: (offered.envelope.data as Data).disclosure_hash,
    });
    expect(accepted.envelope.status).toBe("ACTIVE");

    const available = await availableLiquidity(db, privateWorldId);
    const queued = await call(db, "redeem_notes", lender.key, { amount_cents: Number(available) });
    expect(queued.envelope.status).toBe("QUEUED");
    const noteTxId = (queued.envelope.data as Data).note_tx_id as string;

    // A fresh private world's clock is frozen (speed 0): the ladder is
    // skipped on the tick, but the queue still gets checked every minute —
    // nothing to pay yet, no cash has arrived.
    const beforeCash = await runTick(db, { now: new Date() });
    expect(beforeCash.queuedRedemptionsPaid).toBe(0);
    expect((await redemption(noteTxId)).status).toBe("queued");

    // Cash arrives (a note purchase, not a loan repayment the ladder would
    // need to run) — one tick pays it, even though the world is still frozen.
    await fundPool(db, privateWorldId, 10000, "frozen-lender2@example.com");
    const ticked = await runTick(db, { now: new Date() });
    expect(ticked.queuedRedemptionsPaid).toBe(1);
    expect((await redemption(noteTxId)).status).toBe("completed");
  });

  it("only the head fits: it is paid, the next stays queued (cash never goes below the floor)", async () => {
    await setTreasuryPolicy(db, worldId, ONLY_FLOOR);
    const l1 = await fundPool(db, worldId, 30000, "l1@example.com");
    const l2 = await fundPool(db, worldId, 30000, "l2@example.com");
    await borrow("borrower@example.com", 25000);
    await borrow("borrower2@example.com", 25000);
    // L1 asks for all the available cash, then L2 for 20000: both queued.
    const available = await availableLiquidity(db, worldId);
    const head = await call(db, "redeem_notes", l1.key, { amount_cents: Number(available) });
    expect(head.envelope.status).toBe("QUEUED");
    const tail = await call(db, "redeem_notes", l2.key, { amount_cents: 20000 });
    expect(tail.envelope.status).toBe("QUEUED");
    // A new lender brings in just enough for the head.
    const notes = -(await getCodeBalance(db, worldId, "notes_payable"));
    // head payable iff avail' − head ≥ ceil((notes + x − head) × 15%) with avail' = avail + x.
    const x = ((notes - available) * 1500n + 9999n) / 10000n;
    const lx = Number((x * 10000n) / 8500n) + 300; // solve y ≥ 15% × (notes + y − head), plus the capture fee
    await fundPool(db, worldId, lx, "l3@example.com");
    const result = await processRedemptionQueue(db, worldId);
    expect(result).toEqual({ paid: 1, failed: 0, remaining: 1 });
    expect((await redemption((head.envelope.data as Data).note_tx_id as string)).status).toBe("completed");
    expect((await redemption((tail.envelope.data as Data).note_tx_id as string)).status).toBe("queued");
    await expectInvariants();
  });

  it("cancel_redemption: only the holder's own QUEUED redemption; units are free again", async () => {
    const { l1, l2, q1Id } = await queuedPair();
    expect((await call(db, "cancel_redemption", l2.key, { note_tx_id: q1Id })).envelope.status).toBe("NOT_FOUND");
    const cancelled = await call(db, "cancel_redemption", l1.key, { note_tx_id: q1Id });
    expect(cancelled.envelope.status).toBe("CANCELLED");
    expect((await redemption(q1Id)).status).toBe("cancelled");
    const again = await call(db, "cancel_redemption", l1.key, { note_tx_id: q1Id });
    expect(again.envelope.status).toBe("INVALID_TRANSITION");
    expect(again.envelope.data).toMatchObject({ redemption_status: "CANCELLED" });
    expect(await units(l1.agentId)).toBe(30000n);

    // The queue moves up: L2's is now the head and is paid by the next run.
    expect(await processRedemptionQueue(db, worldId)).toEqual({ paid: 1, failed: 0, remaining: 0 });
    const paid = await db
      .select()
      .from(noteTransactions)
      .where(and(eq(noteTransactions.kind, "redeem"), eq(noteTransactions.status, "completed"))!);
    expect(paid).toHaveLength(1);
    const direct = await call(db, "redeem_notes", l1.key, { amount_cents: 100 });
    expect(direct.envelope.status).toBe("PENDING"); // paid straight away (submitted), not queued
    await expectInvariants();
  });

  it("a PENDING redemption can't be cancelled", async () => {
    await setTreasuryPolicy(db, worldId, ONLY_FLOOR);
    const lender = await fundPool(db, worldId, 30000, "pending@example.com"); // the sim rail keeps "pending" receivers pending
    const submitted = await call(db, "redeem_notes", lender.key, { amount_cents: 1000 });
    expect(submitted.envelope.status).toBe("PENDING");
    const noteTxId = (submitted.envelope.data as Data).note_tx_id as string;
    expect((await redemption(noteTxId)).status).toBe("pending");
    const refused = await call(db, "cancel_redemption", lender.key, { note_tx_id: noteTxId });
    expect(refused.envelope.status).toBe("INVALID_TRANSITION");
    expect(refused.envelope.data).toMatchObject({ redemption_status: "PENDING" });
  });

  // ----------------------------------------------------- Ruling P4-D (queued)

  /** L1 25000, L2 10000; a 25000 loan; L1's 12000 redemption QUEUED; the loan charged off at +10. */
  async function chargeOffWithQueuedRedemption() {
    await setTreasuryPolicy(db, worldId, { reserveFloorBps: 5000, concentrationBps: 10000, dailyBudgetBps: 10000 });
    const l1 = await fundPool(db, worldId, 25000, "l1@example.com");
    const l2 = await fundPool(db, worldId, 10000, "l2@example.com");
    const borrower = await borrow("borrower@example.com", 25000);
    const queued = await call(db, "redeem_notes", l1.key, { amount_cents: 12000 });
    expect(queued.envelope.status).toBe("QUEUED");
    const redemptionId = (queued.envelope.data as Data).note_tx_id as string;
    const [loan] = await db.select().from(loans).where(eq(loans.id, borrower.loanId));
    const days = Math.ceil((loan!.dueSimAt.getTime() + 10 * DAY_MS - (await getSimNow(db, worldId)).getTime()) / DAY_MS);
    await advanceClock(db, worldId, days);
    await processDue(db, worldId, await getSimNow(db, worldId));
    const [charged] = await db.select().from(loans).where(eq(loans.id, borrower.loanId));
    expect(charged!.status).toBe("charged_off");
    return { l1, l2, loanId: borrower.loanId, redemptionId };
  }

  async function lossRow(loanId: string, agentId: string) {
    const [row] = await db
      .select()
      .from(loanHolderLosses)
      .where(and(eq(loanHolderLosses.loanId, loanId), eq(loanHolderLosses.agentId, agentId))!);
    return row!;
  }

  it("P4-D: a QUEUED redemption's units defer the loss share like a pending one's; cancelling applies it", async () => {
    const { l1, l2, loanId, redemptionId } = await chargeOffWithQueuedRedemption();
    // Shares on full units: 25000 × 25000/35000 = 17857; 13000 free now, 4857 deferred.
    expect(await lossRow(loanId, l1.agentId)).toMatchObject({ lossCents: 13000n, deferredCents: 4857n });
    expect((await lossRow(loanId, l2.agentId)).lossCents).toBe(7143n);
    expect(await units(l1.agentId)).toBe(12000n);
    await expectInvariants();

    expect((await call(db, "cancel_redemption", l1.key, { note_tx_id: redemptionId })).envelope.status).toBe("CANCELLED");
    expect(await lossRow(loanId, l1.agentId)).toMatchObject({ lossCents: 17857n, deferredCents: 0n });
    expect(await units(l1.agentId)).toBe(25000n - 17857n);
    await expectInvariants();
  });

  it("P4-D: a QUEUED redemption later paid in full → the bank absorbs the deferred share", async () => {
    const { l1, loanId, redemptionId } = await chargeOffWithQueuedRedemption();
    await setTreasuryPolicy(db, worldId, { reserveFloorBps: 0 });
    const result = await processRedemptionQueue(db, worldId);
    expect(result.paid).toBe(1);
    const row = await redemption(redemptionId);
    expect(row.status).toBe("completed");
    // Settling again is a no-op.
    await applyRedemptionPayoutOutcome(db, row.opId!);
    expect(await units(l1.agentId)).toBe(0n);
    expect(await lossRow(loanId, l1.agentId)).toMatchObject({ lossCents: 13000n, deferredCents: 0n });
    await expectInvariants();
  });

  it("the economy row stores the day-start liquidity snapshot", async () => {
    await fundPool(db, worldId, 30000);
    const row = await stepEconomyToNow(db, worldId);
    const [stored] = await db.select().from(economyState).where(eq(economyState.id, row.id));
    expect(stored!.dayStartLiquidityCents).toBe(await availableLiquidity(db, worldId));
  });
});
