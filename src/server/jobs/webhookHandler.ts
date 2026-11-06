import { NextResponse } from "next/server";

import type { Db } from "../db/client";
import { amountToCents, findOperationByPaypalId, getOperation, optionalCents } from "../paypal/operations";
import {
  getWebhookEvent,
  markWebhookEventProcessed,
  recordWebhookEvent,
  verifyWebhookSignature,
} from "../paypal/webhooks";
import { settleCheckoutByOrderId, type ObservedCapture } from "../services/checkouts";
import { dispatchPayoutOutcome } from "../services/payoutPolling";
import type { ObservedPayoutStatus } from "../services/payoutStatus";
import { errorMessage } from "./jobRuns";

/**
 * Task 8 — `POST /api/webhooks/paypal`.
 *
 * 1. Requires `application/json` and at most 64 KB (413 above), parses the
 *    event (400 if it isn't JSON or has no `id`/`event_type`) — all before
 *    any PayPal call or DB write.
 * 2. An event id already stored verified AND processed → 200 no-op.
 * 3. Verifies the delivery with PayPal (`verifyWebhookSignature`). Could
 *    not ask PayPal → 503 (PayPal redelivers). Unverified → stored with
 *    `verified = false` (ids only, no body — M4), 400, no effect. A
 *    verified body is stored through `redact()`.
 * 4. Resolves the world from the operation that owns the PayPal resource
 *    (a payout batch's `payout.send`, an order's `order.create`), stores
 *    the event with that world (null when no world knows it — stored,
 *    200, no effect), then dispatches:
 *    - `PAYMENT.PAYOUTS-ITEM.*` → the payout's applier with the event's
 *      item status as `observed` (Ruling Q);
 *    - `CHECKOUT.ORDER.APPROVED` → `settleCheckoutByOrderId(resource.id)`;
 *    - `PAYMENT.CAPTURE.COMPLETED|DENIED|DECLINED` →
 *      `settleCheckoutByOrderId(resource.supplementary_data.related_ids.order_id)`;
 *    - anything else → stored only.
 *    Every effect is idempotent, so a webhook racing the reconcile cron
 *    (or a redelivery) applies it once (Review Focus 2). A dispatch that
 *    throws → 500 and the event stays unprocessed, so the redelivery
 *    retries it.
 */

const MAX_BODY_BYTES = 64 * 1024;

const CAPTURE_EVENTS = new Set(["PAYMENT.CAPTURE.COMPLETED", "PAYMENT.CAPTURE.DENIED", "PAYMENT.CAPTURE.DECLINED"]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Target =
  | { kind: "payout"; worldId: string; sendOperationId: string; observed?: ObservedPayoutStatus }
  | { kind: "checkout"; worldId: string; orderId: string; observedCapture?: ObservedCapture };

interface PayPalEvent {
  id: string;
  event_type: string;
  resource?: unknown;
}

function json(body: Record<string, unknown>, status: number): NextResponse {
  return NextResponse.json(body, { status });
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Reads the body as UTF-8, or `null` as soon as it exceeds `maxBytes`. */
async function readBodyLimited(req: Request, maxBytes: number): Promise<string | null> {
  if (!req.body) {
    return "";
  }
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Finds the world + effect a verified event targets, or `null` for a resource no world knows. */
async function resolveTarget(db: Db, event: PayPalEvent): Promise<Target | null> {
  const resource = record(event.resource);

  if (event.event_type.startsWith("PAYMENT.PAYOUTS-ITEM.")) {
    const batchId = str(resource.payout_batch_id);
    let send = batchId ? await findOperationByPaypalId(db, "payout.send", batchId) : undefined;
    // Fallback: our sender_batch_id IS the send operation's id.
    const senderBatchId = str(resource.sender_batch_id) ?? str(record(resource.payout_item).sender_batch_id);
    if (!send && senderBatchId && UUID_RE.test(senderBatchId)) {
      const op = await getOperation(db, senderBatchId);
      send = op?.kind === "payout.send" ? op : undefined;
    }
    if (!send) {
      return null;
    }
    const itemStatus = str(resource.transaction_status);
    const itemId = str(resource.payout_item_id);
    return {
      kind: "payout",
      worldId: send.worldId,
      sendOperationId: send.operationId,
      observed: itemStatus ? { itemStatus, source: "webhook", ...(itemId ? { itemId } : {}) } : undefined,
    };
  }

  let orderId: string | null = null;
  let observedCapture: ObservedCapture | undefined;
  if (event.event_type === "CHECKOUT.ORDER.APPROVED") {
    orderId = str(resource.id);
  } else if (CAPTURE_EVENTS.has(event.event_type)) {
    orderId = str(record(record(resource.supplementary_data).related_ids).order_id);
    observedCapture = captureFromResource(resource);
  }
  if (!orderId) {
    return null;
  }
  const create = await findOperationByPaypalId(db, "order.create", orderId);
  return create ? { kind: "checkout", worldId: create.worldId, orderId, observedCapture } : null;
}

/**
 * Fix round 1 (I1): a `PAYMENT.CAPTURE.*` resource IS the capture — its
 * id, status and amount. Settlement uses it directly for a capture it
 * stored as PENDING (only when the ids match), with no extra GET.
 */
function captureFromResource(resource: Record<string, unknown>): ObservedCapture | undefined {
  const captureId = str(resource.id);
  const captureStatus = str(resource.status);
  if (!captureId || !captureStatus) {
    return undefined;
  }
  const value = str(record(resource.amount).value);
  let amountCents: string | undefined;
  if (value) {
    try {
      amountCents = amountToCents(value).toString();
    } catch {
      amountCents = undefined; // Malformed amount: keep the stored one.
    }
  }
  let paypalFeeCents: string | undefined;
  try {
    paypalFeeCents = optionalCents(record(resource.seller_receivable_breakdown).paypal_fee) ?? undefined;
  } catch {
    paypalFeeCents = undefined; // Malformed fee: keep the stored one (Task 10b).
  }
  return {
    captureId,
    captureStatus,
    ...(amountCents ? { amountCents } : {}),
    ...(paypalFeeCents ? { paypalFeeCents } : {}),
  };
}

/** Applies the event's effect; returns whether the event is done (false while its capture is still PENDING). */
async function dispatch(db: Db, target: Target): Promise<boolean> {
  if (target.kind === "payout") {
    await dispatchPayoutOutcome(db, target.sendOperationId, target.observed);
    return true;
  }
  const result = await settleCheckoutByOrderId(db, target.worldId, target.orderId, {
    observedCapture: target.observedCapture,
  });
  return result.status !== "PENDING";
}

export async function handlePayPalWebhook(req: Request, getDb: () => Promise<Db>): Promise<NextResponse> {
  const contentType = (req.headers.get("content-type") ?? "").toLowerCase();
  if (!contentType.startsWith("application/json")) {
    return json({ error: "content_type_must_be_application_json" }, 400);
  }
  const declared = Number(req.headers.get("content-length") ?? NaN);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return json({ error: "body_too_large" }, 413);
  }
  const raw = await readBodyLimited(req, MAX_BODY_BYTES);
  if (raw === null) {
    return json({ error: "body_too_large" }, 413);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const body = record(parsed);
  const id = str(body.id);
  const eventType = str(body.event_type);
  if (!id || !eventType) {
    return json({ error: "invalid_event" }, 400);
  }
  const event: PayPalEvent = { id, event_type: eventType, resource: body.resource };

  const db = await getDb();
  const known = await getWebhookEvent(db, id);
  if (known?.verified && known.processedAt) {
    return json({ received: true, duplicate: true }, 200);
  }

  const verification = await verifyWebhookSignature(req.headers, parsed);
  if (verification.outcome === "error") {
    console.error(`[paypal-webhook] could not verify event ${id}: ${verification.reason}`);
    return json({ error: "verification_unavailable" }, 503);
  }
  if (verification.outcome === "unverified") {
    await recordWebhookEvent(db, { paypalEventId: id, type: eventType, verified: false, payload: parsed, worldId: null });
    console.warn(`[paypal-webhook] event ${id} (${eventType}) failed verification: ${verification.reason}`);
    return json({ error: "unverified" }, 400);
  }

  const target = await resolveTarget(db, event);
  const stored = await recordWebhookEvent(db, {
    paypalEventId: id,
    type: eventType,
    verified: true,
    payload: parsed,
    worldId: target?.worldId ?? null,
  });
  if (!stored.process) {
    return json({ received: true, duplicate: true }, 200);
  }

  // Fix round 1 (M6): two concurrent deliveries of the same event id can
  // both get here (both see it unprocessed). That is safe ONLY because
  // every effect dispatched below is idempotent — payout appliers and
  // capture handlers apply once via conditional status updates + journal
  // idempotency keys — so the second delivery is a no-op, not a double.
  let done = true;
  if (target) {
    try {
      done = await dispatch(db, target);
    } catch (err) {
      console.error(`[paypal-webhook] event ${id} (${eventType}) failed: ${errorMessage(err)}`);
      return json({ error: "processing_failed" }, 500);
    }
  }
  if (done) {
    await markWebhookEventProcessed(db, stored.row.id);
  }
  return json({ received: true, ...(done ? {} : { pending: true }) }, 200);
}

/** The route's handlers, with the database resolver injected (tests pass a PGlite db). */
export function createPayPalWebhookHandler({ getDb }: { getDb: () => Promise<Db> }) {
  return { POST: (req: Request) => handlePayPalWebhook(req, getDb) };
}
