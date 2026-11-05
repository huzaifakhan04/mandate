import { randomUUID } from "crypto";

import type { Db } from "../db/client";
import { assertPositiveAmountCents, centsToAmount } from "./orders";
import { paypalFetch } from "./fetch";

interface PayPalPayoutItem {
  payout_item_id?: string;
  transaction_status?: string;
}

interface PayPalPayoutBatchHeader {
  payout_batch_id: string;
  batch_status: string;
}

interface PayPalPayoutResponse {
  batch_header: PayPalPayoutBatchHeader;
  items?: PayPalPayoutItem[];
}

export interface SendPayoutParams {
  worldId: string;
  receiver: string;
  receiverType: "EMAIL" | "PAYPAL_ID";
  amountCents: bigint;
  note?: string;
  senderItemId: string;
  /**
   * Optional caller-supplied idempotency id (e.g. derived from a
   * loan/note id). Reusing the same id for a retried call replays the
   * original payout's result instead of sending money twice — it also
   * becomes the batch's `sender_batch_id`. Omit to let this function
   * mint a fresh id.
   *
   * NOTE: this only covers an exact-id replay. A duplicate
   * `sender_batch_id` collision from two *different* operationIds that
   * happen to target the same loan/note (e.g. a reconciler re-deriving
   * an id slightly differently) is a P1 reconciliation concern, not
   * handled here.
   */
  operationId?: string;
}

export interface SendPayoutResult {
  batchId: string;
  itemId?: string;
  batchStatus: string;
  operationId: string;
}

/**
 * Submits a single-item PayPal Payouts batch. The batch's
 * `sender_batch_id` is the same id used as the `PayPal-Request-Id` /
 * `paypal_operations.id` for this call, generated (or taken from
 * `params.operationId`) up front so it can be embedded in the request
 * body before the request is sent.
 */
export async function send(
  db: Db,
  params: SendPayoutParams,
): Promise<SendPayoutResult> {
  assertPositiveAmountCents(params.amountCents);

  const operationId = params.operationId ?? randomUUID();

  const { body, operationId: confirmedOperationId } =
    await paypalFetch<PayPalPayoutResponse>(db, {
      worldId: params.worldId,
      kind: "payout.send",
      method: "POST",
      path: "/v1/payments/payouts",
      operationId,
      body: {
        sender_batch_header: {
          sender_batch_id: operationId,
        },
        items: [
          {
            recipient_type: params.receiverType,
            amount: {
              value: centsToAmount(params.amountCents),
              currency: "USD",
            },
            receiver: params.receiver,
            note: params.note,
            sender_item_id: params.senderItemId,
          },
        ],
      },
    });

  const item = body.items?.[0];

  return {
    batchId: body.batch_header.payout_batch_id,
    itemId: item?.payout_item_id,
    batchStatus: body.batch_header.batch_status,
    operationId: confirmedOperationId,
  };
}

export interface GetPayoutParams {
  worldId: string;
  batchId: string;
}

export interface GetPayoutResult {
  batchStatus: string;
  items: { itemId?: string; transactionStatus: string }[];
  operationId: string;
}

export async function get(
  db: Db,
  params: GetPayoutParams,
): Promise<GetPayoutResult> {
  const { body, operationId } = await paypalFetch<PayPalPayoutResponse>(db, {
    worldId: params.worldId,
    kind: "payout.get",
    method: "GET",
    path: `/v1/payments/payouts/${encodeURIComponent(params.batchId)}`,
  });

  return {
    batchStatus: body.batch_header.batch_status,
    items: (body.items ?? []).map((item) => ({
      itemId: item.payout_item_id,
      transactionStatus: item.transaction_status ?? "UNKNOWN",
    })),
    operationId,
  };
}
