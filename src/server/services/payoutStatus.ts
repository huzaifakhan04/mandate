import type { Db } from "../db/client";
import {
  buildCancelPayoutItemRequest,
  deriveOperationId,
  enqueueOperation,
  errorBody,
  executeOperation,
  getOperation,
  latestPayoutGetForSend,
  type OperationResult,
  type PayoutCancelItemResult,
  type PayoutSendResult,
} from "../paypal/operations";
import { knownPayoutFee, type KnownPayoutFee } from "./paypalFees";
import { railForWorld } from "./worlds";

/**
 * Shared payout-settlement logic for every payout outcome applier (loan
 * disbursements in `loans.ts`, note redemptions in `notes.ts`).
 *
 * Ruling J/R: SUCCESS → apply the effect; FAILED/RETURNED/BLOCKED/
 * REFUNDED/DENIED → failure effect; UNCLAIMED is NOT terminal — the money
 * stays reserved, the item is cancelled (`payout.cancel_item`), and only
 * once it is RETURNED does the failure effect apply. Anything else
 * (PENDING, ONHOLD, UNKNOWN, no item yet) stays pending.
 */
export const TERMINAL_FAILED_PAYOUT_ITEM_STATUSES = new Set(["FAILED", "RETURNED", "BLOCKED", "REFUNDED", "DENIED"]);

/**
 * Ruling Q: a payout item status seen outside the `payout.send` result — a
 * verified webhook (`PAYMENT.PAYOUTS-ITEM.*`) or a cron poll. `itemId` is
 * optional (needed only to cancel an UNCLAIMED item; when absent it comes
 * from the latest `payout.get` or the send result).
 */
export interface ObservedPayoutStatus {
  itemStatus: string;
  source: "webhook" | "poll";
  itemId?: string;
}

export type PayoutResolution =
  | { kind: "pending" }
  /**
   * `fee` (Task 10b): the batch's PayPal fee when already known — the
   * applier journals it in the same transaction as the success effect;
   * when `null`, a later poll posts it (`postPayoutFeeIfKnown`).
   */
  | { kind: "succeeded"; fee: KnownPayoutFee | null }
  | { kind: "failed"; reason: string };

/** Maps `agents.payout_receiver_type` to PayPal's `recipient_type`; `null` for anything unknown (M4). */
export function payoutRecipientType(receiverType: string | null): "EMAIL" | "PAYPAL_ID" | "PHONE" | null {
  switch (receiverType) {
    case "email":
      return "EMAIL";
    case "paypal_id":
      return "PAYPAL_ID";
    case "phone":
      return "PHONE";
    default:
      return null;
  }
}

/**
 * Executes the `payout.send` operation (a no-op returning the stored
 * result when it is already final, or in flight elsewhere; respects
 * backoff) and resolves its item's status. Never call inside a
 * transaction: it may also enqueue and execute a `payout.cancel_item`.
 *
 * The item status comes from, in priority order:
 * 1. a succeeded cancel of the item (it is RETURNED — final);
 * 2. `observed` (webhook / poll), when given;
 * 3. the newest succeeded `payout.get` read of the batch made after the send;
 * 4. the send result's own item (usually absent on live PayPal).
 */
export async function resolvePayoutOutcome(
  db: Db,
  sendOperationId: string,
  observed?: ObservedPayoutStatus,
): Promise<PayoutResolution> {
  const op = await executeOperation(db, sendOperationId);

  if (op.status === "queued" || op.status === "in_flight" || op.status === "failed_retryable") {
    return { kind: "pending" };
  }
  if (op.status === "failed_terminal") {
    const error = errorBody(op);
    return { kind: "failed", reason: `payout_error:${error?.issue ?? error?.name ?? "unknown"}` };
  }

  const record = await getOperation(db, sendOperationId);
  if (!record) {
    return { kind: "pending" };
  }
  const worldId = record.worldId;
  const sendBody = op.body as PayoutSendResult;
  const sendItem = sendBody.item;
  const latestGet = await latestPayoutGetForSend(db, sendOperationId);
  const statusResolution = (itemStatus: string): PayoutResolution =>
    resolveItemStatus(itemStatus, () => knownPayoutFee(sendBody, latestGet));
  const getItem = latestGet?.items[0] ?? null;
  const itemId = observed?.itemId ?? getItem?.itemId ?? sendItem?.itemId ?? null;

  if (itemId) {
    const cancel = await getOperation(db, deriveOperationId(worldId, "payout_cancel", itemId));
    if (cancel?.status === "succeeded") {
      return statusResolution((cancel.body as PayoutCancelItemResult).transactionStatus);
    }
  }

  const itemStatus = observed?.itemStatus ?? getItem?.transactionStatus ?? sendItem?.transactionStatus ?? null;
  if (!itemStatus) {
    return { kind: "pending" };
  }
  if (itemStatus !== "UNCLAIMED") {
    return statusResolution(itemStatus);
  }
  if (!itemId) {
    return { kind: "pending" }; // Can't cancel without the item id; a later poll supplies it.
  }

  const cancelled = await cancelUnclaimedItem(db, worldId, itemId);
  if (cancelled?.status === "succeeded") {
    return statusResolution((cancelled.body as PayoutCancelItemResult).transactionStatus);
  }
  // Cancel pending/retrying, or refused (e.g. the receiver claimed it in
  // the meantime — a later poll then sees SUCCESS): stays reserved.
  return { kind: "pending" };
}

function resolveItemStatus(itemStatus: string, fee: () => KnownPayoutFee | null): PayoutResolution {
  if (itemStatus === "SUCCESS") {
    return { kind: "succeeded", fee: fee() };
  }
  if (TERMINAL_FAILED_PAYOUT_ITEM_STATUSES.has(itemStatus)) {
    return { kind: "failed", reason: itemStatus };
  }
  return { kind: "pending" };
}

/**
 * Ruling R: enqueue (idempotent — id derived from `payout_cancel` + item
 * id) and execute the cancel of an UNCLAIMED item, outside any
 * transaction. Returns the operation's current result.
 */
async function cancelUnclaimedItem(db: Db, worldId: string, itemId: string): Promise<OperationResult | null> {
  const rail = await railForWorld(db, worldId);
  const { operationId } = await enqueueOperation(db, {
    worldId,
    rail,
    kind: "payout.cancel_item",
    purpose: "payout_cancel",
    sourceId: itemId,
    request: buildCancelPayoutItemRequest(itemId),
  });
  return executeOperation(db, operationId);
}
