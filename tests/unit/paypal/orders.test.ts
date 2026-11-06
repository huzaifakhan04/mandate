import { describe, expect, it } from "vitest";

import {
  InvalidAmountError,
  buildCaptureOrderRequest,
  buildCreateOrderRequest,
  buildGetOrderRequest,
  orderIdFromPath,
  parseCaptureOrderResponse,
  parseCreateOrderResponse,
  parseGetOrderResponse,
} from "@/server/paypal/orders";

const createParams = {
  amountCents: 1234n,
  description: "test",
  customId: "custom-1",
  returnUrl: "https://example.com/return",
  cancelUrl: "https://example.com/cancel",
};

describe("orders request builders / response parsers", () => {
  it("builds an intent:CAPTURE USD order with an exact amount string", () => {
    const request = buildCreateOrderRequest({ ...createParams, payeeEmail: "bank@example.com" });
    expect(request).toMatchObject({
      method: "POST",
      path: "/v2/checkout/orders",
      body: {
        intent: "CAPTURE",
        purchase_units: [
          {
            amount: { currency_code: "USD", value: "12.34" },
            custom_id: "custom-1",
            payee: { email_address: "bank@example.com" },
          },
        ],
      },
    });
  });

  it("rejects a zero/negative amountCents when building", () => {
    expect(() => buildCreateOrderRequest({ ...createParams, amountCents: 0n })).toThrow(
      InvalidAmountError,
    );
    expect(() => buildCreateOrderRequest({ ...createParams, amountCents: -5n })).toThrow(
      InvalidAmountError,
    );
  });

  it("URL-encodes the orderId in capture/get paths and round-trips it", () => {
    const capture = buildCaptureOrderRequest("A/B C");
    const get = buildGetOrderRequest("A/B C");
    expect(capture).toEqual({ method: "POST", path: "/v2/checkout/orders/A%2FB%20C/capture" });
    expect(get).toEqual({ method: "GET", path: "/v2/checkout/orders/A%2FB%20C" });
    expect(orderIdFromPath(capture.path)).toBe("A/B C");
    expect(orderIdFromPath(get.path)).toBe("A/B C");
  });

  it("parses a create response, accepting a payer-action link", () => {
    expect(
      parseCreateOrderResponse({
        id: "ORDER-1",
        status: "PAYER_ACTION_REQUIRED",
        links: [{ rel: "payer-action", href: "https://paypal.test/approve" }],
      }),
    ).toEqual({
      orderId: "ORDER-1",
      status: "PAYER_ACTION_REQUIRED",
      approveUrl: "https://paypal.test/approve",
    });
  });

  it("throws if the create response has no approve/payer-action link", () => {
    expect(() => parseCreateOrderResponse({ id: "ORDER-1", status: "CREATED", links: [] })).toThrow(
      /approve/,
    );
  });

  it("parses a capture: captureStatus distinct from order status, amount as a cents string", () => {
    const result = parseCaptureOrderResponse("ORDER-1", {
      id: "ORDER-1",
      status: "COMPLETED",
      purchase_units: [
        { payments: { captures: [{ id: "CAP-1", status: "PENDING", amount: { value: "10.05" } }] } },
      ],
    });
    expect(result).toEqual({
      orderId: "ORDER-1",
      status: "COMPLETED",
      captureId: "CAP-1",
      captureStatus: "PENDING",
      amountCents: "1005",
      paypalFeeCents: null,
      grossCents: null,
      netCents: null,
      recovered: false,
    });
    // JSON-safe: survives a jsonb round trip unchanged.
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it("throws if the capture response has no capture record", () => {
    expect(() =>
      parseCaptureOrderResponse("ORDER-1", { id: "ORDER-1", status: "COMPLETED" }),
    ).toThrow(/no capture record/);
  });

  it("parses a get response with and without a capture", () => {
    expect(parseGetOrderResponse({ id: "O", status: "APPROVED" })).toEqual({
      orderId: "O",
      status: "APPROVED",
      capture: null,
      payer: null,
    });
    expect(
      parseGetOrderResponse({
        id: "O",
        status: "COMPLETED",
        purchase_units: [
          { payments: { captures: [{ id: "C", status: "COMPLETED", amount: { value: "1.00" } }] } },
        ],
      }).capture,
    ).toEqual({ captureId: "C", captureStatus: "COMPLETED", amountCents: "100", paypalFeeCents: null, grossCents: null, netCents: null });
  });

  it("parses the payer (Verify with PayPal) when present", () => {
    expect(
      parseGetOrderResponse({
        id: "O",
        status: "APPROVED",
        payer: {
          payer_id: "PAYER1",
          email_address: "p@example.com",
          name: { given_name: "Pat", surname: "Payer" },
        },
      }).payer,
    ).toEqual({ payerId: "PAYER1", email: "p@example.com", name: "Pat Payer" });
    expect(parseGetOrderResponse({ id: "O", status: "APPROVED", payer: { payer_id: "P2" } }).payer).toEqual({
      payerId: "P2",
      email: null,
      name: null,
    });
  });
});
