import { randomUUID } from "crypto";

import { eq, sql } from "drizzle-orm";
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
import { __resetBackoffMsForTests, __setBackoffMsForTests } from "@/server/paypal/fetch";
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

// paypalFetch's *inline* retry delays (300ms/900ms between its own 3
// attempts) are zeroed; the operation-level backoff (next_attempt_at) is
// what these tests assert on, and it is unaffected by this hook.
beforeAll(() => __setBackoffMsForTests([0, 0]));
afterAll(() => __resetBackoffMsForTests());

async function readOperation(db: Db, id: string) {
  const [row] = await db.select().from(paypalOperations).where(eq(paypalOperations.id, id));
  if (!row) {
    throw new Error(`expected a paypal_operations row for ${id}`);
  }
  return row;
}

describe("deriveOperationId / journalKey", () => {
  it("is stable for the same inputs", () => {
    expect(deriveOperationId("world-1", "note_purchase", "note-1")).toBe(
      deriveOperationId("world-1", "note_purchase", "note-1"),
    );
  });

  it("is distinct per purpose, sourceId and worldId", () => {
    const base = deriveOperationId("world-1", "note_purchase", "note-1");
    expect(deriveOperationId("world-1", "note_redemption", "note-1")).not.toBe(base);
    expect(deriveOperationId("world-1", "note_purchase", "note-2")).not.toBe(base);
    expect(deriveOperationId("world-2", "note_purchase", "note-1")).not.toBe(base);
  });

  it("is a well-formed UUIDv5 (version nibble 5, RFC 4122 variant)", () => {
    expect(deriveOperationId("world-1", "note_purchase", "note-1")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("journalKey is '<purpose>:<sourceId>'", () => {
    expect(journalKey("loan_disbursement", "loan-1")).toBe("loan_disbursement:loan-1");
  });
});

describe("enqueueOperation / executeOperation (paypal rail)", () => {
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
        HttpResponse.json({ access_token: `token-${randomUUID()}`, expires_in: 32400 }),
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

  const ORDER_CREATED = {
    id: "ORDER-1",
    status: "PAYER_ACTION_REQUIRED",
    links: [{ rel: "payer-action", href: "https://paypal.test/approve?token=ORDER-1" }],
  };

  function enqueueCreate(sourceId = `note-${randomUUID()}`) {
    return enqueueOperation(db, {
      worldId,
      rail: "paypal",
      kind: "order.create",
      purpose: "note_purchase",
      sourceId,
      request: {
        method: "POST",
        path: "/v2/checkout/orders",
        body: { intent: "CAPTURE", purchase_units: [{ amount: { currency_code: "USD", value: "1.00" } }] },
      },
    });
  }

  function enqueueCapture(orderId: string) {
    return enqueueOperation(db, {
      worldId,
      rail: "paypal",
      kind: "order.capture",
      purpose: "note_purchase_capture",
      sourceId: `note-${randomUUID()}`,
      request: { method: "POST", path: `/v2/checkout/orders/${orderId}/capture` },
    });
  }

  /** Records the PayPal-Request-Id of every POST /v2/checkout/orders, answering with `respond(n)`. */
  function mockCreate(respond: (call: number) => Response) {
    const seen: (string | null)[] = [];
    server.use(
      http.post(`${BASE_URL}/v2/checkout/orders`, ({ request }) => {
        seen.push(request.headers.get("PayPal-Request-Id"));
        return respond(seen.length);
      }),
    );
    return seen;
  }

  it("enqueuing the same logical operation twice resolves to the same row", async () => {
    const first = await enqueueCreate("note-1");
    const second = await enqueueCreate("note-1");

    expect(second.operationId).toBe(first.operationId);
    expect(first.operationId).toBe(deriveOperationId(worldId, "note_purchase", "note-1"));
    const rows = await db
      .select()
      .from(paypalOperations)
      .where(eq(paypalOperations.id, first.operationId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "queued", purpose: "note_purchase", sourceId: "note-1" });
  });

  it("throws PayPalOperationReuseError when the derived id is reused for a different kind", async () => {
    await enqueueCreate("note-reuse");
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

  it("rejects a request whose method/path doesn't match its kind", async () => {
    await expect(
      enqueueOperation(db, {
        worldId,
        rail: "paypal",
        kind: "order.capture",
        purpose: "note_purchase_capture",
        sourceId: "x",
        request: { method: "POST", path: "/v1/payments/payouts" },
      }),
    ).rejects.toThrow(/does not match operation kind/);
  });

  it("200 → succeeded with the parsed result; a replay makes no HTTP call and returns the identical result", async () => {
    const seen = mockCreate(() => HttpResponse.json(ORDER_CREATED, { status: 201 }));
    const { operationId } = await enqueueCreate();

    const first = await executeOperation(db, operationId);
    const replay = await executeOperation(db, operationId);

    expect(seen).toEqual([operationId]);
    expect(first).toEqual({
      operationId,
      kind: "order.create",
      status: "succeeded",
      httpStatus: 201,
      body: {
        orderId: "ORDER-1",
        status: "PAYER_ACTION_REQUIRED",
        approveUrl: "https://paypal.test/approve?token=ORDER-1",
      },
    });
    expect(replay).toEqual(first);

    const row = await readOperation(db, operationId);
    expect(row.response).toEqual(first.body);
    expect(row).toMatchObject({ paypalId: "ORDER-1", attempts: 1, claimedAt: null });
  });

  it("503 → failed_retryable with cumulative backoff; not retried before next_attempt_at; then succeeds with the same PayPal-Request-Id and attempts accumulate", async () => {
    // paypalFetch makes 3 inline attempts per run, all 503 here; then 200.
    const seen = mockCreate((n) =>
      n <= 3
        ? HttpResponse.json({ name: "SERVICE_UNAVAILABLE" }, { status: 503 })
        : HttpResponse.json(ORDER_CREATED, { status: 201 }),
    );
    const { operationId } = await enqueueCreate();

    const before = Date.now();
    const failed = await executeOperation(db, operationId);
    expect(failed).toMatchObject({
      status: "failed_retryable",
      httpStatus: 503,
      body: { error: { name: "SERVICE_UNAVAILABLE" } },
    });
    let row = await readOperation(db, operationId);
    expect(row.attempts).toBe(3);
    expect(row.claimedAt).toBeNull();
    // 30s · 2^3 = 240s after the failure.
    const delayMs = (row.nextAttemptAt as Date).getTime() - before;
    expect(delayMs).toBeGreaterThanOrEqual(239_000);
    expect(delayMs).toBeLessThan(250_000);

    // Backoff not yet elapsed: no claim, no HTTP call, same result.
    expect(await executeOperation(db, operationId)).toEqual(failed);
    expect(seen).toHaveLength(3);

    // The reconcile cron runs again once the backoff has elapsed.
    await db
      .update(paypalOperations)
      .set({ nextAttemptAt: sql`now() - interval '1 second'` })
      .where(eq(paypalOperations.id, operationId));
    const retried = await executeOperation(db, operationId);

    expect(retried.status).toBe("succeeded");
    expect(seen).toHaveLength(4);
    expect(new Set(seen)).toEqual(new Set([operationId]));
    row = await readOperation(db, operationId);
    expect(row.attempts).toBe(4);
    expect(row.nextAttemptAt).toBeNull();
  });

  it("caps backoff at 10 minutes using the cumulative attempt count", async () => {
    mockCreate(() => HttpResponse.json({ name: "INTERNAL_SERVER_ERROR" }, { status: 500 }));
    const { operationId } = await enqueueCreate();

    await executeOperation(db, operationId);
    await executeOperation(db, operationId, { ignoreBackoff: true });

    const row = await readOperation(db, operationId);
    expect(row.attempts).toBe(6);
    const delayMs = (row.nextAttemptAt as Date).getTime() - Date.now();
    expect(delayMs).toBeGreaterThan(590_000);
    expect(delayMs).toBeLessThanOrEqual(600_000);
  });

  it("ignoreBackoff lets an inline caller retry a failed_retryable row immediately", async () => {
    const seen = mockCreate((n) =>
      n <= 3
        ? HttpResponse.json({ name: "INTERNAL_SERVER_ERROR" }, { status: 500 })
        : HttpResponse.json(ORDER_CREATED, { status: 201 }),
    );
    const { operationId } = await enqueueCreate();
    await executeOperation(db, operationId);

    const result = await executeOperation(db, operationId, { ignoreBackoff: true });
    expect(result.status).toBe("succeeded");
    expect(seen).toHaveLength(4);
  });

  it("a network error (no response) → failed_retryable with the attempts counted", async () => {
    mockCreate(() => HttpResponse.error());
    const { operationId } = await enqueueCreate();

    const result = await executeOperation(db, operationId);
    expect(result).toMatchObject({
      status: "failed_retryable",
      httpStatus: null,
      body: { error: { name: "PayPalNetworkError" } },
    });
    expect((await readOperation(db, operationId)).attempts).toBe(3);
  });

  it.each([409, 429])("%i → failed_retryable", async (status) => {
    mockCreate(() => HttpResponse.json({ name: "X" }, { status }));
    const { operationId } = await enqueueCreate();
    expect((await executeOperation(db, operationId)).status).toBe("failed_retryable");
  });

  it("422 → failed_terminal, with PayPal's issue recorded; never re-sent", async () => {
    const seen = mockCreate(() =>
      HttpResponse.json(
        { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "PAYEE_NOT_ENABLED" }], debug_id: "dbg" },
        { status: 422 },
      ),
    );
    const { operationId } = await enqueueCreate();

    const result = await executeOperation(db, operationId);
    expect(result).toMatchObject({
      status: "failed_terminal",
      httpStatus: 422,
      body: { error: { name: "UNPROCESSABLE_ENTITY", issue: "PAYEE_NOT_ENABLED", debugId: "dbg" } },
    });
    expect((await readOperation(db, operationId)).lastError).toBe("PAYEE_NOT_ENABLED");

    expect(await executeOperation(db, operationId, { ignoreBackoff: true })).toEqual(result);
    expect(seen).toHaveLength(1);
  });

  it("two concurrent executeOperation calls make exactly 1 HTTP call", async () => {
    const seen = mockCreate(() => HttpResponse.json(ORDER_CREATED, { status: 201 }));
    const { operationId } = await enqueueCreate();

    const [a, b] = await Promise.all([
      executeOperation(db, operationId),
      executeOperation(db, operationId),
    ]);

    expect(seen).toHaveLength(1);
    expect([a.status, b.status]).toContain("succeeded");
  });

  it("reclaims a stale in_flight row (worker died) and re-sends with the SAME PayPal-Request-Id", async () => {
    const seen = mockCreate(() => HttpResponse.json(ORDER_CREATED, { status: 201 }));
    const { operationId } = await enqueueCreate();
    await db
      .update(paypalOperations)
      .set({ status: "in_flight", claimedAt: sql`now() - interval '4 minutes'`, attempts: 1 })
      .where(eq(paypalOperations.id, operationId));

    const result = await executeOperation(db, operationId);

    expect(result.status).toBe("succeeded");
    expect(seen).toEqual([operationId]);
    const row = await readOperation(db, operationId);
    expect(row).toMatchObject({ requestId: operationId, attempts: 2, claimedAt: null });
  });

  it("does not reclaim an in_flight row inside the 3-minute stale window (a slow attempt may still be live)", async () => {
    const seen = mockCreate(() => HttpResponse.json(ORDER_CREATED, { status: 201 }));
    const { operationId } = await enqueueCreate();
    await db
      .update(paypalOperations)
      .set({ status: "in_flight", claimedAt: sql`now() - interval '150 seconds'` })
      .where(eq(paypalOperations.id, operationId));

    const result = await executeOperation(db, operationId);
    expect(result).toMatchObject({ status: "in_flight", body: null });
    expect(seen).toHaveLength(0);
  });

  it("never touches a succeeded or failed_terminal row", async () => {
    const seen = mockCreate(() => HttpResponse.json(ORDER_CREATED, { status: 201 }));
    for (const status of ["succeeded", "failed_terminal"] as const) {
      const { operationId } = await enqueueCreate();
      await db
        .update(paypalOperations)
        .set({ status, response: { marker: status } })
        .where(eq(paypalOperations.id, operationId));

      const result = await executeOperation(db, operationId, { ignoreBackoff: true });
      expect(result).toMatchObject({ status, body: { marker: status } });
    }
    expect(seen).toHaveLength(0);
  });

  it("ORDER_ALREADY_CAPTURED → GETs the order and succeeds with the existing capture; replay makes no HTTP call", async () => {
    let captureCalls = 0;
    let getCalls = 0;
    server.use(
      http.post(`${BASE_URL}/v2/checkout/orders/ORDER-9/capture`, () => {
        captureCalls += 1;
        return HttpResponse.json(
          { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "ORDER_ALREADY_CAPTURED" }] },
          { status: 422 },
        );
      }),
      http.get(`${BASE_URL}/v2/checkout/orders/ORDER-9`, () => {
        getCalls += 1;
        return HttpResponse.json({
          id: "ORDER-9",
          status: "COMPLETED",
          purchase_units: [
            { payments: { captures: [{ id: "CAP-9", status: "COMPLETED", amount: { value: "15.00" } }] } },
          ],
        });
      }),
    );
    const { operationId } = await enqueueCapture("ORDER-9");

    const result = await executeOperation(db, operationId);
    expect(result).toEqual({
      operationId,
      kind: "order.capture",
      status: "succeeded",
      httpStatus: 200,
      body: {
        orderId: "ORDER-9",
        status: "COMPLETED",
        captureId: "CAP-9",
        captureStatus: "COMPLETED",
        amountCents: "1500",
        recovered: true,
      },
    });
    expect(await executeOperation(db, operationId)).toEqual(result);
    expect(captureCalls).toBe(1);
    expect(getCalls).toBe(1);
    expect((await readOperation(db, operationId)).attempts).toBe(2);
  });

  it("ORDER_ALREADY_CAPTURED whose recovery GET fails → failed_retryable (never terminal)", async () => {
    server.use(
      http.post(`${BASE_URL}/v2/checkout/orders/ORDER-10/capture`, () =>
        HttpResponse.json(
          { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "ORDER_ALREADY_CAPTURED" }] },
          { status: 422 },
        ),
      ),
      http.get(`${BASE_URL}/v2/checkout/orders/ORDER-10`, () =>
        HttpResponse.json({ name: "SERVICE_UNAVAILABLE" }, { status: 503 }),
      ),
    );
    const { operationId } = await enqueueCapture("ORDER-10");

    const result = await executeOperation(db, operationId);
    expect(result).toMatchObject({
      status: "failed_retryable",
      body: { error: { issue: "ORDER_ALREADY_CAPTURED" } },
    });
    const row = await readOperation(db, operationId);
    expect(row.nextAttemptAt).not.toBeNull();
    expect(row.attempts).toBe(4); // 1 capture + 3 GET attempts
  });

  it("payout.send: sender_batch_id and PayPal-Request-Id are both the operation id", async () => {
    let requestId: string | null = null;
    let senderBatchId: unknown;
    server.use(
      http.post(`${BASE_URL}/v1/payments/payouts`, async ({ request }) => {
        requestId = request.headers.get("PayPal-Request-Id");
        const body = (await request.json()) as { sender_batch_header: { sender_batch_id: string } };
        senderBatchId = body.sender_batch_header.sender_batch_id;
        return HttpResponse.json(
          { batch_header: { payout_batch_id: "BATCH-1", batch_status: "PENDING" } },
          { status: 201 },
        );
      }),
    );
    const { operationId } = await enqueueOperation(db, {
      worldId,
      rail: "paypal",
      kind: "payout.send",
      purpose: "loan_disbursement",
      sourceId: "loan-1",
      request: {
        method: "POST",
        path: "/v1/payments/payouts",
        body: {
          sender_batch_header: {},
          items: [{ receiver: "a@example.com", amount: { value: "1.00", currency: "USD" } }],
        },
      },
    });

    const result = await executeOperation(db, operationId);
    expect(result.body).toEqual({ batchId: "BATCH-1", batchStatus: "PENDING", item: null });
    expect(requestId).toBe(operationId);
    expect(senderBatchId).toBe(operationId);
  });

  it("stores the request redacted, but keeps the executable request intact", async () => {
    const { operationId } = await enqueueOperation(db, {
      worldId,
      rail: "paypal",
      kind: "order.create",
      purpose: "note_purchase",
      sourceId: "redact-1",
      request: {
        method: "POST",
        path: "/v2/checkout/orders",
        body: { intent: "CAPTURE", purchase_units: [{ payee: { email_address: "bank@example.com" } }] },
      },
    });
    const row = await readOperation(db, operationId);
    expect(JSON.stringify(row.request)).not.toContain("bank@example.com");
    expect(JSON.stringify(row.executableRequest)).toContain("bank@example.com");
  });

  it("a config error (no credentials) → failed_retryable, nothing sent, row not left in_flight", async () => {
    const seen = mockCreate(() => HttpResponse.json(ORDER_CREATED, { status: 201 }));
    const { operationId } = await enqueueCreate();
    delete process.env.PAYPAL_CLIENT_ID;
    try {
      const result = await executeOperation(db, operationId);
      expect(result).toMatchObject({
        status: "failed_retryable",
        body: { error: { name: "PayPalConfigError" } },
      });
    } finally {
      process.env.PAYPAL_CLIENT_ID = "test-client-id";
    }
    expect(seen).toHaveLength(0);
  });
  it("order.capture answered 2xx with an unparseable body → recovers the capture via GET (never terminal)", async () => {
    server.use(
      http.post(`${BASE_URL}/v2/checkout/orders/ORDER-11/capture`, () =>
        HttpResponse.json({ id: "ORDER-11", status: "COMPLETED" }, { status: 201 }),
      ),
      http.get(`${BASE_URL}/v2/checkout/orders/ORDER-11`, () =>
        HttpResponse.json({
          id: "ORDER-11",
          status: "COMPLETED",
          purchase_units: [
            { payments: { captures: [{ id: "CAP-11", status: "COMPLETED", amount: { value: "2.50" } }] } },
          ],
        }),
      ),
    );
    const { operationId } = await enqueueCapture("ORDER-11");

    const result = await executeOperation(db, operationId);
    expect(result).toMatchObject({
      status: "succeeded",
      body: { captureId: "CAP-11", amountCents: "250", recovered: true },
    });
  });

  it("order.capture 2xx unparseable and the recovery GET fails → failed_retryable", async () => {
    server.use(
      http.post(`${BASE_URL}/v2/checkout/orders/ORDER-12/capture`, () =>
        HttpResponse.text("<html>gateway</html>", { status: 200 }),
      ),
      http.get(`${BASE_URL}/v2/checkout/orders/ORDER-12`, () => HttpResponse.error()),
    );
    const { operationId } = await enqueueCapture("ORDER-12");

    const result = await executeOperation(db, operationId);
    expect(result).toMatchObject({
      status: "failed_retryable",
      body: { error: { name: "RESPONSE_UNPARSEABLE" } },
    });
  });

  it("payout.send answered 2xx with an unparseable body → failed_retryable; the retry (same Request-Id) succeeds", async () => {
    const seen: (string | null)[] = [];
    server.use(
      http.post(`${BASE_URL}/v1/payments/payouts`, ({ request }) => {
        seen.push(request.headers.get("PayPal-Request-Id"));
        return seen.length === 1
          ? HttpResponse.json({ unexpected: true }, { status: 201 })
          : HttpResponse.json(
              { batch_header: { payout_batch_id: "BATCH-U", batch_status: "PENDING" } },
              { status: 201 },
            );
      }),
    );
    const { operationId } = await enqueueOperation(db, {
      worldId,
      rail: "paypal",
      kind: "payout.send",
      purpose: "note_redemption",
      sourceId: "note-unparseable",
      request: {
        method: "POST",
        path: "/v1/payments/payouts",
        body: { items: [{ receiver: "a@example.com", amount: { value: "1.00", currency: "USD" } }] },
      },
    });

    const first = await executeOperation(db, operationId);
    expect(first).toMatchObject({
      status: "failed_retryable",
      body: { error: { name: "RESPONSE_UNPARSEABLE" } },
    });
    const retried = await executeOperation(db, operationId, { ignoreBackoff: true });
    expect(retried).toMatchObject({ status: "succeeded", body: { batchId: "BATCH-U" } });
    expect(seen).toEqual([operationId, operationId]);
  });

  it("detects ORDER_ALREADY_CAPTURED in any details[] entry, not just the first", async () => {
    server.use(
      http.post(`${BASE_URL}/v2/checkout/orders/ORDER-13/capture`, () =>
        HttpResponse.json(
          {
            name: "UNPROCESSABLE_ENTITY",
            details: [{ issue: "SOMETHING_ELSE" }, { issue: "ORDER_ALREADY_CAPTURED" }],
          },
          { status: 422 },
        ),
      ),
      http.get(`${BASE_URL}/v2/checkout/orders/ORDER-13`, () =>
        HttpResponse.json({
          id: "ORDER-13",
          status: "COMPLETED",
          purchase_units: [
            { payments: { captures: [{ id: "CAP-13", status: "COMPLETED", amount: { value: "1.00" } }] } },
          ],
        }),
      ),
    );
    const { operationId } = await enqueueCapture("ORDER-13");

    const result = await executeOperation(db, operationId);
    expect(result).toMatchObject({ status: "succeeded", body: { captureId: "CAP-13", recovered: true } });
  });

  it("a failed run that sent nothing (config error) still counts 1 attempt, so backoff grows", async () => {
    mockCreate(() => HttpResponse.json(ORDER_CREATED, { status: 201 }));
    const { operationId } = await enqueueCreate();
    delete process.env.PAYPAL_CLIENT_ID;
    try {
      const delays: number[] = [];
      for (let run = 1; run <= 2; run += 1) {
        await executeOperation(db, operationId, { ignoreBackoff: true });
        const row = await readOperation(db, operationId);
        expect(row.attempts).toBe(run);
        delays.push((row.nextAttemptAt as Date).getTime() - Date.now());
      }
      // 30s·2^1 = 60s, then 30s·2^2 = 120s.
      expect(delays[0]).toBeGreaterThan(55_000);
      expect(delays[0]).toBeLessThanOrEqual(60_000);
      expect(delays[1]).toBeGreaterThan(115_000);
      expect(delays[1]).toBeLessThanOrEqual(120_000);
    } finally {
      process.env.PAYPAL_CLIENT_ID = "test-client-id";
    }
  });
});
