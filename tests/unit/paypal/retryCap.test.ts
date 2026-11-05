import { randomUUID } from "crypto";

import { eq, sql } from "drizzle-orm";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Db } from "@/server/db/client";
import { paypalOperations, worlds } from "@/server/db/schema";
import { createTestDb } from "@/server/db/testing";
import { __resetBackoffMsForTests, __setBackoffMsForTests } from "@/server/paypal/fetch";
import {
  buildCancelPayoutItemRequest,
  buildGetOrderRequest,
  enqueueOperation,
  enqueueReadOperation,
  executeOperation,
} from "@/server/paypal/operations";
import { __resetTokenCacheForTests } from "@/server/paypal/token";

/**
 * Task 10b (Ruling U): a money-moving operation that keeps failing
 * retryably (the sandbox answered `payouts-item/{id}/cancel` with 500
 * every time) is given up on — `failed_terminal` with
 * `retry_cap_exceeded` — once it has made ≥ 20 attempts or was enqueued
 * more than 24 h ago. Reads (`order.get` / `payout.get`) are never capped.
 */

const BASE_URL = "https://api-m.paypal.test";
const server = setupServer();

beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
beforeAll(() => __setBackoffMsForTests([0, 0]));
afterAll(() => __resetBackoffMsForTests());

async function row(db: Db, id: string) {
  const [found] = await db.select().from(paypalOperations).where(eq(paypalOperations.id, id));
  return found!;
}

describe("retry cap for money-moving operations", () => {
  let db: Db;
  let worldId: string;
  let cancelCalls: number;

  beforeAll(async () => {
    db = await createTestDb();
  });

  beforeEach(async () => {
    process.env.PAYPAL_BASE_URL = BASE_URL;
    process.env.PAYPAL_CLIENT_ID = "test-client-id";
    process.env.PAYPAL_CLIENT_SECRET = "test-client-secret-value";
    __resetTokenCacheForTests();
    cancelCalls = 0;
    server.use(
      http.post(`${BASE_URL}/v1/oauth2/token`, () =>
        HttpResponse.json({ access_token: `token-${randomUUID()}`, expires_in: 32400 }),
      ),
      http.post(`${BASE_URL}/v1/payments/payouts-item/:itemId/cancel`, () => {
        cancelCalls += 1;
        return HttpResponse.json({ name: "INTERNAL_SERVER_ERROR", message: "boom" }, { status: 500 });
      }),
      http.get(`${BASE_URL}/v2/checkout/orders/:orderId`, () =>
        HttpResponse.json({ name: "INTERNAL_SERVER_ERROR" }, { status: 500 }),
      ),
    );
    const [world] = await db
      .insert(worlds)
      .values({ slug: `world-${randomUUID()}`, name: "World", railMode: "paypal" })
      .returning();
    worldId = world!.id;
  });

  function enqueueCancel(itemId = `ITEM-${randomUUID()}`) {
    return enqueueOperation(db, {
      worldId,
      rail: "paypal",
      kind: "payout.cancel_item",
      purpose: "payout_cancel",
      sourceId: itemId,
      request: buildCancelPayoutItemRequest(itemId),
    });
  }

  it("below the cap a 5xx stays failed_retryable", async () => {
    const { operationId } = await enqueueCancel();
    await db.update(paypalOperations).set({ attempts: 10 }).where(eq(paypalOperations.id, operationId));

    const result = await executeOperation(db, operationId, { ignoreBackoff: true });

    expect(result.status).toBe("failed_retryable");
    expect((await row(db, operationId)).attempts).toBe(13);
  });

  it("reaching 20 attempts → failed_terminal with retry_cap_exceeded (original error kept)", async () => {
    const { operationId } = await enqueueCancel();
    // One run = 3 inline HTTP attempts: 17 + 3 = 20.
    await db.update(paypalOperations).set({ attempts: 17 }).where(eq(paypalOperations.id, operationId));

    const result = await executeOperation(db, operationId, { ignoreBackoff: true });

    expect(result.status).toBe("failed_terminal");
    expect(result.httpStatus).toBe(500);
    expect(result.body).toMatchObject({
      error: { name: "INTERNAL_SERVER_ERROR", issue: "retry_cap_exceeded", details: { reason: "retry_cap_exceeded", attempts: 20 } },
    });
    const stored = await row(db, operationId);
    expect(stored).toMatchObject({ status: "failed_terminal", attempts: 20, lastError: "retry_cap_exceeded", nextAttemptAt: null });

    // Terminal: never sent again.
    const callsBefore = cancelCalls;
    await executeOperation(db, operationId, { ignoreBackoff: true });
    expect(cancelCalls).toBe(callsBefore);
  });

  it("first enqueued more than 24 h ago → failed_terminal on the next failure, whatever the count", async () => {
    const { operationId } = await enqueueCancel();
    await db
      .update(paypalOperations)
      .set({ createdAt: sql`now() - interval '25 hours'` })
      .where(eq(paypalOperations.id, operationId));

    const result = await executeOperation(db, operationId, { ignoreBackoff: true });

    expect(result.status).toBe("failed_terminal");
    expect(result.body).toMatchObject({ error: { issue: "retry_cap_exceeded" } });
    expect((await row(db, operationId)).attempts).toBe(3);
  });

  it("a definite 4xx is still plain failed_terminal (not a cap)", async () => {
    server.use(
      http.post(`${BASE_URL}/v1/payments/payouts-item/:itemId/cancel`, () =>
        HttpResponse.json({ name: "UNPROCESSABLE_ENTITY", details: [{ issue: "ITEM_CANNOT_BE_CANCELLED" }] }, { status: 422 }),
      ),
    );
    const { operationId } = await enqueueCancel();
    await db.update(paypalOperations).set({ attempts: 30 }).where(eq(paypalOperations.id, operationId));

    const result = await executeOperation(db, operationId, { ignoreBackoff: true });

    expect(result.status).toBe("failed_terminal");
    expect((await row(db, operationId)).lastError).toBe("ITEM_CANNOT_BE_CANCELLED");
  });

  it("reads are never capped", async () => {
    const { operationId } = await enqueueReadOperation(db, {
      worldId,
      rail: "paypal",
      kind: "order.get",
      request: buildGetOrderRequest("ORDER-READ"),
    });
    await db
      .update(paypalOperations)
      .set({ attempts: 40, createdAt: sql`now() - interval '3 days'` })
      .where(eq(paypalOperations.id, operationId));

    const result = await executeOperation(db, operationId, { ignoreBackoff: true });

    expect(result.status).toBe("failed_retryable");
  });
});
