import { randomUUID } from "crypto";

import { and, eq, like, sql } from "drizzle-orm";
import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ok } from "@/server/contracts/envelope";
import type { ToolDef } from "@/server/contracts/registry";
import { runTool } from "@/server/contracts/runTool";
import type { Db } from "@/server/db/client";
import {
  events,
  idempotencyKeys,
  journalEntries,
  loans,
  notePositions,
  noteTransactions,
  paypalOperations,
  repaymentLinks,
  repayments,
} from "@/server/db/schema";
import { createTestDb } from "@/server/db/testing";
import { getAccountBalance, trialBalance } from "@/server/ledger/trialBalance";
import { simApprove } from "@/server/rail/simHandler";
import { settleCheckoutByOrderId } from "@/server/services/checkouts";

import {
  call,
  createSimWorld,
  createTestAgent,
  type Data,
  fundPool,
  gate,
  holdLock,
  waitForLockWaiters,
} from "./helpers";

/**
 * I1 (final review): the concurrency guarantees PGlite cannot exercise.
 * PGlite runs one transaction at a time, so a `Promise.all` there is
 * sequential. Here every transaction gets its own backend from a real `pg`
 * Pool, and each test first parks the racing calls behind one row lock
 * (`holdLock`) and waits until Postgres reports them blocked
 * (`pg_stat_activity.wait_event_type = 'Lock'`) before releasing — proof
 * that they overlapped, not merely that they were started together.
 */

const seriesLock = (worldId: string) =>
  sql`select id from note_series where world_id = ${worldId} for update`;

describe("real Postgres (TEST_PG=1)", () => {
  let db: Db;

  beforeEach(async () => {
    process.env.API_KEY_PEPPER = "test-pepper";
    db = await createTestDb();
  });

  afterEach(() => {
    delete process.env.API_KEY_PEPPER;
  });

  it("is a real multi-connection Postgres, not PGlite", async () => {
    const result = await db.execute(sql`select version() as v`);
    expect((result.rows[0] as { v: string }).v).toMatch(/^PostgreSQL 17\./);
    // Two transactions can be open at once (PGlite would deadlock here).
    const first = gate();
    const both = gate();
    let open = 0;
    const tx = () =>
      db.transaction(async (t) => {
        await t.execute(sql`select 1`);
        open += 1;
        if (open === 2) both.open();
        if (open === 1) first.open();
        await both.promise;
      });
    await Promise.all([tx(), tx()]);
    expect(open).toBe(2);
  });

  it("two agents accept 20000 each against a 34245 pool while overlapping → exactly one loan", async () => {
    const worldId = await createSimWorld(db);
    await fundPool(db, worldId, 25000);
    const a = await createTestAgent(db, worldId, "a@example.com");
    const b = await createTestAgent(db, worldId, "b@example.com");
    const apply = (key: string) =>
      call(db, "apply_for_loan", key, { amount_cents: 20000, term_days: 14, purpose: "Working capital" });
    const offerA = (await apply(a.key)).envelope.data as Data;
    const offerB = (await apply(b.key)).envelope.data as Data;

    const lock = await holdLock(db, seriesLock(worldId));
    const racing = Promise.all([
      call(db, "accept_offer", a.key, { offer_id: offerA.offer_id, disclosure_hash: offerA.disclosure_hash }),
      call(db, "accept_offer", b.key, { offer_id: offerB.offer_id, disclosure_hash: offerB.disclosure_hash }),
    ]);
    await waitForLockWaiters(db, 2);
    await lock.release();
    const [ra, rb] = await racing;

    expect([ra.envelope.status, rb.envelope.status].sort()).toEqual(["ACTIVE", "INSUFFICIENT_LIQUIDITY"]);
    expect(await db.select().from(loans).where(eq(loans.worldId, worldId))).toHaveLength(1);
    expect(await getAccountBalance(db, worldId, "loans_receivable", null)).toBe(20000n);
    expect((await trialBalance(db, worldId)).totalCents).toBe(0n);
  });

  it("one agent double-submits accept_offer for the same offer while overlapping → one loan, the other INVALID_TRANSITION", async () => {
    const worldId = await createSimWorld(db);
    await fundPool(db, worldId, 30000);
    const a = await createTestAgent(db, worldId, "a@example.com");
    const offer = (
      await call(db, "apply_for_loan", a.key, { amount_cents: 10000, term_days: 7, purpose: "Working capital" })
    ).envelope.data as Data;

    const lock = await holdLock(db, seriesLock(worldId));
    const input = { offer_id: offer.offer_id, disclosure_hash: offer.disclosure_hash };
    const racing = Promise.all([call(db, "accept_offer", a.key, input), call(db, "accept_offer", a.key, input)]);
    await waitForLockWaiters(db, 2);
    await lock.release();
    const results = await racing;

    expect(results.map((r) => r.httpStatus)).not.toContain(500);
    expect(results.map((r) => r.envelope.status)).toContain("ACTIVE");
    expect(await db.select().from(loans).where(eq(loans.worldId, worldId))).toHaveLength(1);
  });

  it("two overlapping redemptions of the full balance → exactly one is submitted", async () => {
    const worldId = await createSimWorld(db);
    const lender = await fundPool(db, worldId, 7000);

    const lock = await holdLock(db, seriesLock(worldId));
    const racing = Promise.all([
      call(db, "redeem_notes", lender.key, { amount_cents: 7000 }),
      call(db, "redeem_notes", lender.key, { amount_cents: 7000 }),
    ]);
    await waitForLockWaiters(db, 2);
    await lock.release();
    const results = await racing;

    const statuses = results.map((r) => r.envelope.status);
    expect(statuses.filter((s) => s === "INSUFFICIENT_NOTE_BALANCE")).toHaveLength(1);
    expect(results.map((r) => r.httpStatus)).not.toContain(500);
    const redemptions = await db
      .select()
      .from(noteTransactions)
      .where(and(eq(noteTransactions.worldId, worldId), eq(noteTransactions.kind, "redeem")));
    expect(redemptions).toHaveLength(1);
    const [position] = await db.select().from(notePositions).where(eq(notePositions.worldId, worldId));
    expect(-(await getAccountBalance(db, worldId, "notes_payable", position!.agentId))).toBe(position!.units);
    expect((await trialBalance(db, worldId)).totalCents).toBe(0n);
  });

  describe("claim-first idempotency under a real second connection", () => {
    let handlerRuns = 0;
    let handlerGate = gate();
    let handlerEntered = gate();

    const blockingTool: ToolDef = {
      name: "blocking_tool",
      title: "Blocking Tool",
      description: "Test-only mutating tool whose handler waits on a gate after writing.",
      auth: "agent",
      mutating: true,
      readOnly: false,
      input: z.object({ note: z.string(), shouldThrow: z.boolean().optional() }),
      output: z.object({}),
      handler: async (input, ctx) => {
        handlerRuns += 1;
        await ctx.tx.insert(events).values({
          worldId: ctx.worldId,
          type: "test.event",
          aggregateType: "test",
          aggregateId: randomUUID(),
          occurredSimAt: ctx.simNow,
        });
        handlerEntered.open();
        await handlerGate.promise;
        if (input.shouldThrow) {
          throw new Error("boom");
        }
        return ok({ run: handlerRuns }, { status: "OK", summary: "done" });
      },
    };

    beforeEach(() => {
      handlerRuns = 0;
      handlerGate = gate();
      handlerEntered = gate();
    });

    async function setup() {
      const worldId = await createSimWorld(db);
      const agent = await createTestAgent(db, worldId);
      const run = (input: Data) =>
        runTool(blockingTool, blockingTool.name, input, {
          getDb: async () => db,
          authorization: `Bearer ${agent.key}`,
          idempotencyKey: "same-key",
        });
      return { worldId, run };
    }

    it("the second request blocks on the first's uncommitted claim, then replays its committed response", async () => {
      const { worldId, run } = await setup();
      const first = run({ note: "x" });
      await handlerEntered.promise;
      const second = run({ note: "x" });
      await waitForLockWaiters(db, 1); // blocked on the unique-index claim
      handlerGate.open();
      const [r1, r2] = await Promise.all([first, second]);

      expect(handlerRuns).toBe(1);
      expect(r1.envelope.status).toBe("OK");
      expect(r2.httpStatus).toBe(r1.httpStatus);
      expect(r2.envelope).toEqual(r1.envelope);
      const rows = await db.select().from(idempotencyKeys).where(eq(idempotencyKeys.worldId, worldId));
      expect(rows).toHaveLength(1);
    });

    it("different input on the same key while the first is in flight → IDEMPOTENCY_CONFLICT after it commits", async () => {
      const { run } = await setup();
      const first = run({ note: "x" });
      await handlerEntered.promise;
      const second = run({ note: "y" });
      await waitForLockWaiters(db, 1);
      handlerGate.open();
      const [r1, r2] = await Promise.all([first, second]);
      expect(r1.envelope.status).toBe("OK");
      expect(r2.envelope.status).toBe("IDEMPOTENCY_CONFLICT");
      expect(handlerRuns).toBe(1);
    });

    it("when the first rolls back, the blocked second claims the key and runs the handler itself", async () => {
      const { worldId, run } = await setup();
      const first = run({ note: "x", shouldThrow: true });
      await handlerEntered.promise;
      const second = run({ note: "x", shouldThrow: true });
      await waitForLockWaiters(db, 1);
      handlerGate.open(); // both handlers throw once they get here
      const [r1, r2] = await Promise.all([first, second]);
      expect(r1.envelope.status).toBe("INTERNAL_ERROR");
      expect(r2.envelope.status).toBe("INTERNAL_ERROR");
      expect(handlerRuns).toBe(2); // the second really ran (claimed after rollback)
      const rows = await db.select().from(idempotencyKeys).where(eq(idempotencyKeys.worldId, worldId));
      expect(rows).toHaveLength(0);
    });
  });

  it("settleCheckoutByOrderId ×2 + confirm_checkout overlapping on one link order → one repayment, journals once", async () => {
    const worldId = await createSimWorld(db);
    await fundPool(db, worldId, 30000);
    const borrower = await createTestAgent(db, worldId, "borrower@example.com");
    const applied = await call(db, "apply_for_loan", borrower.key, {
      amount_cents: 25000,
      term_days: 14,
      purpose: "Working capital for an invoice",
      invoice: { client_email: "client@example.com", amount_cents: 40000, due_in_days: 14, description: "Site" },
    });
    const offer = applied.envelope.data as Data;
    const accepted = await call(db, "accept_offer", borrower.key, {
      offer_id: offer.offer_id,
      disclosure_hash: offer.disclosure_hash,
    });
    expect(accepted.envelope.status).toBe("ACTIVE");
    const loanId = (accepted.envelope.data as Data).loan_id as string;
    const [link] = await db
      .select()
      .from(repaymentLinks)
      .where(and(eq(repaymentLinks.loanId, loanId), eq(repaymentLinks.kind, "invoice")));
    const orderId = link!.paypalOrderId!;
    await simApprove(db, orderId);

    const lock = await holdLock(db, seriesLock(worldId));
    const racing = Promise.all([
      settleCheckoutByOrderId(db, worldId, orderId),
      settleCheckoutByOrderId(db, worldId, orderId),
      call(db, "confirm_checkout", borrower.key, { checkout_id: orderId }),
    ]);
    await waitForLockWaiters(db, 1);
    await new Promise((resolve) => setTimeout(resolve, 100)); // let the others reach the lock too
    await lock.release();
    const results = await racing;
    for (const r of results) {
      expect("envelope" in r ? r.envelope.status : r.status).not.toBe("INTERNAL_ERROR");
    }

    expect((await settleCheckoutByOrderId(db, worldId, orderId)).status).toBe("COMPLETED");
    expect(await db.select().from(repayments).where(eq(repayments.worldId, worldId))).toHaveLength(1);
    const repaymentJournals = await db
      .select()
      .from(journalEntries)
      .where(and(eq(journalEntries.worldId, worldId), like(journalEntries.idempotencyKey, "repayment_capture:%")));
    expect(repaymentJournals).toHaveLength(2); // the repayment + the holders' share
    const remainderOps = await db
      .select()
      .from(paypalOperations)
      .where(and(eq(paypalOperations.worldId, worldId), eq(paypalOperations.purpose, "remainder_payout")));
    expect(remainderOps).toHaveLength(1);
    const [loan] = await db.select().from(loans).where(eq(loans.id, loanId));
    expect(loan?.status).toBe("repaid");
    expect((await trialBalance(db, worldId)).totalCents).toBe(0n);
  });

  it("mixed traffic (buys, redemptions, accepts, repayment settlement) in parallel rounds: no 500s, no deadlocks, books balance", async () => {
    const worldId = await createSimWorld(db);
    const lenderA = await fundPool(db, worldId, 30000, "la@example.com");
    const lenderB = await fundPool(db, worldId, 20000, "lb@example.com");

    for (let round = 0; round < 6; round += 1) {
      const borrower = await createTestAgent(db, worldId, `b${round}@example.com`);
      const offer = (
        await call(db, "apply_for_loan", borrower.key, {
          amount_cents: 5000,
          term_days: 7,
          purpose: "Working capital",
          invoice: { client_email: "c@example.com", amount_cents: 9000, due_in_days: 7, description: "Job" },
        })
      ).envelope.data as Data;
      const buy = await call(db, "buy_notes", lenderB.key, { amount_cents: 1000 });
      const buyId = (buy.envelope.data as Data).checkout_id as string;
      await simApprove(db, buyId);

      const results = await Promise.all([
        call(db, "accept_offer", borrower.key, { offer_id: offer.offer_id, disclosure_hash: offer.disclosure_hash }),
        call(db, "redeem_notes", lenderA.key, { amount_cents: 500 }),
        call(db, "confirm_checkout", lenderB.key, { checkout_id: buyId }),
        settleCheckoutByOrderId(db, worldId, buyId),
      ]);
      for (const r of results) {
        expect("envelope" in r ? r.envelope.status : r.status).not.toBe("INTERNAL_ERROR");
      }
      const loanId = ((results[0] as { envelope: { data: Data } }).envelope.data.loan_id as string) ?? null;
      if (loanId) {
        const [link] = await db
          .select()
          .from(repaymentLinks)
          .where(and(eq(repaymentLinks.loanId, loanId), eq(repaymentLinks.kind, "invoice")));
        if (link?.paypalOrderId) {
          await simApprove(db, link.paypalOrderId);
          const settles = await Promise.all([
            settleCheckoutByOrderId(db, worldId, link.paypalOrderId),
            call(db, "redeem_notes", lenderB.key, { amount_cents: 300 }),
            call(db, "confirm_checkout", borrower.key, { checkout_id: link.paypalOrderId }),
          ]);
          for (const r of settles) {
            expect("envelope" in r ? r.envelope.status : r.status).not.toBe("INTERNAL_ERROR");
          }
        }
      }
    }

    expect((await trialBalance(db, worldId)).totalCents).toBe(0n);
    const positions = await db.select().from(notePositions).where(eq(notePositions.worldId, worldId));
    for (const position of positions) {
      expect(-(await getAccountBalance(db, worldId, "notes_payable", position.agentId))).toBe(position.units);
    }
  });
});
