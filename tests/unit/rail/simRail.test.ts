import { randomUUID } from "crypto";

import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Db } from "@/server/db/client";
import { paypalOperations, worlds } from "@/server/db/schema";
import { createTestDb } from "@/server/db/testing";
import {
  buildCaptureOrderRequest,
  buildCreateOrderRequest,
  buildGetOrderRequest,
  buildGetPayoutRequest,
  buildSendPayoutRequest,
  enqueueOperation,
  enqueueReadOperation,
  executeOperation,
} from "@/server/paypal/operations";
import { InvalidAmountError } from "@/server/paypal/orders";
import { simRail, SimRailError } from "@/server/rail/simRail";

// The sim rail never reaches `fetch`: executeOperation dispatches
// rail = 'sim' rows to the in-DB handler in rail/simHandler.ts.

const checkout = {
  amountCents: 1500n,
  description: "test checkout",
  customId: "custom-1",
  returnUrl: "https://example.com/return",
  cancelUrl: "https://example.com/cancel",
};

describe("sim rail through enqueueOperation / executeOperation", () => {
  let db: Db;
  let worldId: string;

  beforeAll(async () => {
    db = await createTestDb();
  });

  beforeEach(async () => {
    const [world] = await db
      .insert(worlds)
      .values({ slug: `world-${randomUUID()}`, name: "World", railMode: "sim" })
      .returning();
    if (!world) {
      throw new Error("expected a world to be inserted");
    }
    worldId = world.id;
  });

  async function createOrder(sourceId = randomUUID()) {
    const { operationId } = await enqueueOperation(db, {
      worldId,
      rail: "sim",
      kind: "order.create",
      purpose: "note_purchase",
      sourceId,
      request: buildCreateOrderRequest(checkout),
    });
    return { operationId, result: await executeOperation(db, operationId) };
  }

  async function capture(orderId: string, sourceId = randomUUID()) {
    const { operationId } = await enqueueOperation(db, {
      worldId,
      rail: "sim",
      kind: "order.capture",
      purpose: "note_purchase_capture",
      sourceId,
      request: buildCaptureOrderRequest(orderId),
    });
    return { operationId, result: await executeOperation(db, operationId) };
  }

  async function read(kind: "order.get" | "payout.get", request: ReturnType<typeof buildGetOrderRequest>) {
    const { operationId } = await enqueueReadOperation(db, { worldId, rail: "sim", kind, request });
    return executeOperation(db, operationId);
  }

  it("order.create → succeeded, PAYER_ACTION_REQUIRED, ids derived from the operation's own id", async () => {
    const { operationId, result } = await createOrder();
    expect(result).toEqual({
      operationId,
      kind: "order.create",
      status: "succeeded",
      httpStatus: 201,
      body: {
        orderId: `SIMORDER-${operationId}`,
        status: "PAYER_ACTION_REQUIRED",
        approveUrl: `https://sim.paypal.local/checkoutnow?token=SIMORDER-${operationId}`,
      },
    });
    // Replay returns the identical stored result.
    expect(await executeOperation(db, operationId)).toEqual(result);
  });

  it("order.capture without simApprove → failed_terminal ORDER_NOT_APPROVED", async () => {
    const { result: created } = await createOrder();
    const orderId = (created.body as { orderId: string }).orderId;

    const { operationId, result } = await capture(orderId);
    expect(result).toMatchObject({
      status: "failed_terminal",
      httpStatus: 422,
      body: { error: { issue: "ORDER_NOT_APPROVED" } },
    });
    const [row] = await db.select().from(paypalOperations).where(eq(paypalOperations.id, operationId));
    expect(row?.lastError).toBe("ORDER_NOT_APPROVED");
  });

  it("approve → capture → succeeded COMPLETED; capture id derived from the capture operation's id; order.get reads the state", async () => {
    const { result: created } = await createOrder();
    const orderId = (created.body as { orderId: string }).orderId;
    await simRail(db).simApprove(orderId);

    const { operationId, result } = await capture(orderId);
    expect(result).toMatchObject({
      status: "succeeded",
      body: {
        orderId,
        status: "COMPLETED",
        captureId: `SIMCAPTURE-${operationId}`,
        captureStatus: "COMPLETED",
        amountCents: "1500",
        recovered: false,
      },
    });

    const got = await read("order.get", buildGetOrderRequest(orderId));
    expect(got.body).toEqual({
      orderId,
      status: "COMPLETED",
      capture: { captureId: `SIMCAPTURE-${operationId}`, captureStatus: "COMPLETED", amountCents: "1500" },
    });
  });

  it("a second capture of an already-captured order recovers the existing capture (PayPal semantics)", async () => {
    const { result: created } = await createOrder();
    const orderId = (created.body as { orderId: string }).orderId;
    await simRail(db).simApprove(orderId);
    const first = await capture(orderId);

    const second = await capture(orderId);
    expect(second.result).toMatchObject({
      status: "succeeded",
      body: {
        captureId: `SIMCAPTURE-${first.operationId}`,
        amountCents: "1500",
        recovered: true,
      },
    });
  });

  it("two concurrent captures of the same order: exactly one capture id, both succeed", async () => {
    const { result: created } = await createOrder();
    const orderId = (created.body as { orderId: string }).orderId;
    await simRail(db).simApprove(orderId);

    const [a, b] = await Promise.all([capture(orderId), capture(orderId)]);
    const ids = [a, b].map((c) => (c.result.body as { captureId: string }).captureId);
    expect(a.result.status).toBe("succeeded");
    expect(b.result.status).toBe("succeeded");
    expect(new Set(ids).size).toBe(1);
  });

  it("capturing an unknown order → failed_terminal 404", async () => {
    const { result } = await capture("SIMORDER-nope");
    expect(result).toMatchObject({ status: "failed_terminal", httpStatus: 404 });
  });

  it("orders are world-scoped: another world can't capture or read them", async () => {
    const { result: created } = await createOrder();
    const orderId = (created.body as { orderId: string }).orderId;
    await simRail(db).simApprove(orderId);

    const [other] = await db
      .insert(worlds)
      .values({ slug: `world-${randomUUID()}`, name: "Other", railMode: "sim" })
      .returning();
    const { operationId } = await enqueueOperation(db, {
      worldId: other!.id,
      rail: "sim",
      kind: "order.capture",
      purpose: "note_purchase_capture",
      sourceId: "x",
      request: buildCaptureOrderRequest(orderId),
    });
    expect((await executeOperation(db, operationId)).httpStatus).toBe(404);
  });

  it("payout.send to a normal receiver → succeeded with item SUCCESS; payout.get reads it back", async () => {
    const { operationId } = await enqueueOperation(db, {
      worldId,
      rail: "sim",
      kind: "payout.send",
      purpose: "loan_disbursement",
      sourceId: "loan-1",
      request: buildSendPayoutRequest({
        receiver: "agent@example.com",
        receiverType: "EMAIL",
        amountCents: 700n,
        senderItemId: "loan-1",
      }),
    });
    const sent = await executeOperation(db, operationId);
    expect(sent).toMatchObject({
      status: "succeeded",
      body: {
        batchId: `SIMBATCH-${operationId}`,
        batchStatus: "SUCCESS",
        item: { itemId: `SIMITEM-${operationId}`, transactionStatus: "SUCCESS" },
      },
    });

    const got = await read("payout.get", buildGetPayoutRequest(`SIMBATCH-${operationId}`));
    expect(got.body).toEqual({
      batchId: `SIMBATCH-${operationId}`,
      batchStatus: "SUCCESS",
      items: [{ itemId: `SIMITEM-${operationId}`, transactionStatus: "SUCCESS" }],
    });
  });

  it("payout.send to a receiver containing 'fail' → operation succeeded, item FAILED (batch accepted, item failed)", async () => {
    const { operationId } = await enqueueOperation(db, {
      worldId,
      rail: "sim",
      kind: "payout.send",
      purpose: "loan_disbursement",
      sourceId: "loan-fail",
      request: buildSendPayoutRequest({
        receiver: "will-fail@example.com",
        receiverType: "EMAIL",
        amountCents: 700n,
        senderItemId: "loan-fail",
      }),
    });
    const result = await executeOperation(db, operationId);
    expect(result).toMatchObject({
      status: "succeeded",
      body: { batchStatus: "SUCCESS", item: { transactionStatus: "FAILED" } },
    });
  });

  it("payout.get for an unknown batch → failed_terminal 404", async () => {
    const result = await read("payout.get", buildGetPayoutRequest("SIMBATCH-nope"));
    expect(result).toMatchObject({ status: "failed_terminal", httpStatus: 404 });
  });
});

describe("simRail facade (enqueue + execute)", () => {
  let db: Db;
  let worldId: string;

  beforeAll(async () => {
    db = await createTestDb();
  });

  beforeEach(async () => {
    const [world] = await db
      .insert(worlds)
      .values({ slug: `world-${randomUUID()}`, name: "World", railMode: "sim" })
      .returning();
    worldId = world!.id;
  });

  const params = () => ({ worldId, ...checkout, purpose: "note_purchase" as const, sourceId: randomUUID() });

  it("creates, approves, captures and reads a checkout", async () => {
    const rail = simRail(db);
    const created = await rail.createCheckout(params());
    expect(created).toMatchObject({ rail: "sim", status: "PAYER_ACTION_REQUIRED" });
    expect(created.approveUrl).toContain(created.orderId);

    await rail.simApprove(created.orderId);
    const captured = await rail.captureCheckout({
      worldId,
      orderId: created.orderId,
      purpose: "note_purchase_capture",
      sourceId: randomUUID(),
    });
    expect(captured).toMatchObject({
      rail: "sim",
      status: "COMPLETED",
      captureStatus: "COMPLETED",
      amountCents: 1500n,
      recovered: false,
    });

    expect((await rail.getCheckout({ worldId, orderId: created.orderId })).status).toBe("COMPLETED");
  });

  it("the same purpose/sourceId resolves to the same order", async () => {
    const rail = simRail(db);
    const p = params();
    const a = await rail.createCheckout(p);
    const b = await rail.createCheckout(p);
    expect(b).toEqual(a);
    const rows = await db.select().from(paypalOperations).where(eq(paypalOperations.worldId, worldId));
    expect(rows).toHaveLength(1);
  });

  it("throws a PayPalApiError-shaped ORDER_NOT_APPROVED for an unapproved capture", async () => {
    const rail = simRail(db);
    const created = await rail.createCheckout(params());
    await expect(
      rail.captureCheckout({
        worldId,
        orderId: created.orderId,
        purpose: "note_purchase_capture",
        sourceId: randomUUID(),
      }),
    ).rejects.toMatchObject({ name: "ORDER_NOT_APPROVED", status: 422 });
  });

  it("rejects a zero or negative amountCents before enqueuing anything", async () => {
    const rail = simRail(db);
    await expect(rail.createCheckout({ ...params(), amountCents: 0n })).rejects.toBeInstanceOf(
      InvalidAmountError,
    );
    await expect(
      rail.sendPayout({
        worldId,
        receiver: "a@example.com",
        receiverType: "EMAIL",
        amountCents: -1n,
        senderItemId: "x",
        purpose: "loan_disbursement",
        sourceId: "x",
      }),
    ).rejects.toBeInstanceOf(InvalidAmountError);
    const rows = await db.select().from(paypalOperations).where(eq(paypalOperations.worldId, worldId));
    expect(rows).toHaveLength(0);
  });

  it("refuses to re-approve: ORDER_ALREADY_APPROVED, then ORDER_ALREADY_CAPTURED after capture", async () => {
    const rail = simRail(db);
    const created = await rail.createCheckout(params());
    await rail.simApprove(created.orderId);
    await expect(rail.simApprove(created.orderId)).rejects.toMatchObject({
      name: "ORDER_ALREADY_APPROVED",
    });

    const captureParams = {
      worldId,
      orderId: created.orderId,
      purpose: "note_purchase_capture" as const,
      sourceId: randomUUID(),
    };
    const first = await rail.captureCheckout(captureParams);
    await expect(rail.simApprove(created.orderId)).rejects.toMatchObject({
      name: "ORDER_ALREADY_CAPTURED",
    });
    // approve → capture → approve → capture can't double-capture.
    const again = await rail.captureCheckout({ ...captureParams, sourceId: randomUUID() });
    expect(again.captureId).toBe(first.captureId);
    expect(again.recovered).toBe(true);
  });

  it("simApprove on an unknown order throws SimRailError", async () => {
    await expect(simRail(db).simApprove("SIMORDER-unknown")).rejects.toBeInstanceOf(SimRailError);
  });

  it("sendPayout / getPayout round-trip, with a failing receiver reported on the item", async () => {
    const rail = simRail(db);
    const sent = await rail.sendPayout({
      worldId,
      receiver: "fail@example.com",
      receiverType: "EMAIL",
      amountCents: 100n,
      senderItemId: "s1",
      purpose: "note_redemption",
      sourceId: "n1",
    });
    expect(sent.item?.transactionStatus).toBe("FAILED");
    const got = await rail.getPayout({ worldId, batchId: sent.batchId });
    expect(got.items).toEqual([{ itemId: sent.item?.itemId, transactionStatus: "FAILED" }]);
  });

  it("refuses to reuse a purpose/sourceId across kinds", async () => {
    const rail = simRail(db);
    await rail.createCheckout({ ...params(), purpose: "note_purchase", sourceId: "same" });
    await expect(
      rail.sendPayout({
        worldId,
        receiver: "a@example.com",
        receiverType: "EMAIL",
        amountCents: 100n,
        senderItemId: "x",
        purpose: "note_purchase",
        sourceId: "same",
      }),
    ).rejects.toMatchObject({ name: "PayPalOperationReuseError" });
  });
});
