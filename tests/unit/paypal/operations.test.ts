import { randomUUID } from "crypto";

import { eq } from "drizzle-orm";
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
import { paypalOperations, worlds } from "@/server/db/schema";
import { createTestDb } from "@/server/db/testing";
import {
  __resetBackoffMsForTests,
  __setBackoffMsForTests,
} from "@/server/paypal/fetch";
import { deriveOperationId, journalKey } from "@/server/paypal/operationId";
import {
  enqueueOperation,
  executeOperation,
  PayPalOperationReuseError,
} from "@/server/paypal/operations";
import { __resetTokenCacheForTests } from "@/server/paypal/token";

const BASE_URL = "https://api-m.paypal.test";
const server = setupServer();

beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

beforeAll(() => __setBackoffMsForTests([0, 0]));
afterAll(() => __resetBackoffMsForTests());

async function readOperation(db: Db, id: string) {
  const [row] = await db
    .select()
    .from(paypalOperations)
    .where(eq(paypalOperations.id, id));
  if (!row) {
    throw new Error(`expected a paypal_operations row for ${id}`);
  }
  return row;
}

describe("deriveOperationId / journalKey", () => {
  it("is stable for the same inputs", () => {
    const a = deriveOperationId("world-1", "note_purchase", "note-1");
    const b = deriveOperationId("world-1", "note_purchase", "note-1");
    expect(a).toBe(b);
  });

  it("is distinct per purpose for the same worldId/sourceId", () => {
    const purchase = deriveOperationId("world-1", "note_purchase", "note-1");
    const redemption = deriveOperationId("world-1", "note_redemption", "note-1");
    expect(purchase).not.toBe(redemption);
  });

  it("is distinct per sourceId for the same worldId/purpose", () => {
    const a = deriveOperationId("world-1", "note_purchase", "note-1");
    const b = deriveOperationId("world-1", "note_purchase", "note-2");
    expect(a).not.toBe(b);
  });

  it("is distinct per worldId for the same purpose/sourceId", () => {
    const a = deriveOperationId("world-1", "note_purchase", "note-1");
    const b = deriveOperationId("world-2", "note_purchase", "note-1");
    expect(a).not.toBe(b);
  });

  it("is a well-formed UUIDv5 (version nibble 5, RFC 4122 variant)", () => {
    const id = deriveOperationId("world-1", "note_purchase", "note-1");
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("journalKey is '<purpose>:<sourceId>'", () => {
    expect(journalKey("loan_disbursement", "loan-1")).toBe(
      "loan_disbursement:loan-1",
    );
  });
});

describe("enqueueOperation / executeOperation", () => {
  let db: Db;
  let worldId: string;

  beforeAll(async () => {
    db = await createTestDb();
  });

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

    const [world] = await db
      .insert(worlds)
      .values({ slug: `world-${randomUUID()}`, name: "World", railMode: "paypal" })
      .returning();
    if (!world) {
      throw new Error("expected a world to be inserted");
    }
    worldId = world.id;
  });

  it("enqueuing the same logical operation twice resolves to the same row", async () => {
    const first = await enqueueOperation(db, {
      worldId,
      rail: "paypal",
      kind: "order.create",
      purpose: "note_purchase",
      sourceId: "note-1",
      request: { method: "POST", path: "/v2/checkout/orders", body: { intent: "CAPTURE" } },
    });
    const second = await enqueueOperation(db, {
      worldId,
      rail: "paypal",
      kind: "order.create",
      purpose: "note_purchase",
      sourceId: "note-1",
      request: { method: "POST", path: "/v2/checkout/orders", body: { intent: "CAPTURE" } },
    });

    expect(second.operationId).toBe(first.operationId);

    const rows = await db
      .select()
      .from(paypalOperations)
      .where(eq(paypalOperations.id, first.operationId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("queued");
  });

  it("enqueuing a derived id for a different rail/kind throws PayPalOperationReuseError", async () => {
    await enqueueOperation(db, {
      worldId,
      rail: "paypal",
      kind: "order.create",
      purpose: "note_purchase",
      sourceId: "note-reuse",
      request: { method: "POST", path: "/v2/checkout/orders", body: {} },
    });

    await expect(
      enqueueOperation(db, {
        worldId,
        rail: "paypal",
        kind: "payout.send",
        purpose: "note_purchase",
        sourceId: "note-reuse",
        request: { method: "POST", path: "/v1/payments/payouts", body: {} },
      }),
    ).rejects.toBeInstanceOf(PayPalOperationReuseError);
  });

  it("executes a queued operation: 200 -> succeeded, and a second execute makes no new HTTP call", async () => {
    let callCount = 0;
    server.use(
      http.post(`${BASE_URL}/v2/checkout/orders`, () => {
        callCount += 1;
        return HttpResponse.json({ id: "ORDER-OPS-1", status: "CREATED" });
      }),
    );

    const { operationId } = await enqueueOperation(db, {
      worldId,
      rail: "paypal",
      kind: "order.create",
      purpose: "note_purchase",
      sourceId: "note-exec-1",
      request: { method: "POST", path: "/v2/checkout/orders", body: { intent: "CAPTURE" } },
    });

    const first = await executeOperation(db, operationId);
    expect(first.status).toBe("succeeded");
    expect(first.httpStatus).toBe(200);
    expect(callCount).toBe(1);

    const second = await executeOperation(db, operationId);
    expect(second.status).toBe("succeeded");
    expect(callCount).toBe(1);

    const row = await readOperation(db, operationId);
    expect(row.status).toBe("succeeded");
  });

  it("a 503 leaves the row failed_retryable with next_attempt_at set, then executing again later succeeds with the same PayPal-Request-Id", async () => {
    let callCount = 0;
    const seenRequestIds = new Set<string | null>();

    server.use(
      http.post(`${BASE_URL}/v2/checkout/orders`, ({ request }) => {
        callCount += 1;
        seenRequestIds.add(request.headers.get("PayPal-Request-Id"));
        if (callCount <= 3) {
          return HttpResponse.json({ name: "INTERNAL_SERVER_ERROR" }, { status: 503 });
        }
        return HttpResponse.json({ id: "ORDER-OPS-2", status: "CREATED" });
      }),
    );

    const { operationId } = await enqueueOperation(db, {
      worldId,
      rail: "paypal",
      kind: "order.create",
      purpose: "note_purchase",
      sourceId: "note-exec-2",
      request: { method: "POST", path: "/v2/checkout/orders", body: { intent: "CAPTURE" } },
    });

    const firstResult = await executeOperation(db, operationId);
    expect(firstResult.status).toBe("failed_retryable");
    // paypalFetch's own 3-attempt inline retry budget is exhausted here.
    expect(callCount).toBe(3);

    const rowAfterFailure = await readOperation(db, operationId);
    expect(rowAfterFailure.status).toBe("failed_retryable");
    expect(rowAfterFailure.nextAttemptAt).not.toBeNull();

    // Simulate the reconcile cron retrying later: directly clear
    // claimed_at the way a stale claim would naturally expire, and let
    // this next call's own inline attempt succeed.
    const secondResult = await executeOperation(db, operationId);
    expect(secondResult.status).toBe("succeeded");

    expect(seenRequestIds.size).toBe(1);
    const [requestId] = seenRequestIds;
    expect(requestId).toBe(operationId);
  });

  it("a 422 (non-capture) leaves the row failed_terminal", async () => {
    server.use(
      http.post(`${BASE_URL}/v2/checkout/orders`, () =>
        HttpResponse.json({ name: "UNPROCESSABLE_ENTITY" }, { status: 422 }),
      ),
    );

    const { operationId } = await enqueueOperation(db, {
      worldId,
      rail: "paypal",
      kind: "order.create",
      purpose: "note_purchase",
      sourceId: "note-exec-3",
      request: { method: "POST", path: "/v2/checkout/orders", body: { intent: "CAPTURE" } },
    });

    const result = await executeOperation(db, operationId);
    expect(result.status).toBe("failed_terminal");

    const row = await readOperation(db, operationId);
    expect(row.status).toBe("failed_terminal");
  });

  it("two concurrent executeOperation calls for the same operation make exactly 1 HTTP call", async () => {
    let callCount = 0;
    server.use(
      http.post(`${BASE_URL}/v2/checkout/orders`, async () => {
        callCount += 1;
        return HttpResponse.json({ id: "ORDER-OPS-4", status: "CREATED" });
      }),
    );

    const { operationId } = await enqueueOperation(db, {
      worldId,
      rail: "paypal",
      kind: "order.create",
      purpose: "note_purchase",
      sourceId: "note-exec-4",
      request: { method: "POST", path: "/v2/checkout/orders", body: { intent: "CAPTURE" } },
    });

    const [a, b] = await Promise.all([
      executeOperation(db, operationId),
      executeOperation(db, operationId),
    ]);

    expect(callCount).toBe(1);
    const outcomes = [a.status, b.status];
    expect(outcomes).toContain("succeeded");
  });

  it("capture after ORDER_ALREADY_CAPTURED succeeds with the capture fetched via GET", async () => {
    let captureCallCount = 0;
    server.use(
      http.post(`${BASE_URL}/v2/checkout/orders/ORDER-ALREADY/capture`, () => {
        captureCallCount += 1;
        return HttpResponse.json(
          { name: "ORDER_ALREADY_CAPTURED" },
          { status: 422 },
        );
      }),
      http.get(`${BASE_URL}/v2/checkout/orders/ORDER-ALREADY`, () =>
        HttpResponse.json({
          id: "ORDER-ALREADY",
          status: "COMPLETED",
          purchase_units: [
            {
              payments: {
                captures: [
                  { id: "CAPTURE-ALREADY", status: "COMPLETED", amount: { value: "5.00" } },
                ],
              },
            },
          ],
        }),
      ),
    );

    const { operationId } = await enqueueOperation(db, {
      worldId,
      rail: "paypal",
      kind: "order.capture",
      purpose: "note_purchase_capture",
      sourceId: "note-capture-1",
      request: {
        method: "POST",
        path: "/v2/checkout/orders/ORDER-ALREADY/capture",
      },
    });

    const result = await executeOperation(db, operationId);
    expect(result.status).toBe("succeeded");
    expect(result.httpStatus).toBe(200);
    expect(captureCallCount).toBe(1);
    expect(result.body).toMatchObject({
      captureId: "CAPTURE-ALREADY",
      captureStatus: "COMPLETED",
      amountCents: 500n,
    });

    const row = await readOperation(db, operationId);
    expect(row.status).toBe("succeeded");

    // Idempotent: executing again replays without calling PayPal again.
    const replay = await executeOperation(db, operationId);
    expect(replay.status).toBe("succeeded");
    expect(captureCallCount).toBe(1);
  });

  it("executes a queued sim-rail operation deterministically, without any HTTP call", async () => {
    const { operationId } = await enqueueOperation(db, {
      worldId,
      rail: "sim",
      kind: "order.create",
      purpose: "note_purchase",
      sourceId: "note-sim-1",
      request: { method: "POST", path: "/v2/checkout/orders", body: { amountCents: "100" } },
    });

    const result = await executeOperation(db, operationId);
    expect(result.status).toBe("succeeded");

    const row = await readOperation(db, operationId);
    expect(row.rail).toBe("sim");
    expect(row.status).toBe("succeeded");
  });
});
