/**
 * Shared payment-rail facade over the PayPal rail and the deterministic
 * sim rail. Every method is `enqueueOperation` + `executeOperation` (see
 * `rail/operationRail.ts`) — there is no second path to PayPal. Services
 * don't use this facade (they enqueue in their transaction and execute
 * after commit); it exists for scripts, tests and bots.
 */

import type { OperationPurpose } from "../paypal/operationId";

export type RailName = "paypal" | "sim";

export interface CreateCheckoutParams {
  worldId: string;
  amountCents: bigint;
  description: string;
  customId: string;
  payeeEmail?: string;
  returnUrl: string;
  cancelUrl: string;
  /** With `sourceId`, derives the operation id (and `PayPal-Request-Id`) — see `deriveOperationId`. */
  purpose: OperationPurpose;
  sourceId: string;
}

export interface RailCheckoutResult {
  rail: RailName;
  operationId: string;
  orderId: string;
  approveUrl: string;
  status: string;
}

export interface CaptureCheckoutParams {
  worldId: string;
  orderId: string;
  /** With `sourceId`, derives the operation id — a retried capture reuses the same `PayPal-Request-Id`. */
  purpose: OperationPurpose;
  sourceId: string;
}

export interface RailCaptureResult {
  rail: RailName;
  operationId: string;
  orderId: string;
  /** True when the order was already captured and the existing capture was returned. */
  recovered: boolean;
  status: string;
  captureStatus: string;
  captureId: string;
  amountCents: bigint;
}

export interface GetCheckoutParams {
  worldId: string;
  orderId: string;
}

export interface RailOrderResult {
  rail: RailName;
  operationId: string;
  orderId: string;
  status: string;
}

export interface SendPayoutParams {
  worldId: string;
  receiver: string;
  receiverType: "EMAIL" | "PAYPAL_ID";
  amountCents: bigint;
  note?: string;
  senderItemId: string;
  /** With `sourceId`, derives the operation id, which is also the batch's `sender_batch_id`. */
  purpose: OperationPurpose;
  sourceId: string;
}

export interface RailPayoutSendResult {
  rail: RailName;
  operationId: string;
  batchId: string;
  batchStatus: string;
  /** The item, when already reported (sim: always; live PayPal POST: usually not). */
  item: { itemId: string | null; transactionStatus: string } | null;
}

export interface GetPayoutParams {
  worldId: string;
  batchId: string;
}

export interface RailPayoutGetResult {
  rail: RailName;
  operationId: string;
  batchStatus: string;
  items: { itemId: string | null; transactionStatus: string }[];
}

export interface PaymentRail {
  name: RailName;
  createCheckout(params: CreateCheckoutParams): Promise<RailCheckoutResult>;
  captureCheckout(params: CaptureCheckoutParams): Promise<RailCaptureResult>;
  getCheckout(params: GetCheckoutParams): Promise<RailOrderResult>;
  sendPayout(params: SendPayoutParams): Promise<RailPayoutSendResult>;
  getPayout(params: GetPayoutParams): Promise<RailPayoutGetResult>;
}
