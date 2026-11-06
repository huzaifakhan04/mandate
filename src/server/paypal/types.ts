/**
 * Shared shapes for queued PayPal operations: the stored executable
 * request and the parsed, JSON-safe result stored in
 * `paypal_operations.response` (one shape per kind — Ruling H). Every
 * amount is integer cents as a decimal *string* (jsonb can't hold a
 * bigint); convert with `BigInt(...)` at the edge.
 */

export type OperationKind =
  | "order.create"
  | "order.capture"
  | "order.get"
  | "payout.send"
  | "payout.get"
  | "payout.cancel_item";

export const OPERATION_KINDS: readonly OperationKind[] = [
  "order.create",
  "order.capture",
  "order.get",
  "payout.send",
  "payout.get",
  "payout.cancel_item",
];

/** Read-only kinds: never move money, so they may run under an ad-hoc (random) id. */
export const READ_KINDS: readonly OperationKind[] = ["order.get", "payout.get"];

export type OperationStatus =
  | "queued"
  | "in_flight"
  | "succeeded"
  | "failed_retryable"
  | "failed_terminal";

/** Stored unredacted in `executable_request` and re-sent on every attempt. */
export interface ExecutableRequest {
  method: "GET" | "POST" | "PATCH";
  path: string;
  body?: unknown;
}

export interface OrderCreateResult {
  orderId: string;
  status: string;
  approveUrl: string;
}

export interface CaptureRecord {
  captureId: string;
  captureStatus: string;
  amountCents: string;
  /**
   * Task 10b: PayPal's processing fee on this capture
   * (`seller_receivable_breakdown.paypal_fee`), with the breakdown's gross
   * and net — `null` when PayPal didn't report a breakdown (e.g. a
   * `PENDING` capture, or a result stored before Task 10b, where the
   * fields are absent altogether — read them with `?? null`).
   */
  paypalFeeCents: string | null;
  grossCents: string | null;
  netCents: string | null;
}

export interface OrderCaptureResult extends CaptureRecord {
  orderId: string;
  /** The order's status (distinct from `captureStatus`). */
  status: string;
  /**
   * True when PayPal answered `ORDER_ALREADY_CAPTURED` and the existing
   * capture was recovered with a GET on the order.
   */
  recovered: boolean;
}

/** The order's payer, once someone approved it (Verify with PayPal reads this). */
export interface OrderPayer {
  payerId: string | null;
  email: string | null;
  /** `given_name surname`, or `null` when PayPal sent neither. */
  name: string | null;
}

export interface OrderGetResult {
  orderId: string;
  status: string;
  /** The order's first capture, once it has one. */
  capture: CaptureRecord | null;
  /**
   * The payer, when the order shows one (after approval). Optional on the
   * type because `order.get` rows stored before P2 have no such field.
   */
  payer?: OrderPayer | null;
}

export interface PayoutItemResult {
  itemId: string | null;
  transactionStatus: string;
}

export interface PayoutSendResult {
  batchId: string;
  batchStatus: string;
  /** Present when PayPal (or the sim) already reports the item; PayPal's live POST usually doesn't. */
  item: PayoutItemResult | null;
  /** Task 10b: the batch's PayPal fee (`batch_header.fees`), or `null` when not reported. */
  feeCents: string | null;
}

export interface PayoutGetResult {
  batchId: string;
  batchStatus: string;
  items: PayoutItemResult[];
  /** Task 10b: the batch's PayPal fee (`batch_header.fees`), or `null` when not reported. */
  feeCents: string | null;
}

/**
 * `POST /v1/payments/payouts-item/{id}/cancel` (Ruling R): cancels an
 * UNCLAIMED item, returning its funds; the item is then `RETURNED`.
 */
export interface PayoutCancelItemResult {
  itemId: string;
  transactionStatus: string;
}

export interface OperationResultByKind {
  "order.create": OrderCreateResult;
  "order.capture": OrderCaptureResult;
  "order.get": OrderGetResult;
  "payout.send": PayoutSendResult;
  "payout.get": PayoutGetResult;
  "payout.cancel_item": PayoutCancelItemResult;
}

/** Stored `response` of a failed operation (redacted). */
export interface OperationError {
  error: {
    /** PayPal's top-level `name`, or `PayPalNetworkError` / `PayPalConfigError` / `RESPONSE_UNPARSEABLE` / `INTERNAL_ERROR`. */
    name: string;
    /** PayPal's `details[0].issue` (e.g. `ORDER_NOT_APPROVED`), when present. */
    issue: string | null;
    message: string | null;
    debugId: string | null;
    details: unknown;
  };
}

export type OperationResponse =
  | OperationResultByKind[OperationKind]
  | OperationError;
