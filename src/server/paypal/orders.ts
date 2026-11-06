import type {
  CaptureRecord,
  ExecutableRequest,
  OrderCaptureResult,
  OrderCreateResult,
  OrderGetResult,
  OrderPayer,
} from "./types";

/** Thrown by `amountToCents`/`assertPositiveAmountCents` for malformed or non-positive amounts. */
export class InvalidAmountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidAmountError";
  }
}

/**
 * Money-movement boundary guard, applied by the request builders
 * (`buildCreateOrderRequest` / `buildSendPayoutRequest`) for both rails:
 * PayPal amounts are always strictly positive integer cents. Zero or
 * negative amounts are rejected before any operation row is enqueued.
 */
export function assertPositiveAmountCents(cents: bigint): void {
  if (cents <= 0n) {
    throw new InvalidAmountError(
      `amountCents must be a positive integer, got ${cents.toString()}`,
    );
  }
}

/** Converts integer cents to a PayPal amount string ("1234" -> "12.34"). Never uses floats. */
export function centsToAmount(cents: bigint): string {
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  const dollars = abs / 100n;
  const remainder = abs % 100n;
  const value = `${dollars.toString()}.${remainder.toString().padStart(2, "0")}`;
  return negative ? `-${value}` : value;
}

/** A valid PayPal amount string: optional sign, at least one digit, optional 1-2 decimal digits. */
const AMOUNT_STRING_RE = /^-?\d+(\.\d{1,2})?$/;

/**
 * Converts a PayPal amount string ("12.34") to integer cents. Never uses
 * floats. Throws `InvalidAmountError` for anything that isn't a plain
 * decimal with at most 2 fraction digits (e.g. "1.505" or "abc").
 */
export function amountToCents(value: string): bigint {
  if (!AMOUNT_STRING_RE.test(value)) {
    throw new InvalidAmountError(
      `Malformed PayPal amount string: ${JSON.stringify(value)}`,
    );
  }

  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [whole, fraction = ""] = unsigned.split(".");
  const paddedFraction = fraction.padEnd(2, "0");
  const cents = BigInt(whole as string) * 100n + BigInt(paddedFraction || "0");
  return negative ? -cents : cents;
}

// ---------------------------------------------------------------------
// Request builders + response parsers (Ruling F). They never call PayPal:
// services build a request here, `enqueueOperation` stores it, and
// `executeOperation` sends it (to PayPal or the sim rail) and parses the
// response with the matching parser below — one code path for both rails.
// ---------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function requireString(value: unknown, what: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`PayPal response is missing ${what}`);
  }
  return value;
}

export interface CreateOrderRequestParams {
  amountCents: bigint;
  description: string;
  customId: string;
  payeeEmail?: string;
  returnUrl: string;
  cancelUrl: string;
}

/** `POST /v2/checkout/orders` — an `intent: CAPTURE` USD order. Rejects non-positive amounts. */
export function buildCreateOrderRequest(params: CreateOrderRequestParams): ExecutableRequest {
  assertPositiveAmountCents(params.amountCents);

  const purchaseUnit: Record<string, unknown> = {
    amount: { currency_code: "USD", value: centsToAmount(params.amountCents) },
    description: params.description,
    custom_id: params.customId,
  };
  if (params.payeeEmail) {
    purchaseUnit.payee = { email_address: params.payeeEmail };
  }

  return {
    method: "POST",
    path: "/v2/checkout/orders",
    body: {
      intent: "CAPTURE",
      purchase_units: [purchaseUnit],
      payment_source: {
        paypal: {
          experience_context: {
            return_url: params.returnUrl,
            cancel_url: params.cancelUrl,
          },
        },
      },
    },
  };
}

function orderPath(orderId: string): string {
  return `/v2/checkout/orders/${encodeURIComponent(orderId)}`;
}

/** `POST /v2/checkout/orders/{id}/capture`. */
export function buildCaptureOrderRequest(orderId: string): ExecutableRequest {
  return { method: "POST", path: `${orderPath(orderId)}/capture` };
}

/** `GET /v2/checkout/orders/{id}`. */
export function buildGetOrderRequest(orderId: string): ExecutableRequest {
  return { method: "GET", path: orderPath(orderId) };
}

const ORDER_PATH_RE = /^\/v2\/checkout\/orders\/([^/]+)(?:\/capture)?$/;

/** The order id in a capture/get path built by the functions above. */
export function orderIdFromPath(path: string): string {
  const match = ORDER_PATH_RE.exec(path);
  if (!match) {
    throw new Error(`Not an order capture/get path: ${path}`);
  }
  return decodeURIComponent(match[1] as string);
}

export function parseCreateOrderResponse(body: unknown): OrderCreateResult {
  const record = asRecord(body);
  const orderId = requireString(record?.id, "the order id");
  const links = Array.isArray(record?.links) ? record.links : [];
  const approve = links
    .map(asRecord)
    .find((link) => link?.rel === "approve" || link?.rel === "payer-action");
  return {
    orderId,
    status: requireString(record?.status, "the order status"),
    approveUrl: requireString(approve?.href, `an approve/payer-action link on order ${orderId}`),
  };
}

function firstCapture(body: unknown): CaptureRecord | null {
  const unit = asRecord((asRecord(body)?.purchase_units as unknown[] | undefined)?.[0]);
  const payments = asRecord(unit?.payments);
  const captured = asRecord((payments?.captures as unknown[] | undefined)?.[0]);
  if (!captured) {
    return null;
  }
  const amount = asRecord(captured.amount);
  const breakdown = asRecord(captured.seller_receivable_breakdown);
  return {
    captureId: requireString(captured.id, "the capture id"),
    captureStatus: requireString(captured.status, "the capture status"),
    amountCents: amountToCents(requireString(amount?.value, "the capture amount")).toString(),
    paypalFeeCents: optionalCents(breakdown?.paypal_fee),
    grossCents: optionalCents(breakdown?.gross_amount),
    netCents: optionalCents(breakdown?.net_amount),
  };
}

/**
 * Task 10b: an optional PayPal money object (`{ value: "1.23" }`) as a
 * cents string, or `null` when absent. A malformed value throws (the
 * whole response is then unparseable, like a malformed amount).
 */
export function optionalCents(money: unknown): string | null {
  const value = asRecord(money)?.value;
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new InvalidAmountError(`Malformed PayPal amount: ${JSON.stringify(value)}`);
  }
  return amountToCents(value).toString();
}

/** Parses a capture response; `recovered` is set by the caller for the ORDER_ALREADY_CAPTURED path. */
export function parseCaptureOrderResponse(
  orderId: string,
  body: unknown,
  recovered = false,
): OrderCaptureResult {
  const capture = firstCapture(body);
  if (!capture) {
    throw new Error(`PayPal order ${orderId} response had no capture record`);
  }
  return {
    orderId,
    status: requireString(asRecord(body)?.status, "the order status"),
    ...capture,
    recovered,
  };
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** The order's `payer` (P2 Verify with PayPal), or `null` when the order has none yet. */
function parsePayer(value: unknown): OrderPayer | null {
  const payer = asRecord(value);
  if (!payer) {
    return null;
  }
  const name = asRecord(payer.name);
  const fullName = [optionalString(name?.given_name), optionalString(name?.surname)]
    .filter((part): part is string => part !== null)
    .join(" ");
  return {
    payerId: optionalString(payer.payer_id),
    email: optionalString(payer.email_address),
    name: fullName.length > 0 ? fullName : null,
  };
}

export function parseGetOrderResponse(body: unknown): OrderGetResult {
  const record = asRecord(body);
  return {
    orderId: requireString(record?.id, "the order id"),
    status: requireString(record?.status, "the order status"),
    capture: firstCapture(body),
    payer: parsePayer(record?.payer),
  };
}
