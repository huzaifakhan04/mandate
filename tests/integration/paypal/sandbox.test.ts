import { randomUUID } from "crypto";

import { beforeAll, describe, expect, it } from "vitest";

import type { Db } from "@/server/db/client";
import { worlds } from "@/server/db/schema";
import { createTestDb } from "@/server/db/testing";
import { paypalRail } from "@/server/rail/paypalRail";
import { getAccessToken } from "@/server/paypal/token";

// Only runs when real sandbox credentials are present in the environment
// (PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET). Otherwise this whole suite is
// skipped — see global-constraints.md: "unit tests run without network or
// secrets."
describe.skipIf(!process.env.PAYPAL_CLIENT_ID)("PayPal sandbox integration", () => {
  let db: Db;
  let worldId: string;

  beforeAll(async () => {
    db = await createTestDb();
    const [world] = await db
      .insert(worlds)
      .values({
        slug: `world-sandbox-${randomUUID()}`,
        name: "Sandbox World",
        railMode: "paypal",
      })
      .returning();
    if (!world) {
      throw new Error("expected a world to be inserted");
    }
    worldId = world.id;
  });

  it("gets a sandbox access token", async () => {
    const token = await getAccessToken();
    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(0);
  });

  it("creates a $1.00 order and reads it back", async () => {
    const rail = paypalRail(db);
    const created = await rail.createCheckout({
      worldId,
      purpose: "note_purchase",
      sourceId: `sandbox-smoke-${randomUUID()}`,
      amountCents: 100n,
      description: "Sandbox smoke test",
      customId: "sandbox-smoke",
      returnUrl: "https://example.com/return",
      cancelUrl: "https://example.com/cancel",
    });

    expect(created.approveUrl).toContain("sandbox.paypal.com");
    // With `payment_source.paypal.experience_context` set, PayPal may
    // return the order either as a plain CREATED order or already
    // waiting on payer action — both are valid outcomes here.
    expect(["CREATED", "PAYER_ACTION_REQUIRED"]).toContain(created.status);

    const fetched = await rail.getCheckout({
      worldId,
      orderId: created.orderId,
    });
    expect(["CREATED", "PAYER_ACTION_REQUIRED"]).toContain(fetched.status);
  }, 30_000);
});
