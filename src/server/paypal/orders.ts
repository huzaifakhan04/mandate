import type {
  WireLinkDescription,
  WireOrder,
  WireOrderRequest,
  WireOrdersCapture,
  WirePurchaseUnitRequest,
  WireUserAction,
} from "./sdkTypes";
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
  /**
   * APIMatic audit: the PayPal page's final button. `PAY_NOW` (default) —
   * the amount is final and the order is captured as soon as the payer
   * returns (every checkout here). `CONTINUE` — PayPal's default, for an
   * order that is approved but not captured on return (the $0.01 "Verify
   * with PayPal" order).
   */
  userAction?: WireUserAction;
}

/**
 * `POST /v2/checkout/orders` — an `intent: CAPTURE` USD order. Rejects
 * non-positive amounts. The body is typed against the official SDK's
 * `OrderRequest` (`WireOrderRequest`), so a wrong wire key or enum value is
 * a compile error. `shipping_preference: NO_SHIPPING`: nothing here ships,
 * so PayPal must not ask the payer for (or return) a shipping address.
 */
export function buildCreateOrderRequest(params: CreateOrderRequestParams): ExecutableRequest {
  assertPositiveAmountCents(params.amountCents);

  const purchaseUnit: WirePurchaseUnitRequest = {
    amount: { currency_code: "USD", value: centsToAmount(params.amountCents) },
    description: params.description,
    custom_id: params.customId,
    ...(params.payeeEmail ? { payee: { email_address: params.payeeEmail } } : {}),
  };

  const body: WireOrderRequest = {
    intent: "CAPTURE",
    purchase_units: [purchaseUnit],
    payment_source: {
      paypal: {
        experience_context: {
          return_url: params.returnUrl,
          cancel_url: params.cancelUrl,
          user_action: params.userAction ?? "PAY_NOW",
          shipping_preference: "NO_SHIPPING",
        },
      },
    },
  };

  return { method: "POST", path: "/v2/checkout/orders", body };
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

/**
 * The parsers below read PayPal's `Order` through the SDK's wire type
 * (`WireOrder`): every field name they touch is checked against the
 * official model at compile time. Values are still runtime-validated —
 * every Order member is optional in the SDK, so a truncated 2xx decodes
 * "cleanly" there too (plugin: assert on the members you depend on).
 */
function asOrder(body: unknown): WireOrder | undefined {
  return asRecord(body) as WireOrder | undefined;
}

export function parseCreateOrderResponse(body: unknown): OrderCreateResult {
  const record = asOrder(body);
  const orderId = requireString(record?.id, "the order id");
  const links: unknown[] = Array.isArray(record?.links) ? record.links : [];
  const approve = links
    .map((link) => asRecord(link) as Partial<WireLinkDescription> | undefined)
    .find((link) => link?.rel === "approve" || link?.rel === "payer-action");
  return {
    orderId,
    status: requireString(record?.status, "the order status"),
    approveUrl: requireString(approve?.href, `an approve/payer-action link on order ${orderId}`),
  };
}

function firstCapture(body: unknown): CaptureRecord | null {
  const units: unknown = asOrder(body)?.purchase_units;
  const unit = asRecord(Array.isArray(units) ? units[0] : undefined) as
    | NonNullable<WireOrder["purchase_units"]>[number]
    | undefined;
  const captures: unknown = asRecord(unit?.payments)?.captures;
  const captured = asRecord(Array.isArray(captures) ? captures[0] : undefined) as
    | WireOrdersCapture
    | undefined;
  if (!captured) {
    return null;
  }
  const amount = asRecord(captured.amount) as WireOrdersCapture["amount"];
  const breakdown = asRecord(captured.seller_receivable_breakdown) as
    | WireOrdersCapture["seller_receivable_breakdown"]
    | undefined;
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
    status: requireString(asOrder(body)?.status, "the order status"),
    ...capture,
    recovered,
  };
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function fullName(value: unknown): string | null {
  const name = asRecord(value) as NonNullable<WireOrder["payer"]>["name"];
  const joined = [optionalString(name?.given_name), optionalString(name?.surname)]
    .filter((part): part is string => part !== null)
    .join(" ");
  return joined.length > 0 ? joined : null;
}

/**
 * The order's payer (P2 Verify with PayPal), or `null` when the order has
 * none yet. APIMatic audit: the SDK marks `Order.payer` **@deprecated** —
 * "the details in the `payer` object are now available under
 * `payment_source.paypal`" (`account_id` = the payer id). So
 * `payment_source.paypal` is read first and each field falls back to the
 * legacy `payer` object, which PayPal still sends today.
 */
function parsePayer(order: WireOrder | undefined): OrderPayer | null {
  const wallet = asRecord(asRecord(order?.payment_source)?.paypal) as
    | NonNullable<NonNullable<WireOrder["payment_source"]>["paypal"]>
    | undefined;
  const legacy = asRecord(order?.payer) as WireOrder["payer"];
  if (!wallet && !legacy) {
    return null;
  }
  const payerId = optionalString(wallet?.account_id) ?? optionalString(legacy?.payer_id);
  const email = optionalString(wallet?.email_address) ?? optionalString(legacy?.email_address);
  const name = fullName(wallet?.name) ?? fullName(legacy?.name);
  if (!payerId && !email && !name && !legacy) {
    // A `payment_source.paypal` carrying only experience settings (before approval) is no payer.
    return null;
  }
  return { payerId, email, name };
}

export function parseGetOrderResponse(body: unknown): OrderGetResult {
  const record = asOrder(body);
  return {
    orderId: requireString(record?.id, "the order id"),
    status: requireString(record?.status, "the order status"),
    capture: firstCapture(body),
    payer: parsePayer(record),
  };
}
