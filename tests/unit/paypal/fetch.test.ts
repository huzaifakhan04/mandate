import { randomUUID } from "crypto";

import { eq } from "drizzle-orm";
import { delay, http, HttpResponse } from "msw";
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
  PayPalApiError,
  PayPalOperationReuseError,
  paypalFetch,
} from "@/server/paypal/fetch";
import { __resetTokenCacheForTests } from "@/server/paypal/token";

const BASE_URL = "https://api-m.paypal.test";

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

// None of the tests in this file assert on the *duration* of a retry
// backoff, only on call counts/request ids/final state — so the real
// 300ms/900ms delays (compounding across several retry tests) are
// replaced with 0ms for the whole file.
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

describe("paypalFetch", () => {
  // One PGlite instance (with migrations applied) for the whole file,
  // not one per test — `createTestDb()` is otherwise the dominant cost
  // of running this suite. Every table except `worlds`/`principals` is
  // world-scoped (Global Constraints), and every test below creates its
  // own fresh world with a random slug, so sharing the underlying db is
  // safe: nothing here reads/writes across worlds.
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

  it("refreshes the token once on 401 and retries with the same PayPal-Request-Id", async () => {
    let callCount = 0;
    const seenRequestIds = new Set<string | null>();

    server.use(
      http.post(`${BASE_URL}/v2/checkout/orders`, ({ request }) => {
        callCount += 1;
        seenRequestIds.add(request.headers.get("PayPal-Request-Id"));
        if (callCount === 1) {
          return HttpResponse.json(
            { name: "AUTHENTICATION_FAILURE" },
            { status: 401 },
          );
        }
        return HttpResponse.json({ id: "ORDER-1", status: "CREATED" });
      }),
    );

    const result = await paypalFetch<{ id: string; status: string }>(db, {
      worldId,
      kind: "order.create",
      method: "POST",
      path: "/v2/checkout/orders",
      body: { intent: "CAPTURE" },
    });

    expect(callCount).toBe(2);
    expect(seenRequestIds.size).toBe(1);
    expect(result.status).toBe(200);
    expect(result.body.id).toBe("ORDER-1");

    const row = await readOperation(db, result.operationId);
    expect(row.attempts).toBe(2);
    expect(row.requestId).toBe(result.operationId);
    expect(row.status).toBe("succeeded");
  });

  it("retries up to 2 times on repeated 503s with the same request id, then succeeds", async () => {
    let callCount = 0;
    const seenRequestIds = new Set<string | null>();

    server.use(
      http.post(`${BASE_URL}/v2/checkout/orders`, ({ request }) => {
        callCount += 1;
        seenRequestIds.add(request.headers.get("PayPal-Request-Id"));
        if (callCount < 3) {
          return HttpResponse.json(
            { name: "INTERNAL_SERVER_ERROR" },
            { status: 503 },
          );
        }
        return HttpResponse.json({ id: "ORDER-2", status: "CREATED" });
      }),
    );

    const result = await paypalFetch<{ id: string; status: string }>(db, {
      worldId,
      kind: "order.create",
      method: "POST",
      path: "/v2/checkout/orders",
      body: { intent: "CAPTURE" },
    });

    expect(callCount).toBe(3);
    expect(seenRequestIds.size).toBe(1);

    const row = await readOperation(db, result.operationId);
    expect(row.attempts).toBe(3);
  });

  it("fails after exactly 3 calls on three consecutive 5xx responses, all with the same PayPal-Request-Id, row status 'failed'", async () => {
    let callCount = 0;
    const seenRequestIds = new Set<string | null>();

    server.use(
      http.post(`${BASE_URL}/v2/checkout/orders`, ({ request }) => {
        callCount += 1;
        seenRequestIds.add(request.headers.get("PayPal-Request-Id"));
        return HttpResponse.json(
          { name: "INTERNAL_SERVER_ERROR" },
          { status: 503 },
        );
      }),
    );

    let caught: unknown;
    try {
      await paypalFetch(db, {
        worldId,
        kind: "order.create",
        method: "POST",
        path: "/v2/checkout/orders",
        body: { intent: "CAPTURE" },
      });
      expect.unreachable("expected paypalFetch to throw");
    } catch (err) {
      caught = err;
    }

    expect(callCount).toBe(3);
    expect(seenRequestIds.size).toBe(1);
    expect(caught).toBeInstanceOf(PayPalApiError);
    expect(caught).toMatchObject({ name: "INTERNAL_SERVER_ERROR", status: 503 });

    const [requestId] = seenRequestIds;
    const row = await readOperation(db, requestId as string);
    expect(row.attempts).toBe(3);
    expect(row.status).toBe("failed_retryable");
    expect(row.nextAttemptAt).not.toBeNull();
  });

  it("throws PayPalApiError with the PayPal error name on a final non-2xx response", async () => {
    server.use(
      http.post(`${BASE_URL}/v2/checkout/orders`, () =>
        HttpResponse.json(
          { name: "UNPROCESSABLE_ENTITY", message: "bad request", debug_id: "abc123" },
          { status: 422 },
        ),
      ),
    );

    await expect(
      paypalFetch(db, {
        worldId,
        kind: "order.create",
        method: "POST",
        path: "/v2/checkout/orders",
        body: { intent: "CAPTURE" },
      }),
    ).rejects.toMatchObject({
      name: "UNPROCESSABLE_ENTITY",
      status: 422,
      debugId: "abc123",
    });
  });

  it("stores the request redacted, with no Authorization header value or secret", async () => {
    server.use(
      http.post(`${BASE_URL}/v2/checkout/orders`, () =>
        HttpResponse.json({ id: "ORDER-3", status: "CREATED" }),
      ),
    );

    const result = await paypalFetch<{ id: string; status: string }>(db, {
      worldId,
      kind: "order.create",
      method: "POST",
      path: "/v2/checkout/orders",
      body: {
        intent: "CAPTURE",
        metadata: { clientSecret: "super-secret-value" },
      },
    });

    const row = await readOperation(db, result.operationId);
    const serializedRequest = JSON.stringify(row.request);

    expect(serializedRequest).not.toContain("super-secret-value");
    expect(serializedRequest).not.toMatch(/Bearer\s+[\w.-]+/);
    expect(serializedRequest).not.toContain("Authorization");
  });

  it("retries a network error with the same request id, then succeeds", async () => {
    let callCount = 0;
    const seenRequestIds = new Set<string | null>();

    server.use(
      http.post(`${BASE_URL}/v2/checkout/orders`, ({ request }) => {
        callCount += 1;
        seenRequestIds.add(request.headers.get("PayPal-Request-Id"));
        if (callCount === 1) {
          return HttpResponse.error();
        }
        return HttpResponse.json({ id: "ORDER-4", status: "CREATED" });
      }),
    );

    const result = await paypalFetch<{ id: string; status: string }>(db, {
      worldId,
      kind: "order.create",
      method: "POST",
      path: "/v2/checkout/orders",
      body: { intent: "CAPTURE" },
    });

    expect(callCount).toBe(2);
    expect(seenRequestIds.size).toBe(1);
    expect(result.body.id).toBe("ORDER-4");

    const row = await readOperation(db, result.operationId);
    expect(row.attempts).toBe(2);
    expect(row.status).toBe("succeeded");
  });

  it("makes exactly 1 call for a final 422 (no retry on a 4xx)", async () => {
    let callCount = 0;

    server.use(
      http.post(`${BASE_URL}/v2/checkout/orders`, () => {
        callCount += 1;
        return HttpResponse.json({ name: "UNPROCESSABLE_ENTITY" }, { status: 422 });
      }),
    );

    await expect(
      paypalFetch(db, {
        worldId,
        kind: "order.create",
        method: "POST",
        path: "/v2/checkout/orders",
        body: { intent: "CAPTURE" },
      }),
    ).rejects.toBeInstanceOf(PayPalApiError);

    expect(callCount).toBe(1);
  });

  it("throws after exactly 2 calls when a second 401 follows the refresh", async () => {
    let callCount = 0;
    const seenRequestIds = new Set<string | null>();

    server.use(
      http.post(`${BASE_URL}/v2/checkout/orders`, ({ request }) => {
        callCount += 1;
        seenRequestIds.add(request.headers.get("PayPal-Request-Id"));
        return HttpResponse.json({ name: "AUTHENTICATION_FAILURE" }, { status: 401 });
      }),
    );

    await expect(
      paypalFetch(db, {
        worldId,
        kind: "order.create",
        method: "POST",
        path: "/v2/checkout/orders",
        body: { intent: "CAPTURE" },
      }),
    ).rejects.toMatchObject({ status: 401 });

    expect(callCount).toBe(2);
    expect(seenRequestIds.size).toBe(1);
  });

  it("retries a timed-out request (abort) with the same request id, then succeeds", async () => {
    process.env.PAYPAL_TIMEOUT_MS = "50";
    let callCount = 0;
    const seenRequestIds = new Set<string | null>();

    server.use(
      http.post(`${BASE_URL}/v2/checkout/orders`, async ({ request }) => {
        callCount += 1;
        seenRequestIds.add(request.headers.get("PayPal-Request-Id"));
        if (callCount === 1) {
          await delay(300);
        }
        return HttpResponse.json({ id: "ORDER-5", status: "CREATED" });
      }),
    );

    try {
      const result = await paypalFetch<{ id: string; status: string }>(db, {
        worldId,
        kind: "order.create",
        method: "POST",
        path: "/v2/checkout/orders",
        body: { intent: "CAPTURE" },
      });

      expect(callCount).toBe(2);
      expect(seenRequestIds.size).toBe(1);
      expect(result.body.id).toBe("ORDER-5");
    } finally {
      delete process.env.PAYPAL_TIMEOUT_MS;
    }
  }, 10_000);

  it("never leaves a row 'pending': a config error before any request still writes a terminal status", async () => {
    delete process.env.PAYPAL_CLIENT_ID;
    delete process.env.PAYPAL_CLIENT_SECRET;

    let operationId: string | undefined;
    try {
      await paypalFetch(db, {
        worldId,
        kind: "order.create",
        method: "POST",
        path: "/v2/checkout/orders",
        body: { intent: "CAPTURE" },
      });
      expect.unreachable("expected paypalFetch to throw");
    } catch {
      // Find the row this call created — paypalConfig() throws before we
      // ever get an operationId back from paypalFetch itself.
      const rows = await db
        .select()
        .from(paypalOperations)
        .where(eq(paypalOperations.worldId, worldId));
      const created = rows.find((row) => row.kind === "order.create");
      operationId = created?.id;
    } finally {
      process.env.PAYPAL_CLIENT_ID = "test-client-id";
      process.env.PAYPAL_CLIENT_SECRET = "test-client-secret-value";
    }

    expect(operationId).toBeTruthy();
    const row = await readOperation(db, operationId as string);
    expect(row.status).not.toBe("queued");
    expect(row.status).not.toBe("in_flight");
    expect(row.status).toBe("failed_terminal");
  });

  it("replays a reused operationId's stored result without calling PayPal again, once it already succeeded", async () => {
    let callCount = 0;
    server.use(
      http.post(`${BASE_URL}/v2/checkout/orders`, () => {
        callCount += 1;
        return HttpResponse.json({ id: "ORDER-6", status: "CREATED" });
      }),
    );

    const operationId = randomUUID();
    const op = {
      worldId,
      kind: "order.create",
      method: "POST" as const,
      path: "/v2/checkout/orders",
      body: { intent: "CAPTURE" },
      operationId,
    };

    const first = await paypalFetch<{ id: string; status: string }>(db, op);
    const second = await paypalFetch<{ id: string; status: string }>(db, op);

    expect(callCount).toBe(1);
    expect(second.operationId).toBe(first.operationId);
    expect(second.body.id).toBe("ORDER-6");
  });

  it("refuses to reuse an operationId that belongs to a different world", async () => {
    const [otherWorld] = await db
      .insert(worlds)
      .values({ slug: `world-${randomUUID()}`, name: "Other", railMode: "paypal" })
      .returning();
    if (!otherWorld) {
      throw new Error("expected a second world to be inserted");
    }

    server.use(
      http.post(`${BASE_URL}/v2/checkout/orders`, () =>
        HttpResponse.json({ id: "ORDER-7", status: "CREATED" }),
      ),
    );

    const operationId = randomUUID();
    await paypalFetch(db, {
      worldId,
      kind: "order.create",
      method: "POST",
      path: "/v2/checkout/orders",
      body: { intent: "CAPTURE" },
      operationId,
    });

    await expect(
      paypalFetch(db, {
        worldId: otherWorld.id,
        kind: "order.create",
        method: "POST",
        path: "/v2/checkout/orders",
        body: { intent: "CAPTURE" },
        operationId,
      }),
    ).rejects.toThrow();
  });

  it("refuses to reuse an operationId across a different kind, without calling PayPal", async () => {
    server.use(
      http.post(`${BASE_URL}/v2/checkout/orders`, () =>
        HttpResponse.json({ id: "ORDER-8", status: "CREATED" }),
      ),
    );

    let payoutCallCount = 0;
    server.use(
      http.post(`${BASE_URL}/v1/payments/payouts`, () => {
        payoutCallCount += 1;
        return HttpResponse.json({
          batch_header: { payout_batch_id: "BATCH-1", batch_status: "SUCCESS" },
        });
      }),
    );

    const operationId = randomUUID();
    await paypalFetch(db, {
      worldId,
      kind: "order.create",
      method: "POST",
      path: "/v2/checkout/orders",
      body: { intent: "CAPTURE" },
      operationId,
    });

    await expect(
      paypalFetch(db, {
        worldId,
        kind: "payout.send",
        method: "POST",
        path: "/v1/payments/payouts",
        body: { sender_batch_header: { sender_batch_id: operationId } },
        operationId,
      }),
    ).rejects.toBeInstanceOf(PayPalOperationReuseError);

    expect(payoutCallCount).toBe(0);
  });

  it("never downgrades a 'succeeded' row when a losing concurrent attempt for the same operationId fails", async () => {
    // Two logical calls share the same operationId/kind/worldId (a real
    // concurrent retry), but are routed to different paths purely so this
    // test can make each lane's outcome deterministic regardless of which
    // one's HTTP request actually goes out first.
    server.use(
      http.post(`${BASE_URL}/v2/checkout/orders/lane-a`, () =>
        HttpResponse.json({ id: "ORDER-9", status: "CREATED" }),
      ),
      http.post(`${BASE_URL}/v2/checkout/orders/lane-b`, () =>
        HttpResponse.json({ name: "INTERNAL_SERVER_ERROR" }, { status: 500 }),
      ),
    );

    const operationId = randomUUID();
    const [laneAResult] = await Promise.all([
      paypalFetch<{ id: string; status: string }>(db, {
        worldId,
        kind: "order.create",
        method: "POST",
        path: "/v2/checkout/orders/lane-a",
        body: { intent: "CAPTURE" },
        operationId,
      }),
      paypalFetch(db, {
        worldId,
        kind: "order.create",
        method: "POST",
        path: "/v2/checkout/orders/lane-b",
        body: { intent: "CAPTURE" },
        operationId,
      }).catch(() => undefined),
    ]);

    expect(laneAResult.body.id).toBe("ORDER-9");

    const row = await readOperation(db, operationId);
    expect(row.status).toBe("succeeded");
    expect(row.httpStatus).toBe(200);
  }, 10_000);

  it("retries an OAuth token failure within the same budget, then succeeds", async () => {
    let tokenCallCount = 0;
    server.use(
      http.post(`${BASE_URL}/v1/oauth2/token`, () => {
        tokenCallCount += 1;
        if (tokenCallCount < 2) {
          return HttpResponse.text("oauth down", { status: 500 });
        }
        return HttpResponse.json({
          access_token: `token-${randomUUID()}`,
          expires_in: 32400,
        });
      }),
    );

    let orderCallCount = 0;
    server.use(
      http.post(`${BASE_URL}/v2/checkout/orders`, () => {
        orderCallCount += 1;
        return HttpResponse.json({ id: "ORDER-10", status: "CREATED" });
      }),
    );

    const result = await paypalFetch<{ id: string; status: string }>(db, {
      worldId,
      kind: "order.create",
      method: "POST",
      path: "/v2/checkout/orders",
      body: { intent: "CAPTURE" },
    });

    expect(tokenCallCount).toBe(2);
    expect(orderCallCount).toBe(1);
    expect(result.body.id).toBe("ORDER-10");

    const row = await readOperation(db, result.operationId);
    expect(row.status).toBe("succeeded");
  });

  it("surfaces an exhausted OAuth failure as PayPalApiError{status:0, name:'PayPalNetworkError'} with the OAuth status in details", async () => {
    server.use(
      http.post(`${BASE_URL}/v1/oauth2/token`, () =>
        HttpResponse.text("oauth totally down", { status: 503 }),
      ),
    );

    let orderCallCount = 0;
    server.use(
      http.post(`${BASE_URL}/v2/checkout/orders`, () => {
        orderCallCount += 1;
        return HttpResponse.json({ id: "ORDER-11", status: "CREATED" });
      }),
    );

    let caught: unknown;
    try {
      await paypalFetch(db, {
        worldId,
        kind: "order.create",
        method: "POST",
        path: "/v2/checkout/orders",
        body: { intent: "CAPTURE" },
      });
      expect.unreachable("expected paypalFetch to throw");
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(PayPalApiError);
    const error = caught as PayPalApiError;
    expect(error.status).toBe(0);
    expect(error.name).toBe("PayPalNetworkError");
    expect(error.details).toMatchObject({ stage: "oauth", oauthStatus: 503 });
    // The actual order endpoint must never have been reached.
    expect(orderCallCount).toBe(0);
  }, 10_000);
});
