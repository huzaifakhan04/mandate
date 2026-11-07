import { randomUUID } from "crypto";

import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Db } from "@/server/db/client";
import { worlds } from "@/server/db/schema";
import { createTestDb } from "@/server/db/testing";
import { __resetBackoffMsForTests, __setBackoffMsForTests, PayPalNetworkError, paypalFetch } from "@/server/paypal/fetch";
import { enqueueOperation, executeOperation } from "@/server/paypal/operations";
import { buildCreateOrderRequest, parseGetOrderResponse } from "@/server/paypal/orders";
import type { WireOrder, WireOrderRequest } from "@/server/paypal/sdkTypes";
import { __resetTokenCacheForTests } from "@/server/paypal/token";

/**
 * Discrepancies found by the APIMatic Context Plugin audit
 * (docs/sponsors/apimatic-context-plugin-audit.md), each reproduced with
 * PayPal-shaped wire bodies (fixtures typed against the official SDK's
 * models via `Wire<T>`, so fixture rot is a compile error).
 */

const BASE_URL = "https://api-m.paypal.test";
const server = setupServer();

beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
beforeAll(() => __setBackoffMsForTests([0, 0]));
afterAll(() => __resetBackoffMsForTests());

function useCredentials() {
  process.env.PAYPAL_BASE_URL = BASE_URL;
  process.env.PAYPAL_CLIENT_ID = "test-client-id";
  process.env.PAYPAL_CLIENT_SECRET = "test-client-secret-value";
  __resetTokenCacheForTests();
}

const createParams = {
  amountCents: 1234n,
  description: "Mandate note",
  customId: "custom-1",
  returnUrl: "https://mandate.test/return",
  cancelUrl: "https://mandate.test/cancel",
};

describe("order.create body (SDK OrderRequest / PayPalWalletExperienceContext)", () => {
  it("is a valid WireOrderRequest with user_action PAY_NOW and shipping_preference NO_SHIPPING", () => {
    const body = buildCreateOrderRequest(createParams).body as WireOrderRequest;
    expect(body.payment_source?.paypal?.experience_context).toEqual({
      return_url: "https://mandate.test/return",
      cancel_url: "https://mandate.test/cancel",
      user_action: "PAY_NOW",
      shipping_preference: "NO_SHIPPING",
    });
  });

  it("lets an approve-only order (identity verification) keep PayPal's CONTINUE", () => {
    const body = buildCreateOrderRequest({ ...createParams, userAction: "CONTINUE" }).body as WireOrderRequest;
    expect(body.payment_source?.paypal?.experience_context?.user_action).toBe("CONTINUE");
  });

  it("sends no key nothing requires (plugin 1b.3): no payee unless given, no brand/locale/landing page", () => {
    const body = buildCreateOrderRequest(createParams).body as WireOrderRequest;
    expect(Object.keys(body).sort()).toEqual(["intent", "payment_source", "purchase_units"]);
    expect(Object.keys(body.purchase_units[0] ?? {}).sort()).toEqual(["amount", "custom_id", "description"]);
  });
});

describe("order.get payer (SDK: Order.payer is @deprecated → payment_source.paypal)", () => {
  it("reads payment_source.paypal (account_id / email_address / name) when PayPal sends only that", () => {
    const order: WireOrder = {
      id: "O",
      status: "APPROVED",
      payment_source: {
        paypal: {
          account_id: "PAYERID123",
          email_address: "buyer@example.com",
          name: { given_name: "Pat", surname: "Payer" },
        },
      },
    };
    expect(parseGetOrderResponse(order).payer).toEqual({
      payerId: "PAYERID123",
      email: "buyer@example.com",
      name: "Pat Payer",
    });
  });

  it("prefers payment_source.paypal over the legacy payer, field by field", () => {
    const order: WireOrder = {
      id: "O",
      status: "APPROVED",
      payment_source: { paypal: { account_id: "NEW", email_address: "new@example.com" } },
      payer: { payer_id: "OLD", email_address: "old@example.com", name: { given_name: "Legacy", surname: "Name" } },
    };
    expect(parseGetOrderResponse(order).payer).toEqual({
      payerId: "NEW",
      email: "new@example.com",
      name: "Legacy Name",
    });
  });

  it("still reads the legacy payer alone (what the sim rail and older responses send)", () => {
    const order: WireOrder = { id: "O", status: "APPROVED", payer: { payer_id: "P1" } };
    expect(parseGetOrderResponse(order).payer).toEqual({ payerId: "P1", email: null, name: null });
  });

  it("an un-approved order's payment_source.paypal with no identity is no payer", () => {
    const order: WireOrder = { id: "O", status: "PAYER_ACTION_REQUIRED", payment_source: { paypal: {} } };
    expect(parseGetOrderResponse(order).payer).toBeNull();
  });
});

describe("paypalFetch headers (SDK: getOrder declares no PayPal-Request-Id; Prefer default return=minimal)", () => {
  beforeEach(() => {
    useCredentials();
    server.use(
      http.post(`${BASE_URL}/v1/oauth2/token`, () =>
        HttpResponse.json({ access_token: "tok", token_type: "Bearer", expires_in: 32400 }),
      ),
    );
  });

  it("a GET carries neither PayPal-Request-Id nor Prefer", async () => {
    let headers: Headers | undefined;
    server.use(
      http.get(`${BASE_URL}/v2/checkout/orders/O`, ({ request }) => {
        headers = request.headers;
        return HttpResponse.json({ id: "O", status: "APPROVED" });
      }),
    );
    await paypalFetch({ method: "GET", path: "/v2/checkout/orders/O", requestId: randomUUID() });
    expect(headers?.get("paypal-request-id")).toBeNull();
    expect(headers?.get("prefer")).toBeNull();
    expect(headers?.get("authorization")).toBe("Bearer tok");
  });

  it("a POST carries PayPal-Request-Id and Prefer: return=representation", async () => {
    let headers: Headers | undefined;
    server.use(
      http.post(`${BASE_URL}/v2/checkout/orders/O/capture`, ({ request }) => {
        headers = request.headers;
        return HttpResponse.json({ id: "O", status: "COMPLETED" }, { status: 201 });
      }),
    );
    const requestId = randomUUID();
    await paypalFetch({ method: "POST", path: "/v2/checkout/orders/O/capture", requestId });
    expect(headers?.get("paypal-request-id")).toBe(requestId);
    expect(headers?.get("prefer")).toBe("return=representation");
  });
});

describe("OAuth token response (SDK decodes it against a schema, never casts)", () => {
  beforeEach(() => useCredentials());

  it("a 2xx without access_token is an OAuth failure, never 'Bearer undefined'", async () => {
    let apiCalls = 0;
    server.use(
      http.post(`${BASE_URL}/v1/oauth2/token`, () => HttpResponse.json({ token_type: "Bearer", expires_in: 100 })),
      http.get(`${BASE_URL}/v2/checkout/orders/O`, () => {
        apiCalls += 1;
        return HttpResponse.json({ id: "O", status: "APPROVED" });
      }),
    );
    const caught = await paypalFetch({ method: "GET", path: "/v2/checkout/orders/O", requestId: "r" }).catch(
      (err: unknown) => err,
    );
    expect(caught).toBeInstanceOf(PayPalNetworkError);
    expect(caught).toMatchObject({ details: { stage: "oauth", oauthStatus: 200 } });
    expect(apiCalls).toBe(0);
  });

  it("a token without expires_in is still cached (one token request for two calls)", async () => {
    let tokenCalls = 0;
    server.use(
      http.post(`${BASE_URL}/v1/oauth2/token`, () => {
        tokenCalls += 1;
        return HttpResponse.json({ access_token: "no-expiry", token_type: "Bearer" });
      }),
      http.get(`${BASE_URL}/v2/checkout/orders/O`, () => HttpResponse.json({ id: "O", status: "APPROVED" })),
    );
    await paypalFetch({ method: "GET", path: "/v2/checkout/orders/O", requestId: "a" });
    await paypalFetch({ method: "GET", path: "/v2/checkout/orders/O", requestId: "b" });
    expect(tokenCalls).toBe(1);
  });
});

describe("payout.send duplicate sender_batch_id (unknown outcome, never a failed payout)", () => {
  let db: Db;
  let worldId: string;

  beforeAll(async () => {
    db = await createTestDb();
  });

  beforeEach(async () => {
    useCredentials();
    server.use(
      http.post(`${BASE_URL}/v1/oauth2/token`, () =>
        HttpResponse.json({ access_token: "tok", token_type: "Bearer", expires_in: 32400 }),
      ),
    );
    const [world] = await db
      .insert(worlds)
      .values({ slug: `world-${randomUUID()}`, name: "World", railMode: "paypal" })
      .returning();
    worldId = world!.id;
  });

  function enqueuePayout() {
    return enqueueOperation(db, {
      worldId,
      rail: "paypal",
      kind: "payout.send",
      purpose: "loan_disbursement",
      sourceId: `loan-${randomUUID()}`,
      request: {
        method: "POST",
        path: "/v1/payments/payouts",
        body: {
          sender_batch_header: {},
          items: [{ recipient_type: "EMAIL", receiver: "a@example.com", amount: { value: "1.00", currency: "USD" } }],
        },
      },
    });
  }

  it("a 400 naming the used sender_batch_id → failed_retryable, not failed_terminal", async () => {
    server.use(
      http.post(`${BASE_URL}/v1/payments/payouts`, () =>
        HttpResponse.json(
          {
            name: "USER_BUSINESS_ERROR",
            message: "User business error.",
            debug_id: "dbg-dup",
            details: [{ field: "SENDER_BATCH_ID", issue: "Batch with given sender_batch_id already exists" }],
          },
          { status: 400 },
        ),
      ),
    );
    const { operationId } = await enqueuePayout();
    const result = await executeOperation(db, operationId);
    expect(result).toMatchObject({
      status: "failed_retryable",
      httpStatus: 400,
      body: { error: { name: "USER_BUSINESS_ERROR", debugId: "dbg-dup" } },
    });
  });

  it("a 400 DUPLICATE_REQUEST_ID → failed_retryable", async () => {
    server.use(
      http.post(`${BASE_URL}/v1/payments/payouts`, () =>
        HttpResponse.json({ name: "DUPLICATE_REQUEST_ID", message: "dup", debug_id: "d" }, { status: 400 }),
      ),
    );
    const { operationId } = await enqueuePayout();
    expect((await executeOperation(db, operationId)).status).toBe("failed_retryable");
  });

  it("any other payout 4xx (e.g. INSUFFICIENT_FUNDS 422) stays failed_terminal", async () => {
    server.use(
      http.post(`${BASE_URL}/v1/payments/payouts`, () =>
        HttpResponse.json(
          { name: "INSUFFICIENT_FUNDS", message: "Sender does not have sufficient funds.", debug_id: "d" },
          { status: 422 },
        ),
      ),
    );
    const { operationId } = await enqueuePayout();
    expect((await executeOperation(db, operationId)).status).toBe("failed_terminal");
  });
});
