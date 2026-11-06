import { and, eq } from "drizzle-orm";

import { getSimNow } from "../clock/clock";
import type { NextAction } from "../contracts/envelope";
import type { Db } from "../db/client";
import { paypalOperations } from "../db/schema";
import { scoped } from "../db/scoped";
import {
  buildCaptureOrderRequest,
  buildGetOrderRequest,
  deriveOperationId,
  enqueueOperation,
  enqueueReadOperation,
  errorBody,
  executeOperation,
  successBody,
  type OperationError,
  type OperationPurpose,
  type OperationRail,
  type OrderCaptureResult,
  type OrderCreateResult,
} from "../paypal/operations";

/**
 * `confirm_checkout` dispatch (Task 5 brief, Fix round 1 I4): services
 * register one handler per *checkout* purpose — the purpose the
 * `order.create` operation was enqueued under (`note_purchase`, and
 * later Task 7's `repayment_link`/`repayment_direct`) — not the capture
 * operation's own purpose. All four callbacks are required together: a
 * registration with no way to check ownership, report failure, or point
 * the caller at a retry is worse than no registration (I4, "fail
 * closed" — see `beginConfirmCheckout`/`finalizeConfirmCheckout` below).
 */
export type CaptureApplyResult =
  | { outcome: "applied"; summary: string; data: Record<string, unknown> }
  | { outcome: "mismatch"; reason: string }
  | { outcome: "failed"; reason: string };

export interface CaptureHandlerDef {
  /** Resolves the agent that owns the checkout's source row, or `null` if it doesn't exist. */
  resolveOwnerAgentId(db: Db, worldId: string, createSourceId: string): Promise<string | null>;
  /**
   * Applies a `COMPLETED` capture's domain effect exactly once (keyed by
   * `journalKey(capturePurpose, orderId)` — never the capture operation
   * id, per the "ALREADY_CAPTURED recovery treats any capture as
   * success" carry-forward). Only ever called once
   * `capture.captureStatus === 'COMPLETED'` (Fix round 2, item 3) —
   * `PENDING`/`DECLINED`/other capture statuses are handled by
   * `finalizeConfirmCheckout` itself, before this is reached. Safe to
   * call again on every replay/retry; implementations must no-op past
   * the first successful application, and must correctly re-derive
   * their result for a transaction they find already settled (Fix round
   * 2, item 1 — `completed` → `applied`, `review` → `mismatch`, `failed`
   * → `failed`, never a blanket "applied"). Fix round 1 (M2):
   * implementations must verify the captured amount (and currency,
   * where applicable) matches the expected amount before crediting
   * anything, returning `{ outcome: "mismatch" }` instead.
   */
  applyEffect(
    db: Db,
    worldId: string,
    simNow: Date,
    args: { createSourceId: string; orderId: string; capture: OrderCaptureResult },
  ): Promise<CaptureApplyResult>;
  /**
   * Fix round 1 (I3): marks the checkout's source row failed — called
   * when the capture operation terminally fails, the order is `VOIDED`,
   * looking the order up terminally fails (Fix round 2, item 5), or the
   * capture itself reports a non-`PENDING`, non-`COMPLETED` status (Fix
   * round 2, item 3, e.g. `DECLINED`). Must be idempotent (safe to call
   * more than once for the same checkout) and must never credit
   * anything.
   */
  applyFailure(
    db: Db,
    worldId: string,
    args: { createSourceId: string; orderId: string; reason: string },
  ): Promise<void>;
  /**
   * Fix round 2 (item 4): the next action to hand the caller once this
   * checkout has failed for good — e.g. `{ tool: "buy_notes", args: {
   * amount_cents } }` with the *original* amount, so retrying doesn't
   * require the caller to remember it.
   */
  retryNextAction(db: Db, worldId: string, createSourceId: string): Promise<NextAction>;
}

const captureHandlers = new Map<string, CaptureHandlerDef>();

/** Registers the handler for a checkout purpose (the `order.create` operation's `purpose`). */
export function registerCaptureHandler(purpose: OperationPurpose, def: CaptureHandlerDef): void {
  captureHandlers.set(purpose, def);
}

export function getCaptureHandler(purpose: string): CaptureHandlerDef | undefined {
  return captureHandlers.get(purpose);
}

/** Test-only: clears every registration, so a test module can register its own fixture handler. */
export function __resetCaptureHandlersForTests(): void {
  captureHandlers.clear();
}

/** The real capture operation's purpose for each checkout purpose (Global Constraints' purpose list). */
const CAPTURE_PURPOSE_FOR_CHECKOUT_PURPOSE: Partial<Record<OperationPurpose, OperationPurpose>> = {
  note_purchase: "note_purchase_capture",
  repayment_link: "repayment_capture",
  repayment_direct: "repayment_capture",
};

type OperationRow = typeof paypalOperations.$inferSelect;

async function findCreateOpByOrderId(
  tx: Db,
  worldId: string,
  orderId: string,
): Promise<OperationRow | undefined> {
  return scoped(tx, worldId).findOne(
    paypalOperations,
    and(eq(paypalOperations.kind, "order.create"), eq(paypalOperations.paypalId, orderId))!,
  );
}

/**
 * Fallback for a `checkout_id` that isn't (yet) a real PayPal/sim order
 * id: every registered checkout purpose derives its `order.create`
 * operation id deterministically from `(worldId, purpose, sourceId)`, so
 * trying `checkoutId` as a `sourceId` against each registered purpose
 * finds a still-creating checkout (Ruling K: `confirm_checkout`
 * re-executes a stalled `order.create`).
 */
async function findCreateOpBySourceId(
  tx: Db,
  worldId: string,
  sourceId: string,
): Promise<OperationRow | undefined> {
  for (const purpose of captureHandlers.keys()) {
    const operationId = deriveOperationId(worldId, purpose as OperationPurpose, sourceId);
    const row = await scoped(tx, worldId).findOne(
      paypalOperations,
      and(eq(paypalOperations.id, operationId), eq(paypalOperations.kind, "order.create"))!,
    );
    if (row) {
      return row;
    }
  }
  return undefined;
}

export type BeginConfirmCheckoutOutcome =
  | { outcome: "not_found" }
  | {
      outcome: "awaiting_create";
      checkoutPurpose: OperationPurpose;
      createSourceId: string;
      createOperationId: string;
    }
  | {
      outcome: "found";
      checkoutPurpose: OperationPurpose;
      createSourceId: string;
      orderId: string;
      rail: OperationRail;
    };

/**
 * The transactional half of `confirm_checkout` (Ruling K): finds which
 * checkout `checkoutId` belongs to and verifies the caller agent owns
 * it. Deliberately does *not* enqueue the capture yet: whether a capture
 * attempt is even safe to make depends on the order's current status
 * (checked in `finalizeConfirmCheckout`, post-commit) — attempting a
 * capture before the order is `APPROVED` gets a terminal
 * `ORDER_NOT_APPROVED`, which would permanently poison the capture
 * operation's id (deterministically derived from `(purpose, orderId)`,
 * so it can never be re-enqueued for a later, successful attempt).
 *
 * Fix round 1 (I4, "fail closed"): a checkout purpose with no registered
 * handler is `not_found` — there both the ownership check AND any future
 * failure/settlement path would be undefined, so it's refused outright
 * rather than captured-and-stored-for-later.
 */
export async function beginConfirmCheckout(
  tx: Db,
  worldId: string,
  agentId: string,
  checkoutId: string,
): Promise<BeginConfirmCheckoutOutcome> {
  let createOp = await findCreateOpByOrderId(tx, worldId, checkoutId);
  let viaSourceFallback = false;
  if (!createOp) {
    createOp = await findCreateOpBySourceId(tx, worldId, checkoutId);
    viaSourceFallback = true;
  }

  if (!createOp || !createOp.purpose || !createOp.sourceId) {
    return { outcome: "not_found" };
  }

  const checkoutPurpose = createOp.purpose as OperationPurpose;
  const handler = getCaptureHandler(checkoutPurpose);
  if (!handler) {
    return { outcome: "not_found" };
  }

  const ownerAgentId = await handler.resolveOwnerAgentId(tx, worldId, createOp.sourceId);
  if (ownerAgentId !== agentId) {
    return { outcome: "not_found" };
  }

  if (viaSourceFallback && createOp.status !== "succeeded") {
    return {
      outcome: "awaiting_create",
      checkoutPurpose,
      createSourceId: createOp.sourceId,
      createOperationId: createOp.id,
    };
  }

  const orderId = viaSourceFallback ? (createOp.paypalId ?? checkoutId) : checkoutId;
  const capturePurpose = CAPTURE_PURPOSE_FOR_CHECKOUT_PURPOSE[checkoutPurpose];
  if (!capturePurpose) {
    return { outcome: "not_found" };
  }

  return {
    outcome: "found",
    checkoutPurpose,
    createSourceId: createOp.sourceId,
    orderId,
    rail: createOp.rail as OperationRail,
  };
}

export interface FinalizeConfirmCheckoutResult {
  status: string;
  summary: string;
  reasonCodes: string[];
  data: Record<string, unknown>;
  approveUrl?: string;
  checkoutId?: string;
  /** Fix round 2 (item 4): set on `CHECKOUT_FAILED` — where to retry from scratch. */
  nextAction?: NextAction;
}

async function approveUrlForOrder(db: Db, worldId: string, orderId: string): Promise<string | null> {
  const createOp = await findCreateOpByOrderId(db, worldId, orderId);
  const body = createOp?.response as OrderCreateResult | null | undefined;
  return body && typeof body === "object" && "approveUrl" in body ? (body.approveUrl as string) : null;
}

/** Human-readable provider reason string for a terminal failure, for the `CHECKOUT_FAILED` envelope. */
function providerReason(error: OperationError["error"] | null | undefined): string {
  if (!error) {
    return "unknown";
  }
  return error.issue ?? error.name;
}

async function checkoutFailed(
  db: Db,
  worldId: string,
  handler: CaptureHandlerDef,
  args: { createSourceId: string; orderId: string },
  reason: string,
): Promise<FinalizeConfirmCheckoutResult> {
  await handler.applyFailure(db, worldId, { createSourceId: args.createSourceId, orderId: args.orderId, reason });
  return {
    status: "CHECKOUT_FAILED",
    summary: `This checkout could not be completed (${reason}).`,
    reasonCodes: ["checkout_failed", reason],
    data: { checkout_id: args.orderId },
    nextAction: await handler.retryNextAction(db, worldId, args.createSourceId),
  };
}

/**
 * Re-executes a stalled `order.create` operation (the `awaiting_create`
 * outcome of `beginConfirmCheckout`) and returns its approve URL once it
 * succeeds — the `confirm_checkout` retry path Ruling K calls for when
 * `buy_notes`'s own `finalize` couldn't get one.
 *
 * Task 10b fix round 3 (I1): a create that ended `failed_terminal` (a
 * definite rejection, or given up on by the retry cap — Ruling V) can
 * never produce an order, so the checkout is failed: the handler's
 * `applyFailure` runs and the result is `CHECKOUT_FAILED` with the
 * handler's retry next action (the checkout id is the source id — there
 * is no order id).
 */
export async function finalizeAwaitingCreate(
  db: Db,
  worldId: string,
  args: { checkoutPurpose: OperationPurpose; createSourceId: string; createOperationId: string },
): Promise<FinalizeConfirmCheckoutResult> {
  const result = await executeOperation(db, args.createOperationId, { ignoreBackoff: true });
  if (result.status === "failed_terminal") {
    const handler = getCaptureHandler(args.checkoutPurpose);
    if (handler) {
      const reason = providerReason(errorBody(result));
      return checkoutFailed(db, worldId, handler, { createSourceId: args.createSourceId, orderId: args.createSourceId }, reason);
    }
  }
  if (result.status === "succeeded") {
    const body = successBody(result, "order.create");
    return {
      status: "AWAITING_APPROVAL",
      summary: "Checkout created. Approve it to continue.",
      reasonCodes: [],
      data: { checkout_id: body.orderId, approve_url: body.approveUrl },
      approveUrl: body.approveUrl,
      checkoutId: body.orderId,
    };
  }
  return {
    status: "PENDING",
    summary: "Checkout creation is still pending; retry shortly.",
    reasonCodes: [],
    data: {},
  };
}

/**
 * Dispatches an already-known capture result (whether freshly captured
 * or reused from an already-`succeeded` capture operation — Fix round 1
 * M3): Fix round 2 (item 3) gates on `capture.captureStatus` *before*
 * ever calling the handler's `applyEffect` — only `COMPLETED` credits
 * anything; `PENDING` stays `PENDING` (Task 8's cron re-checks later);
 * anything else (`DECLINED`, …) fails the checkout via `applyFailure`.
 */
async function dispatchCapturedResult(
  db: Db,
  worldId: string,
  simNow: Date,
  handler: CaptureHandlerDef,
  args: { createSourceId: string; orderId: string },
  capture: OrderCaptureResult,
): Promise<FinalizeConfirmCheckoutResult> {
  if (capture.captureStatus === "PENDING") {
    return {
      status: "PENDING",
      summary: "The capture is still settling on PayPal's side; retry shortly.",
      reasonCodes: [],
      data: { checkout_id: args.orderId },
    };
  }

  if (capture.captureStatus !== "COMPLETED") {
    return checkoutFailed(db, worldId, handler, args, `capture_${capture.captureStatus.toLowerCase()}`);
  }

  const effect = await handler.applyEffect(db, worldId, simNow, {
    createSourceId: args.createSourceId,
    orderId: args.orderId,
    capture,
  });

  if (effect.outcome === "mismatch") {
    return checkoutFailed(db, worldId, handler, args, "amount_mismatch");
  }
  if (effect.outcome === "failed") {
    return checkoutFailed(db, worldId, handler, args, effect.reason);
  }

  return {
    status: "COMPLETED",
    summary: effect.summary,
    reasonCodes: [],
    data: { checkout_id: args.orderId, ...effect.data },
  };
}

interface SettleCheckoutArgs {
  checkoutPurpose: OperationPurpose;
  createSourceId: string;
  orderId: string;
  rail: OperationRail;
  /** Fix round 1 (I1): a capture's status seen in a verified `PAYMENT.CAPTURE.*` webhook. */
  observedCapture?: ObservedCapture;
}

/** A capture's status (and amount, when given) as a verified webhook reported it. */
export interface ObservedCapture {
  captureId: string;
  captureStatus: string;
  amountCents?: string;
  /** Task 10b: `seller_receivable_breakdown.paypal_fee`, when the webhook resource carries it. */
  paypalFeeCents?: string;
}

/**
 * Fix round 1 (I1): a capture operation's stored result is immutable, so a
 * capture first seen `PENDING` would stay PENDING forever. Re-observe it:
 * a verified webhook's status for the SAME capture id is used directly (no
 * GET); otherwise one `order.get` is made (the reconcile cron only gets
 * here once `isPollDue` allows a read of this order — the read is
 * recorded like every other order read) and, if the order's capture is the
 * same capture, its fresh status/amount are used. Anything else → the
 * stored PENDING result unchanged (still pending).
 */
async function reobservePendingCapture(
  db: Db,
  worldId: string,
  args: SettleCheckoutArgs,
  stored: OrderCaptureResult,
): Promise<OrderCaptureResult> {
  const observed = args.observedCapture;
  if (observed && observed.captureId === stored.captureId) {
    return {
      ...stored,
      captureStatus: observed.captureStatus,
      amountCents: observed.amountCents ?? stored.amountCents,
      paypalFeeCents: observed.paypalFeeCents ?? stored.paypalFeeCents ?? null,
    };
  }
  const { operationId } = await enqueueReadOperation(db, {
    worldId,
    rail: args.rail,
    kind: "order.get",
    request: buildGetOrderRequest(args.orderId),
  });
  const read = await executeOperation(db, operationId, { ignoreBackoff: true });
  if (read.status !== "succeeded") {
    return stored;
  }
  const fresh = successBody(read, "order.get").capture;
  if (!fresh || fresh.captureId !== stored.captureId) {
    return stored;
  }
  // Task 10b: a PENDING capture has no fee breakdown yet; the fresh read's does.
  return {
    ...stored,
    captureStatus: fresh.captureStatus,
    amountCents: fresh.amountCents,
    paypalFeeCents: fresh.paypalFeeCents ?? stored.paypalFeeCents ?? null,
    grossCents: fresh.grossCents ?? stored.grossCents ?? null,
    netCents: fresh.netCents ?? stored.netCents ?? null,
  };
}

/**
 * The settlement core shared by `confirm_checkout` (after its ownership
 * check) and the agent-less `settleCheckoutByOrderId` (Ruling S — webhook
 * and reconcile cron). Fix round 1 (M3): if the
 * capture operation already exists and succeeded (a replay — including
 * two different `confirm_checkout` calls racing each other), its stored
 * result is reused directly with no new `order.get`/capture attempt. If
 * it already terminally failed, that failure is reported again (and
 * `applyFailure` re-run, which must itself be idempotent) with no new
 * attempt either. Only otherwise does this check the order's current
 * status with a read-only `order.get` first — only once that shows
 * `APPROVED` (or already `COMPLETED`, a race with another capture
 * attempt) does it enqueue+execute the capture, so an unapproved order's
 * capture attempt (which would terminally fail `ORDER_NOT_APPROVED` and
 * permanently poison the capture operation's deterministic id) is never
 * made. A `VOIDED` order, or an `order.get` that itself terminally fails
 * (Fix round 2, item 5 — e.g. a 404 `RESOURCE_NOT_FOUND`), fails the
 * checkout outright, same as a terminally failed capture. Never call
 * this inside a transaction.
 */
async function settleCheckout(
  db: Db,
  worldId: string,
  simNow: Date,
  args: SettleCheckoutArgs,
): Promise<FinalizeConfirmCheckoutResult> {
  const handler = getCaptureHandler(args.checkoutPurpose);
  const capturePurpose = CAPTURE_PURPOSE_FOR_CHECKOUT_PURPOSE[args.checkoutPurpose];
  if (!handler || !capturePurpose) {
    // Defensive only: `beginConfirmCheckout` already refused a checkout
    // purpose with no registered handler or no capture-purpose mapping.
    throw new Error(`No registered handler/capture-purpose for checkout purpose ${args.checkoutPurpose}`);
  }

  const captureOpId = deriveOperationId(worldId, capturePurpose, args.orderId);
  const existingCaptureOp = await scoped(db, worldId).findOne(
    paypalOperations,
    eq(paypalOperations.id, captureOpId),
  );

  if (existingCaptureOp?.status === "succeeded") {
    let capture = existingCaptureOp.response as OrderCaptureResult;
    if (capture.captureStatus === "PENDING") {
      capture = await reobservePendingCapture(db, worldId, args, capture);
    }
    return dispatchCapturedResult(db, worldId, simNow, handler, args, capture);
  }

  if (existingCaptureOp?.status === "failed_terminal") {
    const reason = providerReason((existingCaptureOp.response as OperationError | null)?.error);
    return checkoutFailed(db, worldId, handler, args, reason);
  }

  const { operationId: getOpId } = await enqueueReadOperation(db, {
    worldId,
    rail: args.rail,
    kind: "order.get",
    request: buildGetOrderRequest(args.orderId),
  });
  const getResult = await executeOperation(db, getOpId, { ignoreBackoff: true });

  if (getResult.status === "failed_terminal") {
    // Fix round 2 (item 5): a terminal lookup failure (e.g. 404
    // RESOURCE_NOT_FOUND — the order vanished or never existed on
    // PayPal's side) must not leave the checkout PENDING forever.
    const reason = providerReason(errorBody(getResult));
    return checkoutFailed(db, worldId, handler, args, reason);
  }

  if (getResult.status !== "succeeded") {
    return {
      status: "PENDING",
      summary: "Could not check this checkout's status; retry shortly.",
      reasonCodes: [],
      data: { checkout_id: args.orderId },
    };
  }

  const order = successBody(getResult, "order.get");

  if (order.status === "VOIDED") {
    return checkoutFailed(db, worldId, handler, args, "order_voided");
  }

  if (order.status !== "APPROVED" && order.status !== "COMPLETED") {
    const approveUrl = await approveUrlForOrder(db, worldId, args.orderId);
    return {
      status: "AWAITING_APPROVAL",
      summary: "This checkout has not been approved yet.",
      reasonCodes: ["order_not_approved"],
      data: { checkout_id: args.orderId, approve_url: approveUrl },
      approveUrl: approveUrl ?? undefined,
      checkoutId: args.orderId,
    };
  }

  const { operationId: captureOperationId } = await enqueueOperation(db, {
    worldId,
    rail: args.rail,
    kind: "order.capture",
    purpose: capturePurpose,
    sourceId: args.orderId,
    request: buildCaptureOrderRequest(args.orderId),
  });
  const result = await executeOperation(db, captureOperationId, { ignoreBackoff: true });

  if (result.status === "succeeded") {
    return dispatchCapturedResult(db, worldId, simNow, handler, args, successBody(result, "order.capture"));
  }

  if (result.status === "failed_terminal") {
    const reason = providerReason(errorBody(result));
    return checkoutFailed(db, worldId, handler, args, reason);
  }

  return {
    status: "PENDING",
    summary: "Capture is still pending; retry shortly.",
    reasonCodes: [],
    data: { checkout_id: args.orderId },
  };
}

/**
 * The post-commit half of `confirm_checkout`: `beginConfirmCheckout`
 * already verified (inside the call's transaction) that the calling agent
 * owns this checkout, so this is exactly the agent-less settlement
 * `settleCheckoutByOrderId` runs (Ruling S) — the same code path for an
 * agent confirming, a webhook, and the reconcile cron. Never call inside a
 * transaction.
 */
export async function finalizeConfirmCheckout(
  db: Db,
  worldId: string,
  simNow: Date,
  args: SettleCheckoutArgs,
): Promise<FinalizeConfirmCheckoutResult> {
  return settleCheckout(db, worldId, simNow, args);
}

/**
 * Task 10b fix round 3 (I1), for the reconcile cron: if the checkout's
 * `order.create` operation is `failed_terminal` (it will never produce an
 * order), fails the checkout via its handler's `applyFailure` (idempotent;
 * credits nothing) and returns `true`; otherwise `false`. Never call inside
 * a transaction.
 */
export async function failCheckoutWithTerminalCreate(
  db: Db,
  worldId: string,
  createOperationId: string,
): Promise<boolean> {
  const createOp = await scoped(db, worldId).findOne(paypalOperations, eq(paypalOperations.id, createOperationId));
  if (createOp?.kind !== "order.create" || createOp.status !== "failed_terminal" || !createOp.purpose || !createOp.sourceId) {
    return false;
  }
  const handler = getCaptureHandler(createOp.purpose);
  if (!handler) {
    return false;
  }
  const reason = providerReason((createOp.response as OperationError | null)?.error);
  await handler.applyFailure(db, worldId, { createSourceId: createOp.sourceId, orderId: createOp.sourceId, reason });
  return true;
}

/**
 * Ruling S: agent-less settlement of a checkout by its PayPal/sim order id
 * — for Task 8's webhook (`CHECKOUT.ORDER.APPROVED` /
 * `PAYMENT.CAPTURE.COMPLETED`) and reconcile cron, and Review Focus 3 (the
 * client pays an invoice link while no agent is online). Finds the
 * `order.create` operation that created the order, then runs the same
 * settlement as `confirm_checkout`: GET the order first (an unapproved
 * order is never captured — `AWAITING_APPROVAL`), capture once APPROVED,
 * gate on the capture status (only `COMPLETED` applies the handler's
 * effect; `PENDING` stays `PENDING`; anything else → `applyFailure`), and
 * fail closed (`NOT_FOUND`) for an unknown order or a checkout purpose
 * with no registered handler. Idempotent and safe to call concurrently
 * and repeatedly (the capture operation id is derived from the order id,
 * and every handler applies its effect exactly once). Never call inside
 * a transaction.
 */
export async function settleCheckoutByOrderId(
  db: Db,
  worldId: string,
  orderId: string,
  options: { observedCapture?: ObservedCapture } = {},
): Promise<FinalizeConfirmCheckoutResult> {
  const notFound: FinalizeConfirmCheckoutResult = {
    status: "NOT_FOUND",
    summary: "No checkout found for that order id.",
    reasonCodes: ["checkout_not_found"],
    data: { checkout_id: orderId },
  };
  const createOp = await findCreateOpByOrderId(db, worldId, orderId);
  if (!createOp?.purpose || !createOp.sourceId) {
    return notFound;
  }
  const checkoutPurpose = createOp.purpose as OperationPurpose;
  if (!getCaptureHandler(checkoutPurpose) || !CAPTURE_PURPOSE_FOR_CHECKOUT_PURPOSE[checkoutPurpose]) {
    return notFound;
  }
  const simNow = await getSimNow(db, worldId);
  return settleCheckout(db, worldId, simNow, {
    checkoutPurpose,
    createSourceId: createOp.sourceId,
    orderId,
    rail: createOp.rail as OperationRail,
    observedCapture: options.observedCapture,
  });
}
