import { randomUUID } from "crypto";

import { beforeEach, describe, expect, it } from "vitest";

import type { Db } from "@/server/db/client";
import { worlds } from "@/server/db/schema";
import { createTestDb } from "@/server/db/testing";
import { InvalidAmountError } from "@/server/paypal/orders";
import { simRail, SimRailError } from "@/server/rail/simRail";

describe("simRail", () => {
  let db: Db;
  let worldId: string;

  beforeEach(async () => {
    db = await createTestDb();
    const [world] = await db
      .insert(worlds)
      .values({ slug: `world-${randomUUID()}`, name: "World", railMode: "sim" })
      .returning();
    if (!world) {
      throw new Error("expected a world to be inserted");
    }
    worldId = world.id;
  });

  it("creates, approves, and captures a checkout as COMPLETED", async () => {
    const rail = simRail(db);

    const created = await rail.createCheckout({
      worldId,
      amountCents: 1500n,
      description: "test checkout",
      customId: "custom-1",
      returnUrl: "https://example.com/return",
      cancelUrl: "https://example.com/cancel",
    });
    expect(created.rail).toBe("sim");
    expect(created.status).toBe("PAYER_ACTION_REQUIRED");
    expect(created.approveUrl).toContain(created.orderId);

    await rail.simApprove(created.orderId);

    const captured = await rail.captureCheckout({
      worldId,
      orderId: created.orderId,
    });
    expect(captured.rail).toBe("sim");
    expect(captured.status).toBe("COMPLETED");
    expect(captured.captureStatus).toBe("COMPLETED");
    expect(captured.amountCents).toBe(1500n);
    expect(captured.captureId).toBeTruthy();

    const fetched = await rail.getCheckout({ worldId, orderId: created.orderId });
    expect(fetched.status).toBe("COMPLETED");
  });

  it("refuses to capture a checkout that was never approved, with a PayPalApiError-shaped ORDER_NOT_APPROVED", async () => {
    const rail = simRail(db);
    const created = await rail.createCheckout({
      worldId,
      amountCents: 500n,
      description: "unapproved",
      customId: "custom-2",
      returnUrl: "https://example.com/return",
      cancelUrl: "https://example.com/cancel",
    });

    await expect(
      rail.captureCheckout({ worldId, orderId: created.orderId }),
    ).rejects.toMatchObject({
      name: "ORDER_NOT_APPROVED",
      status: 422,
    });
  });

  it("reuses the same order when createCheckout is called twice with the same operationId", async () => {
    const rail = simRail(db);
    const operationId = randomUUID();
    const params = {
      worldId,
      amountCents: 500n,
      description: "idempotent create",
      customId: "custom-idem",
      returnUrl: "https://example.com/return",
      cancelUrl: "https://example.com/cancel",
      operationId,
    };

    const first = await rail.createCheckout(params);
    const second = await rail.createCheckout(params);

    expect(second.orderId).toBe(first.orderId);
    expect(second.operationId).toBe(first.operationId);
  });

  it("rejects a zero or negative amountCents", async () => {
    const rail = simRail(db);
    await expect(
      rail.createCheckout({
        worldId,
        amountCents: 0n,
        description: "zero",
        customId: "custom-zero",
        returnUrl: "https://example.com/return",
        cancelUrl: "https://example.com/cancel",
      }),
    ).rejects.toBeInstanceOf(InvalidAmountError);

    await expect(
      rail.sendPayout({
        worldId,
        receiver: "ok@example.com",
        receiverType: "EMAIL",
        amountCents: -100n,
        senderItemId: "item-negative",
      }),
    ).rejects.toBeInstanceOf(InvalidAmountError);
  });

  it("succeeds a payout to a receiver without 'fail' in it", async () => {
    const rail = simRail(db);
    const result = await rail.sendPayout({
      worldId,
      receiver: "ok@example.com",
      receiverType: "EMAIL",
      amountCents: 500n,
      senderItemId: "item-1",
    });

    expect(result.rail).toBe("sim");
    expect(result.batchStatus).toBe("SUCCESS");

    const fetched = await rail.getPayout({ worldId, batchId: result.batchId });
    expect(fetched.batchStatus).toBe("SUCCESS");
    expect(fetched.items[0]?.transactionStatus).toBe("SUCCESS");
  });

  it("fails a payout to a receiver containing 'fail'", async () => {
    const rail = simRail(db);
    const result = await rail.sendPayout({
      worldId,
      receiver: "fail@example.com",
      receiverType: "EMAIL",
      amountCents: 500n,
      senderItemId: "item-2",
    });

    expect(result.batchStatus).toBe("FAILED");

    const fetched = await rail.getPayout({ worldId, batchId: result.batchId });
    expect(fetched.items[0]?.transactionStatus).toBe("FAILED");
  });

  it("refuses to capture an already-COMPLETED order with ORDER_ALREADY_CAPTURED", async () => {
    const rail = simRail(db);
    const created = await rail.createCheckout({
      worldId,
      amountCents: 500n,
      description: "double capture",
      customId: "custom-double",
      returnUrl: "https://example.com/return",
      cancelUrl: "https://example.com/cancel",
    });
    await rail.simApprove(created.orderId);
    await rail.captureCheckout({ worldId, orderId: created.orderId });

    await expect(
      rail.captureCheckout({ worldId, orderId: created.orderId }),
    ).rejects.toMatchObject({
      name: "ORDER_ALREADY_CAPTURED",
      status: 422,
    });
  });

  it("lets exactly one of two concurrent captures of the same order win, the other rejecting with ORDER_ALREADY_CAPTURED", async () => {
    const rail = simRail(db);
    const created = await rail.createCheckout({
      worldId,
      amountCents: 500n,
      description: "concurrent capture",
      customId: "custom-concurrent",
      returnUrl: "https://example.com/return",
      cancelUrl: "https://example.com/cancel",
    });
    await rail.simApprove(created.orderId);

    const outcomes = await Promise.allSettled([
      rail.captureCheckout({ worldId, orderId: created.orderId }),
      rail.captureCheckout({ worldId, orderId: created.orderId }),
    ]);

    const fulfilled = outcomes.filter((o) => o.status === "fulfilled");
    const rejected = outcomes.filter((o) => o.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const rejection = rejected[0] as PromiseRejectedResult;
    expect(rejection.reason).toMatchObject({
      name: "ORDER_ALREADY_CAPTURED",
      status: 422,
    });

    const fetched = await rail.getCheckout({ worldId, orderId: created.orderId });
    expect(fetched.status).toBe("COMPLETED");
  });

  it("refuses to reuse an operationId across a different kind (createCheckout vs sendPayout)", async () => {
    const operationId = randomUUID();
    const rail = simRail(db);

    await rail.createCheckout({
      worldId,
      amountCents: 500n,
      description: "kind check",
      customId: "custom-kind",
      returnUrl: "https://example.com/return",
      cancelUrl: "https://example.com/cancel",
      operationId,
    });

    await expect(
      rail.sendPayout({
        worldId,
        receiver: "ok@example.com",
        receiverType: "EMAIL",
        amountCents: 500n,
        senderItemId: "item-kind",
        operationId,
      }),
    ).rejects.toBeInstanceOf(SimRailError);
  });

  it("uses the caller-supplied operationId as the payout's own id, and reuses it on a retry", async () => {
    const rail = simRail(db);
    const operationId = randomUUID();
    const params = {
      worldId,
      receiver: "ok@example.com",
      receiverType: "EMAIL" as const,
      amountCents: 500n,
      senderItemId: "item-reuse",
      operationId,
    };

    const first = await rail.sendPayout(params);
    const second = await rail.sendPayout(params);

    expect(first.operationId).toBe(operationId);
    expect(second.batchId).toBe(first.batchId);
    expect(second.operationId).toBe(first.operationId);
  });
});
