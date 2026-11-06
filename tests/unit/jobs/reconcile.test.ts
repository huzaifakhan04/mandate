import { and, eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { advanceClock } from "@/server/clock/clock";
import type { Db } from "@/server/db/client";
import {
  agents,
  jobRuns,
  loans,
  noteTransactions,
  offers,
  paypalOperations,
  repaymentLinks,
  repayments,
} from "@/server/db/schema";
import { createTestDb } from "@/server/db/testing";
import { trialBalance } from "@/server/ledger/trialBalance";
import { createCronHandler } from "@/server/jobs/cronHandler";
import { runReconcile } from "@/server/jobs/reconcile";
import { runTick } from "@/server/jobs/tick";
import {
  buildCancelPayoutItemRequest,
  buildCreateOrderRequest,
  buildGetPayoutRequest,
  deriveOperationId,
  enqueueOperation,
  enqueueReadOperation,
} from "@/server/paypal/operations";
import { simApprove } from "@/server/rail/simHandler";
import { applyPayoutOutcome } from "@/server/services/loans";

import {
  borrow,
  call,
  createSimWorld,
  createTestAgent,
  fundPool,
  getLoan,
  invoiceLink,
  journalsWithKeyPrefix,
  later,
  pendingNoteBuy,
  type Data,
} from "./fixtures";

async function orderGetRows(db: Db, worldId: string, orderId: string) {
  return db
    .select()
    .from(paypalOperations)
    .where(
      and(
        eq(paypalOperations.worldId, worldId),
        eq(paypalOperations.kind, "order.get"),
        sql`${paypalOperations.executableRequest}->>'path' = ${`/v2/checkout/orders/${orderId}`}`,
      ),
    );
}

async function runs(db: Db, worldId: string, job: string) {
  return db
    .select()
    .from(jobRuns)
    .where(and(eq(jobRuns.worldId, worldId), eq(jobRuns.job, job)));
}

describe("reconcile cron", () => {
  let db: Db;

  beforeEach(async () => {
    process.env.API_KEY_PEPPER = "test-pepper";
    db = await createTestDb();
  });

  afterEach(() => {
    delete process.env.API_KEY_PEPPER;
  });

  it("Review Focus 3: the client approves the invoice link with no agent online → cron captures, loan REPAID, remainder paid", async () => {
    const worldId = await createSimWorld(db);
    await fundPool(db, worldId, 30000);
    const borrower = await borrow(db, worldId);
    const link = await invoiceLink(db, borrower.loanId);
    expect(link?.status).toBe("open");

    await simApprove(db, link!.paypalOrderId!);
    const report = await runReconcile(db, { now: later() });

    const loan = await getLoan(db, borrower.loanId);
    expect(loan.status).toBe("repaid");
    expect(loan.outstandingCents).toBe(0n);
    const [repayment] = await db.select().from(repayments).where(eq(repayments.loanId, borrower.loanId));
    expect(repayment?.remainderCents).toBe(14730n);
    expect(repayment?.remainderStatus).toBe("paid");
    expect((await invoiceLink(db, borrower.loanId))?.status).toBe("paid");
    expect(await journalsWithKeyPrefix(db, worldId, "repayment_capture:")).toHaveLength(2); // capture + holders
    expect(await journalsWithKeyPrefix(db, worldId, "remainder_payout:")).toHaveLength(1);
    expect((await trialBalance(db, worldId)).totalCents).toBe(0n);
    expect(report.checkoutsChecked).toBeGreaterThanOrEqual(1);

    // A second run changes nothing.
    await runReconcile(db, { now: later(10 * 60_000) });
    expect(await journalsWithKeyPrefix(db, worldId, "repayment_capture:")).toHaveLength(2);
    expect(await journalsWithKeyPrefix(db, worldId, "remainder_payout:")).toHaveLength(1);

    // A job_runs row for the run that did something (counts + anomalies); none for the idle second run.
    const rows = await runs(db, worldId, "reconcile");
    expect(rows).toHaveLength(1);
    const output = rows[0]!.output as Data;
    expect(output).toHaveProperty("checkouts_checked");
    expect(output).toHaveProperty("anomalies");
  });

  it("leaves a checkout younger than 30 s alone", async () => {
    const worldId = await createSimWorld(db);
    await fundPool(db, worldId, 30000);
    const borrower = await borrow(db, worldId);
    const link = await invoiceLink(db, borrower.loanId);
    await simApprove(db, link!.paypalOrderId!);

    await runReconcile(db, { now: new Date() });
    expect((await getLoan(db, borrower.loanId)).status).toBe("active");
    expect(await orderGetRows(db, worldId, link!.paypalOrderId!)).toHaveLength(0);
  });

  it("executes a queued invoice-link create (webhook-activated loan) and a stale in_flight one", async () => {
    const worldId = await createSimWorld(db);
    await fundPool(db, worldId, 30000);
    const borrower = await borrow(db, worldId, { receiver: "pending-borrower@example.com" });
    expect((await getLoan(db, borrower.loanId)).status).toBe("disbursing");

    // Activation by the applier alone (as a webhook would) leaves the link's create queued.
    await applyPayoutOutcome(db, borrower.sendOpId, { itemStatus: "SUCCESS", source: "webhook" });
    expect((await getLoan(db, borrower.loanId)).status).toBe("active");
    const queued = await invoiceLink(db, borrower.loanId);
    expect(queued?.status).toBe("pending");
    const [createOp] = await db.select().from(paypalOperations).where(eq(paypalOperations.id, queued!.createOpId!));
    expect(createOp?.status).toBe("queued");

    await runReconcile(db, { now: later() });
    const opened = await invoiceLink(db, borrower.loanId);
    expect(opened?.status).toBe("open");
    expect(opened?.approveUrl).toMatch(/^https:\/\/sim\.paypal\.local\//);
  });

  it("reclaims a stale in_flight operation", async () => {
    const worldId = await createSimWorld(db);
    await fundPool(db, worldId, 30000);
    const borrower = await borrow(db, worldId, { receiver: "pending-borrower@example.com" });
    await applyPayoutOutcome(db, borrower.sendOpId, { itemStatus: "SUCCESS", source: "webhook" });
    const link = await invoiceLink(db, borrower.loanId);
    await db
      .update(paypalOperations)
      .set({ status: "in_flight", claimedAt: sql`now() - interval '5 minutes'` })
      .where(eq(paypalOperations.id, link!.createOpId!));

    await runReconcile(db, { now: later() });
    expect((await invoiceLink(db, borrower.loanId))?.status).toBe("open");
  });

  it("polls a DISBURSING loan's payout and activates it once (and its invoice link)", async () => {
    const worldId = await createSimWorld(db);
    await fundPool(db, worldId, 30000);
    const borrower = await borrow(db, worldId, { receiver: "pending-borrower@example.com" });
    expect((await getLoan(db, borrower.loanId)).status).toBe("disbursing");

    const report = await runReconcile(db, { now: later() });
    expect(report.payoutsPolled).toBe(1);
    expect((await getLoan(db, borrower.loanId)).status).toBe("active");
    expect((await invoiceLink(db, borrower.loanId))?.status).toBe("open");

    await runReconcile(db, { now: later(5 * 60_000) });
    expect(await journalsWithKeyPrefix(db, worldId, "loan_disbursement:")).toHaveLength(1);
  });

  it("is bounded: at most `limit` items per run, and the order throttle holds across runs", async () => {
    const worldId = await createSimWorld(db);
    const buys = [
      await pendingNoteBuy(db, worldId, 1000, "L1"),
      await pendingNoteBuy(db, worldId, 1000, "L2"),
      await pendingNoteBuy(db, worldId, 1000, "L3"),
    ];
    const t0 = later();

    const first = await runReconcile(db, { now: t0, limit: 2 });
    expect(first.items).toBe(2);
    const read = await Promise.all(buys.map(async (b) => (await orderGetRows(db, worldId, b.orderId)).length));
    expect(read.reduce((a, b) => a + b, 0)).toBe(2);

    // 10 s later: the two just-checked orders are throttled; only the third is checked.
    const second = await runReconcile(db, { now: new Date(t0.getTime() + 10_000), limit: 2 });
    expect(second.items).toBe(1);
    for (const b of buys) {
      expect(await orderGetRows(db, worldId, b.orderId)).toHaveLength(1);
    }

    // Past the 1-minute interval they are checked again.
    const third = await runReconcile(db, { now: new Date(t0.getTime() + 75_000), limit: 50 });
    expect(third.items).toBe(3);
    for (const b of buys) {
      expect(await orderGetRows(db, worldId, b.orderId)).toHaveLength(2);
    }

    // Approved meanwhile → settled by the next due check.
    await simApprove(db, buys[0]!.orderId);
    await runReconcile(db, { now: new Date(t0.getTime() + 140_000) });
    const completed = await db
      .select()
      .from(noteTransactions)
      .where(and(eq(noteTransactions.worldId, worldId), eq(noteTransactions.status, "completed")));
    expect(completed).toHaveLength(1);
  });

  it("one item throwing doesn't stop the others; the error is recorded", async () => {
    const worldId = await createSimWorld(db);
    await fundPool(db, worldId, 30000);
    const borrower = await borrow(db, worldId);

    // A direct repayment checkout whose create op points at a link that doesn't exist → its settlement throws.
    const repay = await call(db, "repay_loan", borrower.key, { loan_id: borrower.loanId, amount_cents: 1000 });
    const brokenOrder = (repay.envelope.data as Data).checkout_id as string;
    await simApprove(db, brokenOrder);
    await db
      .update(paypalOperations)
      .set({ sourceId: "00000000-0000-4000-8000-00000000dead" })
      .where(and(eq(paypalOperations.kind, "order.create"), eq(paypalOperations.paypalId, brokenOrder)));

    const link = await invoiceLink(db, borrower.loanId);
    await simApprove(db, link!.paypalOrderId!);

    const report = await runReconcile(db, { now: later() });
    expect(report.errors.length).toBeGreaterThanOrEqual(1);
    expect((await getLoan(db, borrower.loanId)).status).toBe("repaid");
    const [row] = await runs(db, worldId, "reconcile");
    expect(((row!.output as Data).errors as unknown[]).length).toBeGreaterThanOrEqual(1);
  });

  it("re-issues a failed invoice link on an ACTIVE loan exactly once", async () => {
    const worldId = await createSimWorld(db);
    await fundPool(db, worldId, 30000);
    const borrower = await borrow(db, worldId);
    const original = await invoiceLink(db, borrower.loanId);
    await db.update(repaymentLinks).set({ status: "failed" }).where(eq(repaymentLinks.id, original!.id));

    const report = await runReconcile(db, { now: later() });
    expect(report.linksReissued).toBe(1);
    const reissued = await invoiceLink(db, borrower.loanId);
    expect(reissued?.id).toBe(original!.id);
    expect(reissued?.status).toBe("open");
    expect(reissued?.createOpId).toBe(deriveOperationId(worldId, "repayment_link", `${borrower.loanId}:2`));
    expect(reissued?.paypalOrderId).not.toBe(original!.paypalOrderId);
    expect(reissued?.approveUrl).not.toBe(original!.approveUrl);

    await runReconcile(db, { now: later(2 * 60_000) });
    const creates = await db
      .select()
      .from(paypalOperations)
      .where(
        and(
          eq(paypalOperations.worldId, worldId),
          eq(paypalOperations.purpose, "repayment_link"),
          eq(paypalOperations.kind, "order.create"),
        ),
      );
    expect(creates).toHaveLength(2);

    // The re-issued link settles the loan like the original would have.
    await simApprove(db, reissued!.paypalOrderId!);
    await runReconcile(db, { now: later(4 * 60_000) });
    expect((await getLoan(db, borrower.loanId)).status).toBe("repaid");
    expect((await invoiceLink(db, borrower.loanId))?.status).toBe("paid");
  });

  it("lists anomalies without fixing them: review note txs, held/failed remainders", async () => {
    const worldId = await createSimWorld(db);
    await fundPool(db, worldId, 30000);
    const borrower = await borrow(db, worldId);
    const link = await invoiceLink(db, borrower.loanId);
    await simApprove(db, link!.paypalOrderId!);
    await runReconcile(db, { now: later() });

    const [repayment] = await db.select().from(repayments).where(eq(repayments.loanId, borrower.loanId));
    await db.update(repayments).set({ remainderStatus: "failed", remainderFailureReason: "FAILED" }).where(eq(repayments.id, repayment!.id));
    const [noteTx] = await db.select().from(noteTransactions).where(eq(noteTransactions.worldId, worldId));
    await db.update(noteTransactions).set({ status: "review" }).where(eq(noteTransactions.id, noteTx!.id));

    const report = await runReconcile(db, { now: later(60_000) });
    const types = report.anomalies.map((a) => a.type);
    expect(types).toContain("note_tx_review");
    expect(types).toContain("remainder_unpaid");
    // Not fixed.
    const [after] = await db.select().from(repayments).where(eq(repayments.id, repayment!.id));
    expect(after?.remainderStatus).toBe("failed");

    const rows = await runs(db, worldId, "reconcile");
    const last = rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]!;
    expect(((last.output as Data).anomalies as Data[]).map((a) => a.type)).toContain("note_tx_review");
  });

  it("lists an UNCLAIMED payout whose cancel failed terminally (liquidity stays reserved)", async () => {
    const worldId = await createSimWorld(db);
    await fundPool(db, worldId, 30000);
    const borrower = await borrow(db, worldId, { invoice: false, receiver: "unclaimed-borrower@example.com" });
    // The sim cancels UNCLAIMED instantly (RETURNED → DISBURSEMENT_FAILED). Rewind to "UNCLAIMED, cancel refused".
    const [cancel] = await db
      .select()
      .from(paypalOperations)
      .where(and(eq(paypalOperations.worldId, worldId), eq(paypalOperations.kind, "payout.cancel_item")));
    expect(cancel).toBeDefined();
    await db
      .update(paypalOperations)
      .set({
        status: "failed_terminal",
        response: { error: { name: "UNPROCESSABLE_ENTITY", issue: "ITEM_CANNOT_BE_CANCELLED", message: null, debugId: null, details: null } },
      })
      .where(eq(paypalOperations.id, cancel!.id));
    const [send] = await db.select().from(paypalOperations).where(eq(paypalOperations.id, borrower.sendOpId));
    const state = send!.simState as { items: { transactionStatus: string }[] };
    state.items[0]!.transactionStatus = "UNCLAIMED";
    await db.update(paypalOperations).set({ simState: state }).where(eq(paypalOperations.id, borrower.sendOpId));
    await db.update(loans).set({ status: "disbursing" }).where(eq(loans.id, borrower.loanId));

    const report = await runReconcile(db, { now: later() });
    expect((await getLoan(db, borrower.loanId)).status).toBe("disbursing");
    const anomaly = report.anomalies.find((a) => a.type === "unclaimed_cancel_failed");
    expect(anomaly).toMatchObject({ worldId, sourceId: borrower.loanId });
  });

  it("Task 10b: lists an UNCLAIMED payout whose cancel keeps failing retryably (not only terminally)", async () => {
    const worldId = await createSimWorld(db);
    await fundPool(db, worldId, 30000);
    const borrower = await borrow(db, worldId, { invoice: false, receiver: "unclaimed-borrower@example.com" });
    const [cancel] = await db
      .select()
      .from(paypalOperations)
      .where(and(eq(paypalOperations.worldId, worldId), eq(paypalOperations.kind, "payout.cancel_item")));
    // Rewind to "UNCLAIMED, cancel answered 500 and is backing off" (the real sandbox's behaviour).
    await db
      .update(paypalOperations)
      .set({
        status: "failed_retryable",
        attempts: 6,
        lastError: "INTERNAL_SERVER_ERROR",
        nextAttemptAt: sql`now() + interval '1 hour'`,
        response: { error: { name: "INTERNAL_SERVER_ERROR", issue: null, message: null, debugId: null, details: null } },
      })
      .where(eq(paypalOperations.id, cancel!.id));
    const [send] = await db.select().from(paypalOperations).where(eq(paypalOperations.id, borrower.sendOpId));
    const state = send!.simState as { items: { transactionStatus: string }[] };
    state.items[0]!.transactionStatus = "UNCLAIMED";
    await db.update(paypalOperations).set({ simState: state }).where(eq(paypalOperations.id, borrower.sendOpId));
    await db.update(loans).set({ status: "disbursing" }).where(eq(loans.id, borrower.loanId));

    const report = await runReconcile(db, { now: later() });
    expect((await getLoan(db, borrower.loanId)).status).toBe("disbursing");
    expect(report.anomalies).toContainEqual(
      expect.objectContaining({ type: "unclaimed_cancel_failed", worldId, sourceId: borrower.loanId }),
    );
    // Fix round 3 (M2): listed once — not also as operation_retrying.
    expect(report.anomalies.filter((a) => a.type === "operation_retrying")).toEqual([]);
  });

  it("Task 10b: lists write operations retrying ≥ 5 attempts (operation_retrying) — never reads — and capped ones", async () => {
    const worldId = await createSimWorld(db);
    const cancelOp = (itemId: string) =>
      enqueueOperation(db, {
        worldId,
        rail: "sim",
        kind: "payout.cancel_item",
        purpose: "payout_cancel",
        sourceId: itemId,
        request: buildCancelPayoutItemRequest(itemId),
      });
    const { operationId } = await cancelOp("ITEM-RETRYING");
    const { operationId: fewId } = await cancelOp("ITEM-FEW");
    // Ruling V: only order.create is ever capped.
    const { operationId: cappedId } = await enqueueOperation(db, {
      worldId,
      rail: "sim",
      kind: "order.create",
      purpose: "note_purchase",
      sourceId: "00000000-0000-4000-8000-00000000cafe",
      request: buildCreateOrderRequest({
        amountCents: 1000n,
        description: "x",
        customId: "c",
        returnUrl: "https://e.com/r",
        cancelUrl: "https://e.com/c",
      }),
    });
    const { operationId: readId } = await enqueueReadOperation(db, {
      worldId,
      rail: "sim",
      kind: "payout.get",
      request: buildGetPayoutRequest("BATCH-READ"),
    });
    const retrying = {
      status: "failed_retryable",
      lastError: "INTERNAL_SERVER_ERROR",
      nextAttemptAt: sql`now() + interval '1 hour'`,
    } as const;
    await db.update(paypalOperations).set({ ...retrying, attempts: 6 }).where(eq(paypalOperations.id, operationId));
    await db.update(paypalOperations).set({ ...retrying, attempts: 4 }).where(eq(paypalOperations.id, fewId));
    await db.update(paypalOperations).set({ ...retrying, attempts: 9 }).where(eq(paypalOperations.id, readId));
    await db
      .update(paypalOperations)
      .set({ status: "failed_terminal", attempts: 20, lastError: "retry_cap_exceeded" })
      .where(eq(paypalOperations.id, cappedId));

    // Fix round 3 (M2): a capped op last updated more than 7 days ago is no longer listed.
    const { operationId: staleCappedId } = await enqueueOperation(db, {
      worldId,
      rail: "sim",
      kind: "order.create",
      purpose: "note_purchase",
      sourceId: "00000000-0000-4000-8000-0000000000aa",
      request: buildCreateOrderRequest({
        amountCents: 1000n,
        description: "x",
        customId: "c",
        returnUrl: "https://e.com/r",
        cancelUrl: "https://e.com/c",
      }),
    });
    await db
      .update(paypalOperations)
      .set({ status: "failed_terminal", attempts: 20, lastError: "retry_cap_exceeded" })
      .where(eq(paypalOperations.id, staleCappedId));
    await db.execute(
      sql`update paypal_operations set updated_at = now() - interval '8 days' where id = ${staleCappedId}`,
    );

    const report = await runReconcile(db, { now: later() });
    expect(report.anomalies.filter((a) => a.type === "operation_retry_cap_exceeded").map((a) => a.sourceId)).toEqual([
      cappedId,
    ]);
    expect(report.anomalies.filter((a) => a.type === "operation_retrying")).toEqual([
      {
        type: "operation_retrying",
        worldId,
        sourceId: operationId,
        detail: {
          kind: "payout.cancel_item",
          purpose: "payout_cancel",
          source: "ITEM-RETRYING",
          attempts: 6,
          last_error: "INTERNAL_SERVER_ERROR",
        },
      },
    ]);
    expect(report.anomalies).toContainEqual(
      expect.objectContaining({
        type: "operation_retry_cap_exceeded",
        worldId,
        sourceId: cappedId,
        detail: expect.objectContaining({
          kind: "order.create",
          source: "00000000-0000-4000-8000-00000000cafe",
          attempts: 20,
          last_error: "retry_cap_exceeded",
        }),
      }),
    );
  });

  it("remainder payout UNCLAIMED → cancelled (RETURNED) → remainder failed, still owed, listed by reconcile", async () => {
    const worldId = await createSimWorld(db);
    await fundPool(db, worldId, 30000);
    const borrower = await borrow(db, worldId);
    // The borrower's receiver changes to one with no PayPal account before the client pays.
    await db
      .update(agents)
      .set({ payoutReceiver: "unclaimed-borrower@example.com" })
      .where(eq(agents.id, borrower.agentId));
    const link = await invoiceLink(db, borrower.loanId);
    await simApprove(db, link!.paypalOrderId!);

    const report = await runReconcile(db, { now: later() });
    expect((await getLoan(db, borrower.loanId)).status).toBe("repaid");
    const [repayment] = await db.select().from(repayments).where(eq(repayments.loanId, borrower.loanId));
    expect(repayment?.remainderStatus).toBe("failed");
    expect(repayment?.remainderFailureReason).toBe("RETURNED");
    expect(await journalsWithKeyPrefix(db, worldId, "remainder_payout:")).toHaveLength(0);
    expect(report.anomalies).toContainEqual(
      expect.objectContaining({ type: "remainder_unpaid", worldId, sourceId: repayment!.id }),
    );
    expect((await trialBalance(db, worldId)).totalCents).toBe(0n);
  });

  it("job_runs (M2): idle runs write no rows; a row when something happened or the anomaly count changed", async () => {
    const a = await createSimWorld(db, "World A");
    const b = await createSimWorld(db, "World B");
    await runReconcile(db, { now: later() });
    await runReconcile(db, { now: later(60_000) });
    expect(await runs(db, a, "reconcile")).toHaveLength(0);
    expect(await runs(db, b, "reconcile")).toHaveLength(0);

    // An anomaly appears → one row; the same anomaly next run → no new row.
    await fundPool(db, a, 1000);
    await db.update(noteTransactions).set({ status: "review" }).where(eq(noteTransactions.worldId, a));
    await runReconcile(db, { now: later(2 * 60_000) });
    expect(await runs(db, a, "reconcile")).toHaveLength(1);
    await runReconcile(db, { now: later(3 * 60_000) });
    expect(await runs(db, a, "reconcile")).toHaveLength(1);
    expect(await runs(db, b, "reconcile")).toHaveLength(0);
  });
});

describe("tick cron", () => {
  let db: Db;

  beforeEach(async () => {
    process.env.API_KEY_PEPPER = "test-pepper";
    db = await createTestDb();
  });

  afterEach(() => {
    delete process.env.API_KEY_PEPPER;
  });

  it("expires offers past expires_sim_at, idempotently, and records a job_runs row", async () => {
    const worldId = await createSimWorld(db);
    await fundPool(db, worldId, 30000);
    const agent = await createTestAgent(db, worldId, "borrower@example.com", "Slow Agent");
    const applied = await call(db, "apply_for_loan", agent.key, {
      amount_cents: 10000,
      term_days: 7,
      purpose: "Working capital",
    });
    const offerId = (applied.envelope.data as Data).offer_id as string;

    const early = await runTick(db);
    expect(early.expired).toBe(0);

    await advanceClock(db, worldId, 2);
    const ticked = await runTick(db);
    expect(ticked.expired).toBe(1);
    const [offer] = await db.select().from(offers).where(eq(offers.id, offerId));
    expect(offer?.status).toBe("expired");

    const again = await runTick(db);
    expect(again.expired).toBe(0);
    // Only the run that expired something wrote a row (M2).
    expect(await runs(db, worldId, "tick")).toHaveLength(1);
  });
});

describe("cron routes require CRON_SECRET", () => {
  let db: Db;

  beforeEach(async () => {
    db = await createTestDb();
    process.env.CRON_SECRET = "test-cron-secret";
  });

  afterEach(() => {
    delete process.env.CRON_SECRET;
  });

  function handler() {
    return createCronHandler("reconcile", (database) => runReconcile(database), { getDb: async () => db });
  }

  it("no Authorization → 401", async () => {
    const res = await handler().GET(new Request("http://localhost/api/cron/reconcile"));
    expect(res.status).toBe(401);
  });

  it("wrong secret → 401", async () => {
    const res = await handler().POST(
      new Request("http://localhost/api/cron/reconcile", {
        method: "POST",
        headers: { authorization: "Bearer nope" },
      }),
    );
    expect(res.status).toBe(401);
  });

  it("CRON_SECRET unset → 401 even with an empty bearer", async () => {
    delete process.env.CRON_SECRET;
    const res = await handler().GET(
      new Request("http://localhost/api/cron/reconcile", { headers: { authorization: "Bearer " } }),
    );
    expect(res.status).toBe(401);
  });

  it("the right secret (GET, as Vercel Cron sends) → 200 with the run's report", async () => {
    await createSimWorld(db);
    const res = await handler().GET(
      new Request("http://localhost/api/cron/reconcile", { headers: { authorization: "Bearer test-cron-secret" } }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Data;
    expect(body.ok).toBe(true);
    expect(body).toHaveProperty("report");
  });
});
