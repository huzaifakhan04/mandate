import { and, eq } from "drizzle-orm";

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
 * operation's own purpose. All three callbacks are required together: a
 * registration with no way to check ownership or report failure is
 * worse than no registration (I4, "fail closed" — see
 * `beginConfirmCheckout`/`finalizeConfirmCheckout` below).
 */
export type CaptureApplyResult =
  | { outcome: "applied"; summary: string; data: Record<string, unknown> }
  | { outcome: "mismatch"; reason: string };

export interface CaptureHandlerDef {
  /** Resolves the agent that owns the checkout's source row, or `null` if it doesn't exist. */
  resolveOwnerAgentId(db: Db, worldId: string, createSourceId: string): Promise<string | null>;
  /**
   * Applies the capture's domain effect exactly once (keyed by
   * `journalKey(capturePurpose, orderId)` — never the capture operation
   * id, per the "ALREADY_CAPTURED recovery treats any capture as
   * success" carry-forward). Safe to call again on every replay/retry;
   * implementations must no-op past the first successful application.
   * Fix round 1 (M2): implementations must verify the captured amount
   * (and currency, where applicable) matches the expected amount before
   * crediting anything, returning `{ outcome: "mismatch" }` instead.
   */
  applyEffect(
    db: Db,
    worldId: string,
    simNow: Date,
    args: { createSourceId: string; orderId: string; capture: OrderCaptureResult },
  ): Promise<CaptureApplyResult>;
  /**
   * Fix round 1 (I3): marks the checkout's source row failed — called
   * when the capture operation terminally fails, or the order is
   * `VOIDED`. Must be idempotent (safe to call more than once for the
   * same checkout) and must never credit anything.
   */
  applyFailure(
    db: Db,
    worldId: string,
    args: { createSourceId: string; orderId: string; reason: string },
  ): Promise<void>;
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

/**
 * Re-executes a stalled `order.create` operation (the `awaiting_create`
 * outcome of `beginConfirmCheckout`) and returns its approve URL once it
 * succeeds — the `confirm_checkout` retry path Ruling K calls for when
 * `buy_notes`'s own `finalize` couldn't get one.
 */
export async function finalizeAwaitingCreate(
  db: Db,
  createOperationId: string,
): Promise<FinalizeConfirmCheckoutResult> {
  const result = await executeOperation(db, createOperationId, { ignoreBackoff: true });
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

/** Applies a successful capture's effect (M2's amount/currency check lives in the handler itself). */
async function applyCapturedEffect(
  db: Db,
  worldId: string,
  simNow: Date,
  handler: CaptureHandlerDef,
  args: { createSourceId: string; orderId: string },
  capture: OrderCaptureResult,
): Promise<FinalizeConfirmCheckoutResult> {
  const effect = await handler.applyEffect(db, worldId, simNow, {
    createSourceId: args.createSourceId,
    orderId: args.orderId,
    capture,
  });

  if (effect.outcome === "mismatch") {
    return {
      status: "CHECKOUT_FAILED",
      summary: `Captured amount didn't match what was expected (${effect.reason}).`,
      reasonCodes: ["amount_mismatch"],
      data: { checkout_id: args.orderId },
    };
  }

  return {
    status: "COMPLETED",
    summary: effect.summary,
    reasonCodes: [],
    data: { checkout_id: args.orderId, ...effect.data },
  };
}

/**
 * The post-commit half of `confirm_checkout`. Fix round 1 (M3): if the
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
 * made. A `VOIDED` order fails the checkout outright (Fix round 1, I3),
 * same as a terminally failed capture. Never call this inside a
 * transaction.
 */
export async function finalizeConfirmCheckout(
  db: Db,
  worldId: string,
  simNow: Date,
  args: {
    checkoutPurpose: OperationPurpose;
    createSourceId: string;
    orderId: string;
    rail: OperationRail;
  },
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
    const capture = existingCaptureOp.response as OrderCaptureResult;
    return applyCapturedEffect(db, worldId, simNow, handler, args, capture);
  }

  if (existingCaptureOp?.status === "failed_terminal") {
    const reason = providerReason((existingCaptureOp.response as OperationError | null)?.error);
    await handler.applyFailure(db, worldId, { createSourceId: args.createSourceId, orderId: args.orderId, reason });
    return {
      status: "CHECKOUT_FAILED",
      summary: `This checkout could not be completed (${reason}).`,
      reasonCodes: ["checkout_failed", reason],
      data: { checkout_id: args.orderId },
    };
  }

  const { operationId: getOpId } = await enqueueReadOperation(db, {
    worldId,
    rail: args.rail,
    kind: "order.get",
    request: buildGetOrderRequest(args.orderId),
  });
  const getResult = await executeOperation(db, getOpId, { ignoreBackoff: true });

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
    await handler.applyFailure(db, worldId, {
      createSourceId: args.createSourceId,
      orderId: args.orderId,
      reason: "order_voided",
    });
    return {
      status: "CHECKOUT_FAILED",
      summary: "This checkout was voided.",
      reasonCodes: ["checkout_failed", "order_voided"],
      data: { checkout_id: args.orderId },
    };
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
    return applyCapturedEffect(db, worldId, simNow, handler, args, successBody(result, "order.capture"));
  }

  if (result.status === "failed_terminal") {
    const reason = providerReason(errorBody(result));
    await handler.applyFailure(db, worldId, { createSourceId: args.createSourceId, orderId: args.orderId, reason });
    return {
      status: "CHECKOUT_FAILED",
      summary: `This checkout could not be completed (${reason}).`,
      reasonCodes: ["checkout_failed", reason],
      data: { checkout_id: args.orderId },
    };
  }

  return {
    status: "PENDING",
    summary: "Capture is still pending; retry shortly.",
    reasonCodes: [],
    data: { checkout_id: args.orderId },
  };
}
