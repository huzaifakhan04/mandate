import type { Db } from "../db/client";
import { paypalFetch } from "./fetch";

/** Converts integer cents to a PayPal amount string ("1234" -> "12.34"). Never uses floats. */
export function centsToAmount(cents: bigint): string {
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  const dollars = abs / 100n;
  const remainder = abs % 100n;
  const value = `${dollars.toString()}.${remainder.toString().padStart(2, "0")}`;
  return negative ? `-${value}` : value;
}

/** Converts a PayPal amount string ("12.34") to integer cents. Never uses floats. */
export function amountToCents(value: string): bigint {
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [whole = "0", fraction = ""] = unsigned.split(".");
  const paddedFraction = fraction.padEnd(2, "0").slice(0, 2);
  const cents = BigInt(whole || "0") * 100n + BigInt(paddedFraction || "0");
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

interface PayPalCaptureResponse {
  id: string;
  status: string;
  purchase_units?: {
    payments?: {
      captures?: { id: string; amount?: { value: string } }[];
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

  const approveUrl =
    body.links?.find((link) => link.rel === "approve" || link.rel === "payer-action")
      ?.href ?? "";

  return { orderId: body.id, approveUrl, status: body.status, operationId };
}

export interface CaptureOrderParams {
  worldId: string;
  orderId: string;
}

export interface CaptureOrderResult {
  status: string;
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
    path: `/v2/checkout/orders/${params.orderId}/capture`,
  });

  const captured = body.purchase_units?.[0]?.payments?.captures?.[0];

  return {
    status: body.status,
    captureId: captured?.id ?? "",
    amountCents: amountToCents(captured?.amount?.value ?? "0.00"),
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
    path: `/v2/checkout/orders/${params.orderId}`,
  });

  return { orderId: body.id, status: body.status, operationId };
}
