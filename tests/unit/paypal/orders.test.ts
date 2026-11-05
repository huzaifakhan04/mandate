import { randomUUID } from "crypto";

import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import type { Db } from "@/server/db/client";
import { worlds } from "@/server/db/schema";
import { createTestDb } from "@/server/db/testing";
import * as orders from "@/server/paypal/orders";
import { __resetTokenCacheForTests } from "@/server/paypal/token";

const BASE_URL = "https://api-m.paypal.test";
const server = setupServer();

beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("orders", () => {
  let db: Db;
  let worldId: string;

  beforeEach(async () => {
    process.env.PAYPAL_BASE_URL = BASE_URL;
    process.env.PAYPAL_CLIENT_ID = "test-client-id";
    process.env.PAYPAL_CLIENT_SECRET = "test-client-secret-value";
    __resetTokenCacheForTests();

    server.use(
      http.post(`${BASE_URL}/v1/oauth2/token`, () =>
        HttpResponse.json({
          access_token: `token-${randomUUID()}`,
          expires_in: 32400,
        }),
      ),
    );

    db = await createTestDb();
    const [world] = await db
      .insert(worlds)
      .values({ slug: `world-${randomUUID()}`, name: "World", railMode: "paypal" })
      .returning();
    if (!world) {
      throw new Error("expected a world to be inserted");
    }
    worldId = world.id;
  });

  const createParams = () => ({
    worldId,
    amountCents: 100n,
    description: "test",
    customId: "custom-1",
    returnUrl: "https://example.com/return",
    cancelUrl: "https://example.com/cancel",
  });

  it("throws if the create response has no approve/payer-action link", async () => {
    server.use(
      http.post(`${BASE_URL}/v2/checkout/orders`, () =>
        HttpResponse.json({ id: "ORDER-1", status: "CREATED", links: [] }),
      ),
    );

    await expect(orders.create(db, createParams())).rejects.toThrow(
      /approve\/payer-action/,
    );
  });

  it("rejects a zero/negative amountCents before any request is sent", async () => {
    let called = false;
    server.use(
      http.post(`${BASE_URL}/v2/checkout/orders`, () => {
        called = true;
        return HttpResponse.json({ id: "x", status: "CREATED" });
      }),
    );

    await expect(
      orders.create(db, { ...createParams(), amountCents: 0n }),
    ).rejects.toBeInstanceOf(orders.InvalidAmountError);
    expect(called).toBe(false);
  });

  it("returns captureStatus distinct from the order status, with a real captureId/amountCents", async () => {
    server.use(
      http.post(`${BASE_URL}/v2/checkout/orders/ORDER-2/capture`, () =>
        HttpResponse.json({
          id: "ORDER-2",
          status: "COMPLETED",
          purchase_units: [
            {
              payments: {
                captures: [
                  { id: "CAPTURE-1", status: "COMPLETED", amount: { value: "1.00" } },
                ],
              },
            },
          ],
        }),
      ),
    );

    const result = await orders.capture(db, { worldId, orderId: "ORDER-2" });
    expect(result.status).toBe("COMPLETED");
    expect(result.captureStatus).toBe("COMPLETED");
    expect(result.captureId).toBe("CAPTURE-1");
    expect(result.amountCents).toBe(100n);
  });

  it("throws if the capture response has no capture record", async () => {
    server.use(
      http.post(`${BASE_URL}/v2/checkout/orders/ORDER-3/capture`, () =>
        HttpResponse.json({ id: "ORDER-3", status: "VOIDED" }),
      ),
    );

    await expect(
      orders.capture(db, { worldId, orderId: "ORDER-3" }),
    ).rejects.toThrow(/no capture record/);
  });

  it("URL-encodes the orderId when building capture/get paths", async () => {
    let capturedUrl: string | undefined;
    server.use(
      http.post(`${BASE_URL}/v2/checkout/orders/:orderId/capture`, ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json({
          id: "ORDER with spaces",
          status: "COMPLETED",
          purchase_units: [
            {
              payments: {
                captures: [
                  { id: "CAPTURE-2", status: "COMPLETED", amount: { value: "1.00" } },
                ],
              },
            },
          ],
        });
      }),
    );

    await orders.capture(db, { worldId, orderId: "ORDER with spaces" });
    expect(capturedUrl).toContain("ORDER%20with%20spaces");
  });
});
