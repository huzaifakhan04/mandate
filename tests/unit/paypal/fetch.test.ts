import { randomUUID } from "crypto";

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

import { PayPalConfigError } from "@/server/paypal/config";
import {
  __resetBackoffMsForTests,
  __setBackoffMsForTests,
  PayPalNetworkError,
  paypalFetch,
} from "@/server/paypal/fetch";
import { __resetTokenCacheForTests } from "@/server/paypal/token";

const BASE_URL = "https://api-m.paypal.test";

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

// No test here asserts on backoff *duration* — only call counts, request
// ids and outcomes — so the real 300ms/900ms delays are zeroed.
beforeAll(() => __setBackoffMsForTests([0, 0]));
afterAll(() => __resetBackoffMsForTests());

function orderRequest(requestId = randomUUID()) {
  return {
    method: "POST" as const,
    path: "/v2/checkout/orders",
    body: { intent: "CAPTURE" },
    requestId,
  };
}

describe("paypalFetch (pure HTTP client — writes no rows)", () => {
  beforeEach(() => {
    process.env.PAYPAL_BASE_URL = BASE_URL;
    process.env.PAYPAL_CLIENT_ID = "test-client-id";
    process.env.PAYPAL_CLIENT_SECRET = "test-client-secret-value";
    __resetTokenCacheForTests();

    server.use(
      http.post(`${BASE_URL}/v1/oauth2/token`, () =>
        HttpResponse.json({ access_token: `token-${randomUUID()}`, expires_in: 32400 }),
      ),
    );
  });

  it("sends the caller's requestId as PayPal-Request-Id and returns the response", async () => {
    let seen: string | null = null;
    server.use(
      http.post(`${BASE_URL}/v2/checkout/orders`, ({ request }) => {
        seen = request.headers.get("PayPal-Request-Id");
        return HttpResponse.json({ id: "ORDER-1", status: "CREATED" }, { status: 201 });
      }),
    );

    const requestId = randomUUID();
    const result = await paypalFetch(orderRequest(requestId));

    expect(seen).toBe(requestId);
    expect(result).toMatchObject({ httpStatus: 201, body: { id: "ORDER-1" }, attempts: 1 });
  });

  it("refreshes the token once on 401 and retries with the same PayPal-Request-Id", async () => {
    let callCount = 0;
    const seenRequestIds = new Set<string | null>();
    server.use(
      http.post(`${BASE_URL}/v2/checkout/orders`, ({ request }) => {
        callCount += 1;
        seenRequestIds.add(request.headers.get("PayPal-Request-Id"));
        return callCount === 1
          ? HttpResponse.json({ name: "AUTHENTICATION_FAILURE" }, { status: 401 })
          : HttpResponse.json({ id: "ORDER-1", status: "CREATED" });
      }),
    );

    const result = await paypalFetch(orderRequest());

    expect(callCount).toBe(2);
    expect(seenRequestIds.size).toBe(1);
    expect(result).toMatchObject({ httpStatus: 200, attempts: 2 });
  });

  it("returns (does not throw) a second 401 after the refresh", async () => {
    let callCount = 0;
    server.use(
      http.post(`${BASE_URL}/v2/checkout/orders`, () => {
        callCount += 1;
        return HttpResponse.json({ name: "AUTHENTICATION_FAILURE" }, { status: 401 });
      }),
    );

    const result = await paypalFetch(orderRequest());
    expect(callCount).toBe(2);
    expect(result.httpStatus).toBe(401);
  });

  it("retries up to 2 times on 503 with the same request id, then succeeds", async () => {
    let callCount = 0;
    const seenRequestIds = new Set<string | null>();
    server.use(
      http.post(`${BASE_URL}/v2/checkout/orders`, ({ request }) => {
        callCount += 1;
        seenRequestIds.add(request.headers.get("PayPal-Request-Id"));
        return callCount < 3
          ? HttpResponse.json({ name: "INTERNAL_SERVER_ERROR" }, { status: 503 })
          : HttpResponse.json({ id: "ORDER-2", status: "CREATED" });
      }),
    );

    const result = await paypalFetch(orderRequest());
    expect(callCount).toBe(3);
    expect(seenRequestIds.size).toBe(1);
    expect(result).toMatchObject({ httpStatus: 200, attempts: 3 });
  });

  it("returns the final 5xx after exactly 3 calls", async () => {
    let callCount = 0;
    server.use(
      http.post(`${BASE_URL}/v2/checkout/orders`, () => {
        callCount += 1;
        return HttpResponse.json({ name: "INTERNAL_SERVER_ERROR" }, { status: 503 });
      }),
    );

    const result = await paypalFetch(orderRequest());
    expect(callCount).toBe(3);
    expect(result).toMatchObject({
      httpStatus: 503,
      body: { name: "INTERNAL_SERVER_ERROR" },
      attempts: 3,
    });
  });

  it("makes exactly 1 call for a 422 and returns it", async () => {
    let callCount = 0;
    server.use(
      http.post(`${BASE_URL}/v2/checkout/orders`, () => {
        callCount += 1;
        return HttpResponse.json(
          { name: "UNPROCESSABLE_ENTITY", debug_id: "abc123" },
          { status: 422 },
        );
      }),
    );

    const result = await paypalFetch(orderRequest());
    expect(callCount).toBe(1);
    expect(result).toMatchObject({ httpStatus: 422, body: { debug_id: "abc123" }, attempts: 1 });
  });

  it("retries a network error with the same request id, then succeeds", async () => {
    let callCount = 0;
    const seenRequestIds = new Set<string | null>();
    server.use(
      http.post(`${BASE_URL}/v2/checkout/orders`, ({ request }) => {
        callCount += 1;
        seenRequestIds.add(request.headers.get("PayPal-Request-Id"));
        return callCount === 1
          ? HttpResponse.error()
          : HttpResponse.json({ id: "ORDER-4", status: "CREATED" });
      }),
    );

    const result = await paypalFetch(orderRequest());
    expect(callCount).toBe(2);
    expect(seenRequestIds.size).toBe(1);
    expect(result).toMatchObject({ httpStatus: 200, attempts: 2 });
  });

  it("throws PayPalNetworkError carrying attempts=3 when every attempt is a network error", async () => {
    server.use(http.post(`${BASE_URL}/v2/checkout/orders`, () => HttpResponse.error()));

    const caught = await paypalFetch(orderRequest()).catch((err: unknown) => err);
    expect(caught).toBeInstanceOf(PayPalNetworkError);
    expect(caught).toMatchObject({ attempts: 3, details: { stage: "request" } });
  });

  it("retries a timed-out request with the same request id, then succeeds", async () => {
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
      const result = await paypalFetch(orderRequest());
      expect(callCount).toBe(2);
      expect(seenRequestIds.size).toBe(1);
      expect(result.httpStatus).toBe(200);
    } finally {
      delete process.env.PAYPAL_TIMEOUT_MS;
    }
  }, 10_000);

  it("retries an OAuth token failure within the same budget, then succeeds", async () => {
    let tokenCallCount = 0;
    server.use(
      http.post(`${BASE_URL}/v1/oauth2/token`, () => {
        tokenCallCount += 1;
        return tokenCallCount < 2
          ? HttpResponse.text("oauth down", { status: 500 })
          : HttpResponse.json({ access_token: `token-${randomUUID()}`, expires_in: 32400 });
      }),
    );
    let orderCallCount = 0;
    server.use(
      http.post(`${BASE_URL}/v2/checkout/orders`, () => {
        orderCallCount += 1;
        return HttpResponse.json({ id: "ORDER-10", status: "CREATED" });
      }),
    );

    const result = await paypalFetch(orderRequest());
    expect(tokenCallCount).toBe(2);
    expect(orderCallCount).toBe(1);
    expect(result.httpStatus).toBe(200);
  });

  it("surfaces an exhausted OAuth failure as PayPalNetworkError with the OAuth status in details", async () => {
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

    const caught = await paypalFetch(orderRequest()).catch((err: unknown) => err);
    expect(caught).toBeInstanceOf(PayPalNetworkError);
    expect(caught).toMatchObject({ attempts: 3, details: { stage: "oauth", oauthStatus: 503 } });
    expect(orderCallCount).toBe(0);
  }, 10_000);

  it("throws PayPalConfigError without sending anything when credentials are missing", async () => {
    delete process.env.PAYPAL_CLIENT_ID;
    delete process.env.PAYPAL_CLIENT_SECRET;
    try {
      await expect(paypalFetch(orderRequest())).rejects.toBeInstanceOf(PayPalConfigError);
    } finally {
      process.env.PAYPAL_CLIENT_ID = "test-client-id";
      process.env.PAYPAL_CLIENT_SECRET = "test-client-secret-value";
    }
  });
});
