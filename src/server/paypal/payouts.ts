import { assertPositiveAmountCents, centsToAmount, optionalCents } from "./orders";
import type {
  ExecutableRequest,
  PayoutCancelItemResult,
  PayoutGetResult,
  PayoutItemResult,
  PayoutSendResult,
} from "./types";

/**
 * Request builders + response parsers for PayPal Payouts (Ruling F).
 * They never call PayPal — see the note in `orders.ts`.
 */

export interface SendPayoutRequestParams {
  receiver: string;
  receiverType: "EMAIL" | "PAYPAL_ID" | "PHONE";
  amountCents: bigint;
  note?: string;
  senderItemId: string;
}

/**
 * `POST /v1/payments/payouts` — a single-item batch. The batch's
 * `sender_batch_id` is left out here on purpose: `enqueueOperation`
 * stamps it with the operation's own (derived) id, so it always equals
 * the `PayPal-Request-Id` and PayPal itself rejects a duplicate batch.
 * Rejects non-positive amounts.
 */
export function buildSendPayoutRequest(params: SendPayoutRequestParams): ExecutableRequest {
  assertPositiveAmountCents(params.amountCents);
  return {
    method: "POST",
    path: "/v1/payments/payouts",
    body: {
      sender_batch_header: {},
      items: [
        {
          recipient_type: params.receiverType,
          amount: { value: centsToAmount(params.amountCents), currency: "USD" },
          receiver: params.receiver,
          note: params.note,
          sender_item_id: params.senderItemId,
        },
      ],
    },
  };
}

/** Returns a copy of a payout-send request body with `sender_batch_id` set. */
export function withSenderBatchId(request: ExecutableRequest, senderBatchId: string): ExecutableRequest {
  const body = (request.body ?? {}) as Record<string, unknown>;
  const header = (body.sender_batch_header ?? {}) as Record<string, unknown>;
  return {
    ...request,
    body: { ...body, sender_batch_header: { ...header, sender_batch_id: senderBatchId } },
  };
}

/** `GET /v1/payments/payouts/{batchId}`. */
export function buildGetPayoutRequest(batchId: string): ExecutableRequest {
  return { method: "GET", path: `/v1/payments/payouts/${encodeURIComponent(batchId)}` };
}

const PAYOUT_PATH_RE = /^\/v1\/payments\/payouts\/([^/]+)$/;

export function batchIdFromPath(path: string): string {
  const match = PAYOUT_PATH_RE.exec(path);
  if (!match) {
    throw new Error(`Not a payout get path: ${path}`);
  }
  return decodeURIComponent(match[1] as string);
}

interface PayPalPayoutBody {
  batch_header?: { payout_batch_id?: unknown; batch_status?: unknown; fees?: unknown };
  items?: { payout_item_id?: unknown; transaction_status?: unknown }[];
}

function parseHeader(body: unknown): { batchId: string; batchStatus: string } {
  const header = (body as PayPalPayoutBody | undefined)?.batch_header;
  if (typeof header?.payout_batch_id !== "string" || typeof header.batch_status !== "string") {
    throw new Error("PayPal payout response is missing batch_header.payout_batch_id/batch_status");
  }
  return { batchId: header.payout_batch_id, batchStatus: header.batch_status };
}

function parseItems(body: unknown): PayoutItemResult[] {
  const items = (body as PayPalPayoutBody | undefined)?.items;
  return (Array.isArray(items) ? items : []).map((item) => ({
    itemId: typeof item.payout_item_id === "string" ? item.payout_item_id : null,
    transactionStatus:
      typeof item.transaction_status === "string" ? item.transaction_status : "UNKNOWN",
  }));
}

/** Task 10b: `batch_header.fees` (PayPal's fee for the batch) as cents, or `null` when not reported. */
function parseFee(body: unknown): string | null {
  return optionalCents((body as PayPalPayoutBody | undefined)?.batch_header?.fees);
}

export function parseSendPayoutResponse(body: unknown): PayoutSendResult {
  return { ...parseHeader(body), item: parseItems(body)[0] ?? null, feeCents: parseFee(body) };
}

export function parseGetPayoutResponse(body: unknown): PayoutGetResult {
  return { ...parseHeader(body), items: parseItems(body), feeCents: parseFee(body) };
}

/** `POST /v1/payments/payouts-item/{itemId}/cancel` (Ruling R) — only valid for an UNCLAIMED item. */
export function buildCancelPayoutItemRequest(itemId: string): ExecutableRequest {
  return { method: "POST", path: `/v1/payments/payouts-item/${encodeURIComponent(itemId)}/cancel` };
}

const CANCEL_ITEM_PATH_RE = /^\/v1\/payments\/payouts-item\/([^/]+)\/cancel$/;

export function payoutItemIdFromCancelPath(path: string): string {
  const match = CANCEL_ITEM_PATH_RE.exec(path);
  if (!match) {
    throw new Error(`Not a payout item cancel path: ${path}`);
  }
  return decodeURIComponent(match[1] as string);
}

/** Parses the payout item PayPal returns from a cancel. Throws on a malformed body. */
export function parseCancelPayoutItemResponse(body: unknown): PayoutCancelItemResult {
  const record = (body ?? {}) as { payout_item_id?: unknown; transaction_status?: unknown };
  if (typeof record.payout_item_id !== "string" || typeof record.transaction_status !== "string") {
    throw new Error("PayPal payout item cancel response is missing payout_item_id/transaction_status");
  }
  return { itemId: record.payout_item_id, transactionStatus: record.transaction_status };
}
