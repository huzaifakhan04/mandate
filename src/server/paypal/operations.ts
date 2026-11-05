import { and, eq, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";

import type { Db } from "../db/client";
import { paypalOperations } from "../db/schema";
import { PayPalApiError, PayPalOperationReuseError, paypalFetch } from "./fetch";
import { deriveOperationId, type OperationPurpose } from "./operationId";
import * as orders from "./orders";
import { redact } from "./redact";

export type { OperationPurpose } from "./operationId";

type OperationRow = typeof paypalOperations.$inferSelect;

export interface ExecutableRequest {
  method: "GET" | "POST" | "PATCH";
  path: string;
  body?: unknown;
}

export interface EnqueueOperationParams {
  worldId: string;
  rail: "paypal" | "sim";
  kind: string;
  purpose: OperationPurpose;
  sourceId: string;
  request: ExecutableRequest;
}

export interface EnqueueOperationResult {
  operationId: string;
}

/**
 * Inserts a `queued` `paypal_operations` row for a logical operation,
 * keyed by `deriveOperationId(worldId, purpose, sourceId)` rather than a
 * random id — so calling this twice for the same logical operation
 * (e.g. the same note purchase retried from an outer transaction)
 * always resolves to the same row instead of creating a second one.
 *
 * Must be called from inside the domain transaction that creates the
 * corresponding domain rows (e.g. the note/loan/repayment), and ONLY
 * from inside that transaction — `enqueueOperation` never calls PayPal
 * and is safe to run under `tx`. The caller then schedules the actual
 * PayPal call with `ctx.afterCommit(() => executeOperation(ctx.db,
 * operationId))`, after the transaction (and so the domain rows) have
 * committed.
 *
 * A derived id that already names a row for a *different* `rail`/`kind`
 * throws `PayPalOperationReuseError` — that would mean two different
 * logical operations collided on the same `(worldId, purpose,
 * sourceId)`, which should never happen for distinct purposes/sourceIds
 * (see `operationId.ts`).
 */
export async function enqueueOperation(
  tx: Db,
  params: EnqueueOperationParams,
): Promise<EnqueueOperationResult> {
  const operationId = deriveOperationId(
    params.worldId,
    params.purpose,
    params.sourceId,
  );

  const [inserted] = await tx
    .insert(paypalOperations)
    .values({
      id: operationId,
      worldId: params.worldId,
      rail: params.rail,
      kind: params.kind,
      requestId: operationId,
      status: "queued",
      purpose: params.purpose,
      sourceId: params.sourceId,
      attempts: 0,
      request: redact(params.request),
      executableRequest: params.request,
    })
    .onConflictDoNothing({ target: paypalOperations.id })
    .returning();

  if (inserted) {
    return { operationId: inserted.id };
  }

  // The row already existed — this is a re-enqueue of the same logical
  // operation (same worldId/purpose/sourceId derive the same id).
  const [existing] = await tx
    .select()
    .from(paypalOperations)
    .where(
      and(
        eq(paypalOperations.id, operationId),
        eq(paypalOperations.worldId, params.worldId),
      ),
    );

  if (!existing) {
    throw new PayPalOperationReuseError(
      `operationId ${operationId} belongs to a different world, or vanished after a conflicting insert — refusing to reuse it`,
    );
  }

  if (existing.rail !== params.rail || existing.kind !== params.kind) {
    throw new PayPalOperationReuseError(
      `operationId ${operationId} (derived from worldId=${params.worldId}, purpose=${params.purpose}, sourceId=${params.sourceId}) was already used for a different operation (rail=${existing.rail}, kind=${existing.kind}); refusing to reuse it for rail=${params.rail}, kind=${params.kind}`,
    );
  }

  return { operationId: existing.id };
}

export interface OperationResult {
  status: string;
  body: unknown;
  httpStatus: number | null;
}

function toOperationResult(row: OperationRow): OperationResult {
  return { status: row.status, body: row.response, httpStatus: row.httpStatus };
}

/** Extracts the `orderId` from an `order.capture` request path (`/v2/checkout/orders/{orderId}/capture`). */
function extractOrderIdFromCapturePath(path: string): string | null {
  const match = /\/v2\/checkout\/orders\/([^/]+)\/capture$/.exec(path);
  return match ? decodeURIComponent(match[1] as string) : null;
}

/**
 * Executes the claimed PayPal-rail row. For most kinds this is a plain
 * `paypalFetch` replay of the stored `executable_request`. `order.capture`
 * gets special handling: a `422 ORDER_ALREADY_CAPTURED` (this capture, or
 * an earlier attempt for the same operation, already went through) is
 * recovered via `orders.capture`'s own GET-and-recover path and the
 * *original* row — which `paypalFetch` would otherwise have just marked
 * `failed_terminal` — is corrected to `succeeded` with the recovered
 * capture as its response. This is the capture-idempotency guarantee:
 * replaying an `order.capture` operation, however many times, never
 * re-sends money and always eventually reads back as `succeeded`.
 */
async function executePaypalOperation(db: Db, row: OperationRow): Promise<OperationResult> {
  const executableRequest = row.executableRequest as ExecutableRequest | null;
  if (!executableRequest) {
    throw new Error(
      `paypal_operations row ${row.id} has rail='paypal' but no executable_request to replay`,
    );
  }

  if (row.kind === "order.capture") {
    const orderId = extractOrderIdFromCapturePath(executableRequest.path);
    if (orderId) {
      try {
        const result = await orders.capture(db, {
          worldId: row.worldId,
          orderId,
          operationId: row.id,
        });
        // `orders.capture` already wrote the row to `succeeded` via
        // `paypalFetch` on the normal (non-recovery) path. On the
        // recovery path (ORDER_ALREADY_CAPTURED -> GET), `paypalFetch`
        // left the *original* capture row `failed_terminal` — correct
        // it here, since the capture did in fact succeed.
        await db
          .update(paypalOperations)
          .set({ status: "succeeded", httpStatus: 200, response: redact(result) })
          .where(and(eq(paypalOperations.id, row.id), ne(paypalOperations.status, "succeeded")));
        return { status: "succeeded", body: result, httpStatus: 200 };
      } catch (err) {
        return readTerminalRowResult(db, row.id, err);
      }
    }
  }

  try {
    const result = await paypalFetch(db, {
      worldId: row.worldId,
      kind: row.kind,
      method: executableRequest.method,
      path: executableRequest.path,
      body: executableRequest.body,
      operationId: row.id,
    });
    return { status: "succeeded", body: result.body, httpStatus: result.status };
  } catch (err) {
    return readTerminalRowResult(db, row.id, err);
  }
}

/**
 * After a failing `paypalFetch`/`orders.capture` call, that call has
 * already written the row's terminal status (`failed_retryable` /
 * `failed_terminal`) and `next_attempt_at` — re-read it rather than
 * re-deriving the classification here, so there is exactly one place
 * (this module, via `paypalFetch`'s shared `classifyFailureStatus`)
 * that decides a row's terminal status.
 */
async function readTerminalRowResult(
  db: Db,
  operationId: string,
  fallbackErr: unknown,
): Promise<OperationResult> {
  const [row] = await db
    .select()
    .from(paypalOperations)
    .where(eq(paypalOperations.id, operationId));
  if (!row) {
    throw fallbackErr;
  }
  return toOperationResult(row);
}

/**
 * Executes the claimed sim-rail row. Sim calls are deterministic and
 * synchronous — there is no real "in flight" period — so a claimed sim
 * row resolves immediately. Mirrors `paypalFetch`'s result shape so
 * callers (and `executeOperation`'s own return type) are rail-agnostic.
 */
async function executeSimOperation(db: Db, row: OperationRow): Promise<OperationResult> {
  const body = {
    ...(typeof row.executableRequest === "object" && row.executableRequest !== null
      ? (row.executableRequest as Record<string, unknown>)
      : {}),
    simulated: true,
  };

  await db
    .update(paypalOperations)
    .set({ status: "succeeded", httpStatus: 200, response: redact(body) })
    .where(and(eq(paypalOperations.id, row.id), ne(paypalOperations.status, "succeeded")));

  return { status: "succeeded", body, httpStatus: 200 };
}

/**
 * Executes (or re-attempts) a queued operation. Never call this from
 * inside a `db.transaction` — see the JSDoc on `paypalFetch` for why.
 *
 * 1. **Claim** the row atomically: only a `queued` or `failed_retryable`
 *    row whose `claimed_at` is unset or more than 2 minutes old is
 *    claimable. If this call doesn't win the claim (someone else's
 *    attempt is already in flight, or the row is already terminal),
 *    this just returns the row's current result — a safe replay, never
 *    a second PayPal call.
 * 2. **Call**: dispatches by the row's `rail` — `paypal` goes through
 *    `paypalFetch` with the stored `executable_request`; `sim` goes
 *    through the deterministic in-DB sim handler.
 * 3. **Classify**: `paypalFetch` (or the sim handler) already wrote the
 *    row's terminal status — `succeeded`, `failed_retryable` (with
 *    `next_attempt_at`), or `failed_terminal` — before returning or
 *    throwing; this function just reports it.
 */
export async function executeOperation(db: Db, operationId: string): Promise<OperationResult> {
  const claimed = await db
    .update(paypalOperations)
    .set({ status: "in_flight", claimedAt: sql`now()` })
    .where(
      and(
        eq(paypalOperations.id, operationId),
        inArray(paypalOperations.status, ["queued", "failed_retryable"]),
        or(
          isNull(paypalOperations.claimedAt),
          lt(paypalOperations.claimedAt, sql`now() - interval '2 minutes'`),
        ),
      ),
    )
    .returning();

  const row = claimed[0];

  if (!row) {
    // Didn't win the claim: either this operation is already
    // succeeded/failed_terminal, or another attempt is currently (and
    // recently) in flight for it. Either way, replay its current state
    // rather than calling PayPal again.
    const [current] = await db
      .select()
      .from(paypalOperations)
      .where(eq(paypalOperations.id, operationId));
    if (!current) {
      throw new Error(`No paypal_operations row found for operationId ${operationId}`);
    }
    return toOperationResult(current);
  }

  if (row.rail === "sim") {
    return executeSimOperation(db, row);
  }

  return executePaypalOperation(db, row);
}

export { PayPalApiError, PayPalOperationReuseError };
