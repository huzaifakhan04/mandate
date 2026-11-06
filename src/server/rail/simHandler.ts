import { and, eq, sql } from "drizzle-orm";

import type { Db } from "../db/client";
import { paypalOperations } from "../db/schema";
import { PayPalApiError } from "../paypal/fetch";
import { amountToCents, centsToAmount, orderIdFromPath } from "../paypal/orders";
import { batchIdFromPath, payoutItemIdFromCancelPath } from "../paypal/payouts";
import type { ExecutableRequest, OperationKind } from "../paypal/types";

/**
 * The sim rail's in-DB "PayPal": `executeOperation` calls `simHandle`
 * for a `rail = 'sim'` row exactly where it would call `paypalFetch`, and
 * gets back the same PayPal-shaped `{ httpStatus, body }` — so parsing,
 * classification, `ORDER_ALREADY_CAPTURED` recovery and every status
 * write are the same code path for both rails (Rulings F, H).
 *
 * State lives in `paypal_operations.sim_state` of the operation that
 * created the object (the `order.create` row holds the order, the
 * `payout.send` row holds the batch), never in memory, so it survives
 * across serverless instances. Every sim id is derived from the
 * operation's own id (no random ids), so a re-executed (reclaimed)
 * operation reproduces the same ids.
 *
 * Semantics (mirroring PayPal):
 * - `order.create` → 201, order `PAYER_ACTION_REQUIRED` with a
 *   `payer-action` link.
 * - `order.capture` → needs a prior `simApprove`; otherwise 422
 *   `ORDER_NOT_APPROVED` (→ `failed_terminal`). An already-captured order
 *   answers 422 `ORDER_ALREADY_CAPTURED`, which `executeOperation`
 *   recovers via `order.get` exactly as for PayPal. Unknown order → 404.
 * - `payout.send` → 201, batch accepted. A receiver containing `"fail"`
 *   gets item `transaction_status: "FAILED"` — the *operation* succeeds
 *   (PayPal accepted the batch) and the item failure is visible in the
 *   result, just as a live PayPal item later goes FAILED/UNCLAIMED while
 *   the POST itself returned 201. Outcome appliers must read the item
 *   status, not only the operation status. Sim items resolve instantly
 *   (no PENDING phase). A receiver containing `"unclaimed"` gets item
 *   `UNCLAIMED` (Ruling R: the receiver has no PayPal account yet). A
 *   receiver containing `"pending"` gets a live-shaped POST response
 *   (batch PENDING, no items) while `payout.get` shows the item (SUCCESS,
 *   or UNCLAIMED/FAILED if the receiver also says so).
 * - `payout.cancel_item` → an `UNCLAIMED` item becomes `RETURNED` (200,
 *   the item); cancelling an already-`RETURNED` item answers the same;
 *   any other item → 422 `ITEM_CANNOT_BE_CANCELLED`; unknown → 404.
 * - `order.get` / `payout.get` → 200 with the current state, or 404.
 *
 * Fees (Task 10b — SIMULATED, not PayPal's real pricing): a capture
 * reports `seller_receivable_breakdown` with a `paypal_fee` of 2.9% + 30¢
 * (2.9% rounded half-up to the cent, never more than the gross — see
 * `simCaptureFeeCents`); a payout batch reports `batch_header.fees` of 25¢
 * per item in `SUCCESS` (so 0 for FAILED/UNCLAIMED/RETURNED items, and no
 * `fees` at all in the live-shaped `"pending"` POST response). They exist
 * so tests exercise fee journaling on the sim rail.
 */

type SimOrderStatus = "PAYER_ACTION_REQUIRED" | "APPROVED" | "COMPLETED";

interface SimOrderState {
  orderId: string;
  status: SimOrderStatus;
  amountCents: string;
  captureId: string | null;
  /**
   * The capture's status (default `COMPLETED`). Test hook
   * `simSetCaptureStatus` sets it — before the capture (the capture then
   * answers with it) or after (later reads show it), to model PayPal's
   * PENDING captures that later complete or are denied.
   */
  captureStatus?: string;
}

type SimItemStatus = "SUCCESS" | "FAILED" | "UNCLAIMED" | "RETURNED";

interface SimPayoutState {
  batchId: string;
  senderBatchId: string | null;
  batchStatus: "SUCCESS";
  items: { itemId: string; transactionStatus: SimItemStatus; amountCents: string }[];
}

export interface SimRequest {
  worldId: string;
  operationId: string;
  kind: OperationKind;
  request: ExecutableRequest;
}

export interface SimResponse {
  httpStatus: number;
  body: unknown;
}

export class SimRailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SimRailError";
  }
}

const t = paypalOperations;

function paypalError(httpStatus: number, name: string, issue: string, message: string): SimResponse {
  return { httpStatus, body: { name, message, details: [{ issue }] } };
}

function notFound(what: string): SimResponse {
  return paypalError(404, "RESOURCE_NOT_FOUND", "INVALID_RESOURCE_ID", `${what} not found`);
}

function unprocessable(issue: string): SimResponse {
  return paypalError(422, "UNPROCESSABLE_ENTITY", issue, issue);
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function firstOf(value: unknown): Record<string, unknown> {
  return Array.isArray(value) ? record(value[0]) : {};
}

/** Writes `state` as this operation's `sim_state` unless it already has one; returns the stored state. */
async function initSimState<S>(db: Db, operationId: string, state: S): Promise<S> {
  const [row] = await db
    .update(t)
    .set({ simState: sql`coalesce(${t.simState}, ${JSON.stringify(state)}::jsonb)` })
    .where(eq(t.id, operationId))
    .returning();
  if (!row) {
    throw new SimRailError(`sim operation ${operationId} has no paypal_operations row`);
  }
  return row.simState as S;
}

async function findOrder(
  db: Db,
  orderId: string,
  worldId: string | null,
): Promise<{ id: string; state: SimOrderState } | undefined> {
  const [row] = await db
    .select({ id: t.id, simState: t.simState })
    .from(t)
    .where(
      and(
        worldId === null ? undefined : eq(t.worldId, worldId),
        eq(t.rail, "sim"),
        eq(t.kind, "order.create"),
        sql`${t.simState}->>'orderId' = ${orderId}`,
      ),
    )
    .limit(1);
  return row ? { id: row.id, state: row.simState as SimOrderState } : undefined;
}

/** Simulated capture fee: 2.9% (rounded half-up to the cent) + 30¢, capped at the gross. */
export function simCaptureFeeCents(grossCents: bigint): bigint {
  const fee = (grossCents * 29n + 500n) / 1000n + 30n;
  return fee > grossCents ? grossCents : fee;
}

/** Simulated payout fee: 25¢ per item in `SUCCESS`. */
const SIM_PAYOUT_ITEM_FEE_CENTS = 25n;

function usd(cents: bigint): { currency_code: string; value: string } {
  return { currency_code: "USD", value: centsToAmount(cents) };
}

function sellerReceivableBreakdown(grossCents: bigint): Record<string, unknown> {
  const fee = simCaptureFeeCents(grossCents);
  return { gross_amount: usd(grossCents), paypal_fee: usd(fee), net_amount: usd(grossCents - fee) };
}

function orderBody(state: SimOrderState): Record<string, unknown> {
  const amount = { currency_code: "USD", value: centsToAmount(BigInt(state.amountCents)) };
  const captureStatus = state.captureStatus ?? "COMPLETED";
  return {
    id: state.orderId,
    intent: "CAPTURE",
    status: state.status,
    purchase_units: [
      {
        amount,
        ...(state.captureId
          ? {
              payments: {
                captures: [
                  {
                    id: state.captureId,
                    status: captureStatus,
                    amount,
                    // Like PayPal, the fee breakdown appears once the capture has completed.
                    ...(captureStatus === "COMPLETED"
                      ? { seller_receivable_breakdown: sellerReceivableBreakdown(BigInt(state.amountCents)) }
                      : {}),
                  },
                ],
              },
            }
          : {}),
      },
    ],
    links: [
      {
        rel: "payer-action",
        href: `https://sim.paypal.local/checkoutnow?token=${encodeURIComponent(state.orderId)}`,
        method: "GET",
      },
    ],
  };
}

async function createOrder(db: Db, req: SimRequest): Promise<SimResponse> {
  const value = record(firstOf(record(req.request.body).purchase_units).amount).value;
  if (typeof value !== "string") {
    return paypalError(400, "INVALID_REQUEST", "MISSING_REQUIRED_PARAMETER", "amount.value is required");
  }
  const amountCents = amountToCents(value);
  if (amountCents <= 0n) {
    return unprocessable("CANNOT_BE_ZERO_OR_NEGATIVE");
  }
  const state = await initSimState<SimOrderState>(db, req.operationId, {
    orderId: `SIMORDER-${req.operationId}`,
    status: "PAYER_ACTION_REQUIRED",
    amountCents: amountCents.toString(),
    captureId: null,
  });
  return { httpStatus: 201, body: orderBody(state) };
}

async function captureOrder(db: Db, req: SimRequest): Promise<SimResponse> {
  const orderId = orderIdFromPath(req.request.path);
  const order = await findOrder(db, orderId, req.worldId);
  if (!order) {
    return notFound(`order ${orderId}`);
  }
  if (order.state.status === "COMPLETED") {
    return unprocessable("ORDER_ALREADY_CAPTURED");
  }
  if (order.state.status !== "APPROVED") {
    return unprocessable("ORDER_NOT_APPROVED");
  }

  const next: SimOrderState = {
    ...order.state,
    status: "COMPLETED",
    captureId: `SIMCAPTURE-${req.operationId}`,
  };
  // Conditional transition: of two concurrent captures only one moves
  // APPROVED → COMPLETED; the other sees ORDER_ALREADY_CAPTURED and
  // recovers the winner's capture, like PayPal.
  const [updated] = await db
    .update(t)
    .set({ simState: next })
    .where(and(eq(t.id, order.id), sql`${t.simState}->>'status' = 'APPROVED'`))
    .returning();
  if (!updated) {
    return unprocessable("ORDER_ALREADY_CAPTURED");
  }
  return { httpStatus: 201, body: orderBody(next) };
}

async function getOrder(db: Db, req: SimRequest): Promise<SimResponse> {
  const orderId = orderIdFromPath(req.request.path);
  const order = await findOrder(db, orderId, req.worldId);
  return order ? { httpStatus: 200, body: orderBody(order.state) } : notFound(`order ${orderId}`);
}

function payoutBody(state: SimPayoutState): Record<string, unknown> {
  const succeeded = BigInt(state.items.filter((item) => item.transactionStatus === "SUCCESS").length);
  return {
    batch_header: {
      payout_batch_id: state.batchId,
      batch_status: state.batchStatus,
      sender_batch_header: { sender_batch_id: state.senderBatchId },
      fees: { currency: "USD", value: centsToAmount(succeeded * SIM_PAYOUT_ITEM_FEE_CENTS) },
    },
    items: state.items.map((item) => ({
      payout_item_id: item.itemId,
      transaction_status: item.transactionStatus,
      payout_batch_id: state.batchId,
    })),
  };
}

async function sendPayout(db: Db, req: SimRequest): Promise<SimResponse> {
  const body = record(req.request.body);
  const item = firstOf(body.items);
  const value = record(item.amount).value;
  if (typeof item.receiver !== "string" || typeof value !== "string") {
    return paypalError(400, "VALIDATION_ERROR", "MISSING_REQUIRED_PARAMETER", "receiver and amount.value are required");
  }
  const amountCents = amountToCents(value);
  if (amountCents <= 0n) {
    return paypalError(400, "VALIDATION_ERROR", "INVALID_AMOUNT", "amount must be positive");
  }
  const senderBatchId = record(body.sender_batch_header).sender_batch_id;
  const state = await initSimState<SimPayoutState>(db, req.operationId, {
    batchId: `SIMBATCH-${req.operationId}`,
    senderBatchId: typeof senderBatchId === "string" ? senderBatchId : null,
    batchStatus: "SUCCESS",
    items: [
      {
        itemId: `SIMITEM-${req.operationId}`,
        transactionStatus: item.receiver.includes("fail")
          ? "FAILED"
          : item.receiver.includes("unclaimed")
            ? "UNCLAIMED"
            : "SUCCESS",
        amountCents: amountCents.toString(),
      },
    ],
  });
  if (item.receiver.includes("pending")) {
    // Live-shaped: PayPal's POST usually reports only the batch header
    // (PENDING) and no items; the item's real status is visible only via
    // payout.get (or a webhook).
    const full = payoutBody(state);
    // No `fees` either: like PayPal's POST, the fee shows up only via payout.get.
    const header = { ...(full.batch_header as Record<string, unknown>) };
    delete header.fees;
    return {
      httpStatus: 201,
      body: { batch_header: { ...header, batch_status: "PENDING" } },
    };
  }
  return { httpStatus: 201, body: payoutBody(state) };
}

async function getPayout(db: Db, req: SimRequest): Promise<SimResponse> {
  const batchId = batchIdFromPath(req.request.path);
  const [row] = await db
    .select({ simState: t.simState })
    .from(t)
    .where(
      and(
        eq(t.worldId, req.worldId),
        eq(t.rail, "sim"),
        eq(t.kind, "payout.send"),
        sql`${t.simState}->>'batchId' = ${batchId}`,
      ),
    )
    .limit(1);
  return row
    ? { httpStatus: 200, body: payoutBody(row.simState as SimPayoutState) }
    : notFound(`payout batch ${batchId}`);
}

async function cancelPayoutItem(db: Db, req: SimRequest): Promise<SimResponse> {
  const itemId = payoutItemIdFromCancelPath(req.request.path);
  const [row] = await db
    .select({ id: t.id, simState: t.simState })
    .from(t)
    .where(
      and(
        eq(t.worldId, req.worldId),
        eq(t.rail, "sim"),
        eq(t.kind, "payout.send"),
        sql`${t.simState}->'items' @> ${JSON.stringify([{ itemId }])}::jsonb`,
      ),
    )
    .limit(1);
  if (!row) {
    return notFound(`payout item ${itemId}`);
  }
  const state = row.simState as SimPayoutState;
  const item = state.items.find((candidate) => candidate.itemId === itemId)!;
  const itemBody = (status: SimItemStatus) => ({
    payout_item_id: itemId,
    payout_batch_id: state.batchId,
    transaction_status: status,
  });
  if (item.transactionStatus === "RETURNED") {
    return { httpStatus: 200, body: itemBody("RETURNED") };
  }
  if (item.transactionStatus !== "UNCLAIMED") {
    return unprocessable("ITEM_CANNOT_BE_CANCELLED");
  }
  const next: SimPayoutState = {
    ...state,
    items: state.items.map((candidate) =>
      candidate.itemId === itemId ? { ...candidate, transactionStatus: "RETURNED" } : candidate,
    ),
  };
  await db.update(t).set({ simState: next }).where(eq(t.id, row.id));
  return { httpStatus: 200, body: itemBody("RETURNED") };
}

/** Test/bot helper: a sim UNCLAIMED item is claimed by its receiver (→ SUCCESS). */
export async function simClaimPayoutItem(db: Db, itemId: string): Promise<void> {
  const [row] = await db
    .select({ id: t.id, simState: t.simState })
    .from(t)
    .where(and(eq(t.rail, "sim"), sql`${t.simState}->'items' @> ${JSON.stringify([{ itemId }])}::jsonb`))
    .limit(1);
  if (!row) {
    throw new SimRailError(`Unknown sim payout item ${itemId}`);
  }
  const state = row.simState as SimPayoutState;
  await db
    .update(t)
    .set({
      simState: {
        ...state,
        items: state.items.map((item) =>
          item.itemId === itemId && item.transactionStatus === "UNCLAIMED"
            ? { ...item, transactionStatus: "SUCCESS" }
            : item,
        ),
      } satisfies SimPayoutState,
    })
    .where(eq(t.id, row.id));
}

/** The sim rail's transport, dispatched by operation kind. Only `executeOperation` calls this. */
export async function simHandle(db: Db, req: SimRequest): Promise<SimResponse> {
  switch (req.kind) {
    case "order.create":
      return createOrder(db, req);
    case "order.capture":
      return captureOrder(db, req);
    case "order.get":
      return getOrder(db, req);
    case "payout.send":
      return sendPayout(db, req);
    case "payout.get":
      return getPayout(db, req);
    case "payout.cancel_item":
      return cancelPayoutItem(db, req);
  }
}

/**
 * Test/bot hook: sets a sim order's capture status (see
 * `SimOrderState.captureStatus`). Throws for an unknown order.
 */
export async function simSetCaptureStatus(db: Db, orderId: string, captureStatus: string): Promise<void> {
  const order = await findOrder(db, orderId, null);
  if (!order) {
    throw new SimRailError(`Unknown sim order ${orderId}`);
  }
  await db
    .update(t)
    .set({ simState: { ...order.state, captureStatus } satisfies SimOrderState })
    .where(eq(t.id, order.id));
}

/**
 * Test/bot helper standing in for the payer clicking "approve": moves a
 * sim order `PAYER_ACTION_REQUIRED → APPROVED`. It takes no `worldId`
 * (sim order ids embed the creating operation's UUID, so they're globally
 * unique) and must never be reachable from an agent/tool call.
 * Re-approving throws a PayPal-shaped `ORDER_ALREADY_APPROVED` /
 * `ORDER_ALREADY_CAPTURED`, so approve → capture → approve can't reopen
 * a captured order.
 */
export async function simApprove(db: Db, orderId: string): Promise<void> {
  const order = await findOrder(db, orderId, null);
  if (!order) {
    throw new SimRailError(`Unknown sim order ${orderId}`);
  }

  const [updated] = await db
    .update(t)
    .set({ simState: { ...order.state, status: "APPROVED" } satisfies SimOrderState })
    .where(and(eq(t.id, order.id), sql`${t.simState}->>'status' = 'PAYER_ACTION_REQUIRED'`))
    .returning();
  if (updated) {
    return;
  }

  const current = await findOrder(db, orderId, null);
  const issue =
    current?.state.status === "COMPLETED" ? "ORDER_ALREADY_CAPTURED" : "ORDER_ALREADY_APPROVED";
  throw new PayPalApiError({ status: 422, name: issue, details: { orderId } });
}
