import { randomUUID } from "crypto";

import { beforeAll, describe, expect, it } from "vitest";

import type { Db } from "@/server/db/client";
import { worlds } from "@/server/db/schema";
import { createTestDb } from "@/server/db/testing";
import * as orders from "@/server/paypal/orders";
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

  it("creates a $1.00 order and reads it back as CREATED", async () => {
    const created = await orders.create(db, {
      worldId,
      amountCents: 100n,
      description: "Sandbox smoke test",
      customId: "sandbox-smoke",
      returnUrl: "https://example.com/return",
      cancelUrl: "https://example.com/cancel",
    });

    expect(created.approveUrl).toContain("sandbox.paypal.com");
    expect(created.status).toBe("CREATED");

    const fetched = await orders.get(db, {
      worldId,
      orderId: created.orderId,
    });
    expect(fetched.status).toBe("CREATED");
  }, 30_000);
});
