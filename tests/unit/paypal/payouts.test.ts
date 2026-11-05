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
import * as payouts from "@/server/paypal/payouts";
import { __resetTokenCacheForTests } from "@/server/paypal/token";

const BASE_URL = "https://api-m.paypal.test";
const server = setupServer();

beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("payouts.send", () => {
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

  it("uses a generated operationId as both PayPal-Request-Id and sender_batch_id when none is supplied", async () => {
    let capturedRequestId: string | null = null;
    let capturedSenderBatchId: string | undefined;

    server.use(
      http.post(`${BASE_URL}/v1/payments/payouts`, async ({ request }) => {
        capturedRequestId = request.headers.get("PayPal-Request-Id");
        const body = (await request.json()) as {
          sender_batch_header: { sender_batch_id: string };
        };
        capturedSenderBatchId = body.sender_batch_header.sender_batch_id;
        return HttpResponse.json({
          batch_header: {
            payout_batch_id: "BATCH-1",
            batch_status: "SUCCESS",
          },
        });
      }),
    );

    const result = await payouts.send(db, {
      worldId,
      receiver: "ok@example.com",
      receiverType: "EMAIL",
      amountCents: 500n,
      senderItemId: "item-1",
    });

    expect(capturedRequestId).toBe(result.operationId);
    expect(capturedSenderBatchId).toBe(result.operationId);
  });

  it("uses a caller-supplied operationId as both PayPal-Request-Id and sender_batch_id", async () => {
    let capturedRequestId: string | null = null;
    let capturedSenderBatchId: string | undefined;

    server.use(
      http.post(`${BASE_URL}/v1/payments/payouts`, async ({ request }) => {
        capturedRequestId = request.headers.get("PayPal-Request-Id");
        const body = (await request.json()) as {
          sender_batch_header: { sender_batch_id: string };
        };
        capturedSenderBatchId = body.sender_batch_header.sender_batch_id;
        return HttpResponse.json({
          batch_header: {
            payout_batch_id: "BATCH-2",
            batch_status: "SUCCESS",
          },
        });
      }),
    );

    const operationId = randomUUID();
    const result = await payouts.send(db, {
      worldId,
      receiver: "ok@example.com",
      receiverType: "EMAIL",
      amountCents: 500n,
      senderItemId: "item-2",
      operationId,
    });

    expect(result.operationId).toBe(operationId);
    expect(capturedRequestId).toBe(operationId);
    expect(capturedSenderBatchId).toBe(operationId);
  });

  it("replays the original batch on a retried call with the same operationId, without sending money twice", async () => {
    let callCount = 0;
    server.use(
      http.post(`${BASE_URL}/v1/payments/payouts`, () => {
        callCount += 1;
        return HttpResponse.json({
          batch_header: {
            payout_batch_id: "BATCH-3",
            batch_status: "SUCCESS",
          },
        });
      }),
    );

    const operationId = randomUUID();
    const params = {
      worldId,
      receiver: "ok@example.com",
      receiverType: "EMAIL" as const,
      amountCents: 500n,
      senderItemId: "item-3",
      operationId,
    };

    const first = await payouts.send(db, params);
    const second = await payouts.send(db, params);

    expect(callCount).toBe(1);
    expect(second.batchId).toBe(first.batchId);
  });

  it("rejects a zero/negative amountCents before any request is sent", async () => {
    let called = false;
    server.use(
      http.post(`${BASE_URL}/v1/payments/payouts`, () => {
        called = true;
        return HttpResponse.json({
          batch_header: { payout_batch_id: "x", batch_status: "SUCCESS" },
        });
      }),
    );

    await expect(
      payouts.send(db, {
        worldId,
        receiver: "ok@example.com",
        receiverType: "EMAIL",
        amountCents: 0n,
        senderItemId: "item-4",
      }),
    ).rejects.toThrow();
    expect(called).toBe(false);
  });
});
