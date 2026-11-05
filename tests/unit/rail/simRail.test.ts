import { randomUUID } from "crypto";

import { beforeEach, describe, expect, it } from "vitest";

import type { Db } from "@/server/db/client";
import { worlds } from "@/server/db/schema";
import { createTestDb } from "@/server/db/testing";
import { simRail } from "@/server/rail/simRail";

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
    expect(created.status).toBe("CREATED");

    rail.simApprove(created.orderId);

    const captured = await rail.captureCheckout({
      worldId,
      orderId: created.orderId,
    });
    expect(captured.rail).toBe("sim");
    expect(captured.status).toBe("COMPLETED");
    expect(captured.amountCents).toBe(1500n);
  });

  it("refuses to capture a checkout that was never approved", async () => {
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
    ).rejects.toThrow();
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
  });
});
