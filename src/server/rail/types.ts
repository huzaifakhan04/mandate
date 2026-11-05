/** Shared payment-rail abstraction over the PayPal rail and the deterministic sim rail. */

export type RailName = "paypal" | "sim";

export interface CreateCheckoutParams {
  worldId: string;
  amountCents: bigint;
  description: string;
  customId: string;
  payeeEmail?: string;
  returnUrl: string;
  cancelUrl: string;
  /** Optional caller-supplied idempotency id — see `orders.CreateOrderParams.operationId`. */
  operationId?: string;
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
  /** Optional caller-supplied idempotency id — see `orders.CaptureOrderParams.operationId`. */
  operationId?: string;
}

export interface RailCaptureResult {
  rail: RailName;
  operationId: string;
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
  /** Optional caller-supplied idempotency id — see `payouts.SendPayoutParams.operationId`. */
  operationId?: string;
}

export interface RailPayoutSendResult {
  rail: RailName;
  operationId: string;
  batchId: string;
  itemId?: string;
  batchStatus: string;
}

export interface GetPayoutParams {
  worldId: string;
  batchId: string;
}

export interface RailPayoutGetResult {
  rail: RailName;
  operationId: string;
  batchStatus: string;
  items: { itemId?: string; transactionStatus: string }[];
}

export interface PaymentRail {
  name: RailName;
  createCheckout(params: CreateCheckoutParams): Promise<RailCheckoutResult>;
  captureCheckout(params: CaptureCheckoutParams): Promise<RailCaptureResult>;
  getCheckout(params: GetCheckoutParams): Promise<RailOrderResult>;
  sendPayout(params: SendPayoutParams): Promise<RailPayoutSendResult>;
  getPayout(params: GetPayoutParams): Promise<RailPayoutGetResult>;
}
