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
import { PayPalApiError, paypalFetch } from "@/server/paypal/fetch";
import { __resetTokenCacheForTests } from "@/server/paypal/token";

const BASE_URL = "https://api-m.paypal.test";

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

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
  }, 10_000);

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
    expect(row.status).not.toBe("pending");
    expect(row.status).toBe("failed");
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
});
