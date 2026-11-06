import { and, eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Db } from "@/server/db/client";
import { paypalOperations, repaymentLinks, repayments } from "@/server/db/schema";
import { createTestDb } from "@/server/db/testing";
import { runReconcile } from "@/server/jobs/reconcile";
import { deriveOperationId } from "@/server/paypal/operations";
import { simApprove, simSetCaptureStatus } from "@/server/rail/simHandler";
import { getCaptureHandler } from "@/server/services/checkouts";

import {
  borrow,
  call,
  createSimWorld,
  fundPool,
  getLoan,
  invoiceLink,
  journalsWithKeyPrefix,
  later,
  type Data,
} from "./fixtures";

async function orderGets(db: Db, worldId: string, orderId: string) {
  return db
    .select()
    .from(paypalOperations)
    .where(
      and(
        eq(paypalOperations.worldId, worldId),
        eq(paypalOperations.kind, "order.get"),
        eq(paypalOperations.paypalId, orderId),
      ),
    );
}

async function captureOp(db: Db, worldId: string, orderId: string) {
  const [op] = await db
    .select()
    .from(paypalOperations)
    .where(eq(paypalOperations.id, deriveOperationId(worldId, "repayment_capture", orderId)));
  return op;
}

describe("Fix round 1 (I1): a capture stored PENDING is re-observed", () => {
  let db: Db;

  beforeEach(async () => {
    process.env.API_KEY_PEPPER = "test-pepper";
    db = await createTestDb();
  });

  afterEach(() => {
    delete process.env.API_KEY_PEPPER;
  });

  it("reconcile leaves it PENDING (writing an order.get), then a later read showing COMPLETED settles it exactly once", async () => {
    const worldId = await createSimWorld(db);
    await fundPool(db, worldId, 30000);
    const borrower = await borrow(db, worldId);
    const orderId = (await invoiceLink(db, borrower.loanId))!.paypalOrderId!;
    await simApprove(db, orderId);
    await simSetCaptureStatus(db, orderId, "PENDING");

    await runReconcile(db, { now: later() });
    expect(((await captureOp(db, worldId, orderId))!.response as Data).captureStatus).toBe("PENDING");
    expect((await getLoan(db, borrower.loanId)).status).toBe("active");
    expect((await invoiceLink(db, borrower.loanId))?.status).toBe("open");
    const readsBefore = (await orderGets(db, worldId, orderId)).length;

    // Still PENDING on PayPal's side: the next due check re-reads the order but applies nothing.
    await runReconcile(db, { now: later(2 * 60_000) });
    expect((await orderGets(db, worldId, orderId)).length).toBe(readsBefore + 1);
    expect(await journalsWithKeyPrefix(db, worldId, "repayment_capture:")).toHaveLength(0);

    // Throttled: a run within the 1-minute interval of that read doesn't read again.
    await runReconcile(db, { now: later() });
    expect((await orderGets(db, worldId, orderId)).length).toBe(readsBefore + 1);

    await simSetCaptureStatus(db, orderId, "COMPLETED");
    await runReconcile(db, { now: later(4 * 60_000) });
    expect((await getLoan(db, borrower.loanId)).status).toBe("repaid");
    expect(await journalsWithKeyPrefix(db, worldId, "repayment_capture:")).toHaveLength(2); // capture + holders
    await runReconcile(db, { now: later(10 * 60_000) });
    expect(await journalsWithKeyPrefix(db, worldId, "repayment_capture:")).toHaveLength(2);
    const [repayment] = await db.select().from(repayments).where(eq(repayments.loanId, borrower.loanId));
    expect(repayment?.remainderStatus).toBe("paid");
    // Task 10b: the PENDING capture had no fee breakdown; the re-read COMPLETED one does — journaled once.
    const captureId = ((await captureOp(db, worldId, orderId))!.response as Data).captureId as string;
    expect(await journalsWithKeyPrefix(db, worldId, `paypal_fee:capture:${captureId}`)).toHaveLength(1);
  });

  it("a PENDING capture later DENIED → applyFailure (direct checkout failed, nothing applied)", async () => {
    const worldId = await createSimWorld(db);
    await fundPool(db, worldId, 30000);
    const borrower = await borrow(db, worldId, { invoice: false });
    const repay = await call(db, "repay_loan", borrower.key, { loan_id: borrower.loanId, amount_cents: 1000 });
    const orderId = (repay.envelope.data as Data).checkout_id as string;
    await simApprove(db, orderId);
    await simSetCaptureStatus(db, orderId, "PENDING");
    const pending = await call(db, "confirm_checkout", borrower.key, { checkout_id: orderId });
    expect(pending.envelope.status).toBe("PENDING");

    await simSetCaptureStatus(db, orderId, "DENIED");
    await runReconcile(db, { now: later(2 * 60_000) });
    const [link] = await db.select().from(repaymentLinks).where(eq(repaymentLinks.paypalOrderId, orderId));
    expect(link?.status).toBe("failed");
    expect((await getLoan(db, borrower.loanId)).outstandingCents).toBe(25333n);
    expect(await journalsWithKeyPrefix(db, worldId, "repayment_capture:")).toHaveLength(0);
  });
});

describe("Fix round 1 (M4): a stale order of a re-issued invoice link can't fail the new link", () => {
  let db: Db;

  beforeEach(async () => {
    process.env.API_KEY_PEPPER = "test-pepper";
    db = await createTestDb();
  });

  afterEach(() => {
    delete process.env.API_KEY_PEPPER;
  });

  it("applyFailure for the first issue's order leaves the re-issued link open; for the current issue it fails it", async () => {
    const worldId = await createSimWorld(db);
    await fundPool(db, worldId, 30000);
    const borrower = await borrow(db, worldId);
    const original = await invoiceLink(db, borrower.loanId);
    await db.update(repaymentLinks).set({ status: "failed" }).where(eq(repaymentLinks.id, original!.id));
    await runReconcile(db, { now: later() });
    const reissued = await invoiceLink(db, borrower.loanId);
    expect(reissued?.status).toBe("open");

    const handler = getCaptureHandler("repayment_link")!;
    await handler.applyFailure(db, worldId, {
      createSourceId: borrower.loanId,
      orderId: original!.paypalOrderId!,
      reason: "order_voided",
    });
    expect((await invoiceLink(db, borrower.loanId))?.status).toBe("open");

    await handler.applyFailure(db, worldId, {
      createSourceId: `${borrower.loanId}:2`,
      orderId: reissued!.paypalOrderId!,
      reason: "order_voided",
    });
    expect((await invoiceLink(db, borrower.loanId))?.status).toBe("failed");
  });
});

describe("Fix round 1 (M3): read operations carry their PayPal id from enqueue", () => {
  let db: Db;

  beforeEach(async () => {
    process.env.API_KEY_PEPPER = "test-pepper";
    db = await createTestDb();
  });

  afterEach(() => {
    delete process.env.API_KEY_PEPPER;
  });

  it("an order.get row has paypal_id = the order id even while queued/failed", async () => {
    const { enqueueReadOperation, buildGetOrderRequest, buildGetPayoutRequest } = await import(
      "@/server/paypal/operations"
    );
    const worldId = await createSimWorld(db);
    const { operationId } = await enqueueReadOperation(db, {
      worldId,
      rail: "sim",
      kind: "order.get",
      request: buildGetOrderRequest("ORDER-Q"),
    });
    const payout = await enqueueReadOperation(db, {
      worldId,
      rail: "sim",
      kind: "payout.get",
      request: buildGetPayoutRequest("BATCH-Q"),
    });
    const rows = await db
      .select()
      .from(paypalOperations)
      .where(sql`${paypalOperations.id} in (${operationId}, ${payout.operationId})`);
    expect(rows.find((r) => r.id === operationId)?.paypalId).toBe("ORDER-Q");
    expect(rows.find((r) => r.id === payout.operationId)?.paypalId).toBe("BATCH-Q");
  });
});
