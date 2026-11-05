import type { Db } from "../db/client";
import { paypalFetch } from "./fetch";

/** Thrown by `amountToCents`/`assertPositiveAmountCents` for malformed or non-positive amounts. */
export class InvalidAmountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidAmountError";
  }
}

/**
 * Money-movement boundary guard, used by both rails (`orders.create` /
 * `payouts.send` here, and `simRail`): PayPal amounts are always
 * strictly positive integer cents. Zero or negative amounts are
 * rejected before any network call or `paypal_operations` row is
 * written.
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

interface PayPalLink {
  rel: string;
  href: string;
}

interface PayPalOrderResponse {
  id: string;
  status: string;
  links?: PayPalLink[];
}

interface PayPalCapture {
  id: string;
  status: string;
  amount?: { value: string };
}

interface PayPalCaptureResponse {
  id: string;
  status: string;
  purchase_units?: {
    payments?: {
      captures?: PayPalCapture[];
    };
  }[];
}

export interface CreateOrderParams {
  worldId: string;
  amountCents: bigint;
  description: string;
  customId: string;
  payeeEmail?: string;
  returnUrl: string;
  cancelUrl: string;
  /**
   * Optional caller-supplied idempotency id (e.g. derived from a
   * loan/note id). Reusing the same id for a retried call returns the
   * original order instead of creating a second one. Omit to let
   * `paypalFetch` mint a fresh id.
   */
  operationId?: string;
}

export interface CreateOrderResult {
  orderId: string;
  approveUrl: string;
  status: string;
  operationId: string;
}

/** Builds and submits an `intent: CAPTURE` USD order via PayPal Orders v2. */
export async function create(
  db: Db,
  params: CreateOrderParams,
): Promise<CreateOrderResult> {
  assertPositiveAmountCents(params.amountCents);

  const purchaseUnit: Record<string, unknown> = {
    amount: {
      currency_code: "USD",
      value: centsToAmount(params.amountCents),
    },
    description: params.description,
    custom_id: params.customId,
  };
  if (params.payeeEmail) {
    purchaseUnit.payee = { email_address: params.payeeEmail };
  }

  const { body, operationId } = await paypalFetch<PayPalOrderResponse>(db, {
    worldId: params.worldId,
    kind: "order.create",
    method: "POST",
    path: "/v2/checkout/orders",
    operationId: params.operationId,
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
  });

  const approveLink = body.links?.find(
    (link) => link.rel === "approve" || link.rel === "payer-action",
  );
  if (!approveLink) {
    throw new Error(
      `PayPal order ${body.id} response had no approve/payer-action link`,
    );
  }

  return {
    orderId: body.id,
    approveUrl: approveLink.href,
    status: body.status,
    operationId,
  };
}

export interface CaptureOrderParams {
  worldId: string;
  orderId: string;
}

export interface CaptureOrderResult {
  status: string;
  /** The capture's own status (e.g. "COMPLETED", "PENDING"), distinct from the order's status above. */
  captureStatus: string;
  captureId: string;
  amountCents: bigint;
  operationId: string;
}

export async function capture(
  db: Db,
  params: CaptureOrderParams,
): Promise<CaptureOrderResult> {
  const { body, operationId } = await paypalFetch<PayPalCaptureResponse>(db, {
    worldId: params.worldId,
    kind: "order.capture",
    method: "POST",
    path: `/v2/checkout/orders/${encodeURIComponent(params.orderId)}/capture`,
  });

  const captured = body.purchase_units?.[0]?.payments?.captures?.[0];
  if (!captured) {
    throw new Error(
      `PayPal order ${params.orderId} capture response (status=${body.status}) had no capture record`,
    );
  }
  if (!captured.amount?.value) {
    throw new Error(
      `PayPal capture ${captured.id} for order ${params.orderId} had no amount value`,
    );
  }

  return {
    status: body.status,
    captureStatus: captured.status,
    captureId: captured.id,
    amountCents: amountToCents(captured.amount.value),
    operationId,
  };
}

export interface GetOrderParams {
  worldId: string;
  orderId: string;
}

export interface GetOrderResult {
  orderId: string;
  status: string;
  operationId: string;
}

export async function get(
  db: Db,
  params: GetOrderParams,
): Promise<GetOrderResult> {
  const { body, operationId } = await paypalFetch<PayPalOrderResponse>(db, {
    worldId: params.worldId,
    kind: "order.get",
    method: "GET",
    path: `/v2/checkout/orders/${encodeURIComponent(params.orderId)}`,
  });

  return { orderId: body.id, status: body.status, operationId };
}
