import { randomUUID } from "crypto";

import { and, desc, eq, gte, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";

import type { Db } from "../db/client";
import { paypalOperations } from "../db/schema";
import { simHandle } from "../rail/simHandler";
import { classifyFailureStatus, computeNextAttemptAt } from "./classify";
import { PayPalConfigError } from "./config";
import {
  PayPalApiError,
  PayPalNetworkError,
  PayPalOperationReuseError,
  paypalFetch,
} from "./fetch";
import { deriveOperationId, type OperationPurpose } from "./operationId";
import {
  buildGetOrderRequest,
  orderIdFromPath,
  parseCaptureOrderResponse,
  parseCreateOrderResponse,
  parseGetOrderResponse,
} from "./orders";
import {
  batchIdFromPath,
  parseCancelPayoutItemResponse,
  parseGetPayoutResponse,
  parseSendPayoutResponse,
  payoutItemIdFromCancelPath,
  withSenderBatchId,
} from "./payouts";
import { redact } from "./redact";
import {
  OPERATION_KINDS,
  READ_KINDS,
  type ExecutableRequest,
  type OperationError,
  type OperationKind,
  type OperationResponse,
  type OperationResultByKind,
  type OperationStatus,
} from "./types";

// The service-facing API: services import from here only (never from
// fetch/orders/payouts or the rails — see noTransactionCalls.test.ts).
export type { OperationPurpose } from "./operationId";
export { deriveOperationId, journalKey } from "./operationId";
export type * from "./types";
export {
  amountToCents,
  buildCaptureOrderRequest,
  buildCreateOrderRequest,
  buildGetOrderRequest,
  centsToAmount,
  optionalCents,
} from "./orders";
export { buildCancelPayoutItemRequest, buildGetPayoutRequest, buildSendPayoutRequest } from "./payouts";
export { PayPalApiError, PayPalOperationReuseError };

type OperationRow = typeof paypalOperations.$inferSelect;

export type OperationRail = "paypal" | "sim";

export interface EnqueueOperationParams {
  worldId: string;
  rail: OperationRail;
  kind: OperationKind;
  purpose: OperationPurpose;
  sourceId: string;
  request: ExecutableRequest;
}

export interface EnqueueOperationResult {
  operationId: string;
}

/** The method + path each kind must use — a request that doesn't match its kind is a bug. */
const KIND_ROUTES: Record<OperationKind, { method: ExecutableRequest["method"]; path: RegExp }> = {
  "order.create": { method: "POST", path: /^\/v2\/checkout\/orders$/ },
  "order.capture": { method: "POST", path: /^\/v2\/checkout\/orders\/[^/]+\/capture$/ },
  "order.get": { method: "GET", path: /^\/v2\/checkout\/orders\/[^/]+$/ },
  "payout.send": { method: "POST", path: /^\/v1\/payments\/payouts$/ },
  "payout.get": { method: "GET", path: /^\/v1\/payments\/payouts\/[^/]+$/ },
  "payout.cancel_item": { method: "POST", path: /^\/v1\/payments\/payouts-item\/[^/]+\/cancel$/ },
};

function isOperationKind(kind: string): kind is OperationKind {
  return (OPERATION_KINDS as readonly string[]).includes(kind);
}

function assertRequestMatchesKind(kind: OperationKind, request: ExecutableRequest): void {
  const route = KIND_ROUTES[kind];
  if (!route || request.method !== route.method || !route.path.test(request.path)) {
    throw new Error(
      `request ${request.method} ${request.path} does not match operation kind ${kind}`,
    );
  }
}

/** Per-kind request fix-ups that need the operation id (payouts: sender_batch_id = operation id). */
function finalizeRequest(
  kind: OperationKind,
  request: ExecutableRequest,
  operationId: string,
): ExecutableRequest {
  return kind === "payout.send" ? withSenderBatchId(request, operationId) : request;
}

async function insertQueuedRow(
  db: Db,
  values: {
    id: string;
    worldId: string;
    rail: OperationRail;
    kind: OperationKind;
    purpose: OperationPurpose | null;
    sourceId: string | null;
    request: ExecutableRequest;
    paypalId?: string | null;
  },
): Promise<OperationRow | undefined> {
  assertRequestMatchesKind(values.kind, values.request);
  const request = finalizeRequest(values.kind, values.request, values.id);
  const [inserted] = await db
    .insert(paypalOperations)
    .values({
      id: values.id,
      worldId: values.worldId,
      rail: values.rail,
      kind: values.kind,
      requestId: values.id,
      status: "queued",
      purpose: values.purpose,
      sourceId: values.sourceId,
      paypalId: values.paypalId ?? null,
      attempts: 0,
      request: redact(request),
      executableRequest: request,
    })
    .onConflictDoNothing({ target: paypalOperations.id })
    .returning();
  return inserted;
}

/**
 * Inserts a `queued` operation row keyed by
 * `deriveOperationId(worldId, purpose, sourceId)`, so enqueuing the same
 * logical operation twice resolves to the same row. Never calls PayPal —
 * call it with `ctx.tx` inside the domain transaction, then schedule
 * `ctx.afterCommit(() => executeOperation(ctx.db, operationId))`.
 *
 * The request must match `kind` (method + path); build it with the
 * `build*Request` helpers re-exported from this module. For
 * `payout.send`, `sender_batch_id` is stamped with the operation id.
 *
 * A derived id that already names a row for a different `rail`/`kind`
 * throws `PayPalOperationReuseError`.
 */
export async function enqueueOperation(
  tx: Db,
  params: EnqueueOperationParams,
): Promise<EnqueueOperationResult> {
  const operationId = deriveOperationId(params.worldId, params.purpose, params.sourceId);

  const inserted = await insertQueuedRow(tx, {
    id: operationId,
    worldId: params.worldId,
    rail: params.rail,
    kind: params.kind,
    purpose: params.purpose,
    sourceId: params.sourceId,
    request: params.request,
  });
  if (inserted) {
    return { operationId: inserted.id };
  }

  const [existing] = await tx
    .select()
    .from(paypalOperations)
    .where(
      and(eq(paypalOperations.id, operationId), eq(paypalOperations.worldId, params.worldId)),
    );

  if (!existing) {
    throw new PayPalOperationReuseError(
      `operationId ${operationId} belongs to a different world — refusing to reuse it`,
    );
  }
  if (existing.rail !== params.rail || existing.kind !== params.kind) {
    throw new PayPalOperationReuseError(
      `operationId ${operationId} (worldId=${params.worldId}, purpose=${params.purpose}, sourceId=${params.sourceId}) is already a rail=${existing.rail}, kind=${existing.kind} operation; refusing to reuse it for rail=${params.rail}, kind=${params.kind}`,
    );
  }
  return { operationId: existing.id };
}

/**
 * Enqueues a read-only operation (`order.get` / `payout.get`) under a
 * fresh random id — reads move no money, so they need no derived
 * idempotency key. Rejects every money-moving kind.
 */
export async function enqueueReadOperation(
  db: Db,
  params: { worldId: string; rail: OperationRail; kind: OperationKind; request: ExecutableRequest },
): Promise<EnqueueOperationResult> {
  if (!READ_KINDS.includes(params.kind)) {
    throw new Error(
      `enqueueReadOperation only accepts read kinds; ${params.kind} must go through enqueueOperation`,
    );
  }
  const id = randomUUID();
  // Fix round 1 (M3): a read records the id it reads from enqueue on (not
  // only on success), so throttling looks reads up by the indexed
  // (world_id, kind, paypal_id) instead of scanning request paths.
  const paypalId =
    params.kind === "order.get" ? orderIdFromPath(params.request.path) : batchIdFromPath(params.request.path);
  await insertQueuedRow(db, { ...params, id, purpose: null, sourceId: null, paypalId });
  return { operationId: id };
}

/**
 * What `executeOperation` returns — built from the stored row, so the
 * first run and every replay return the identical shape. `body` is the
 * stored `response`: the kind's parsed result when `status` is
 * `succeeded`, `{ error }` when failed, `null` while queued/in flight.
 */
export interface OperationResult<K extends OperationKind = OperationKind> {
  operationId: string;
  kind: K;
  status: OperationStatus;
  httpStatus: number | null;
  body: OperationResultByKind[K] | OperationError | null;
}

function toOperationResult(row: OperationRow): OperationResult {
  return {
    operationId: row.id,
    kind: row.kind as OperationKind,
    status: row.status as OperationStatus,
    httpStatus: row.httpStatus,
    body: (row.response ?? null) as OperationResponse | null,
  };
}

/** Narrows a succeeded result's body to the kind's result shape; throws if it didn't succeed. */
export function successBody<K extends OperationKind>(
  result: OperationResult,
  kind: K,
): OperationResultByKind[K] {
  if (result.kind !== kind || result.status !== "succeeded" || result.body === null) {
    throw new Error(
      `operation ${result.operationId} (${result.kind}) is ${result.status}, not a succeeded ${kind}`,
    );
  }
  return result.body as OperationResultByKind[K];
}

/** The `{ error }` body of a failed result, or `null`. */
export function errorBody(result: OperationResult): OperationError["error"] | null {
  const body = result.body as Partial<OperationError> | null;
  return body?.error ?? null;
}

// ---------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------

type FinalStatus = "succeeded" | "failed_retryable" | "failed_terminal";

/** The outcome of one `executeOperation` run, written to the row in one UPDATE. */
interface Outcome {
  status: FinalStatus;
  httpStatus: number | null;
  response: OperationResponse;
  paypalId: string | null;
  lastError: string | null;
  /** HTTP attempts made during this run (added to the row's cumulative count). */
  attempts: number;
  latencyMs: number;
}

type SendResult =
  | { ok: true; httpStatus: number; body: unknown; attempts: number; latencyMs: number }
  | { ok: false; error: OperationError; attempts: number; latencyMs: number };

function operationError(
  name: string,
  fields: Partial<Omit<OperationError["error"], "name">> = {},
): OperationError {
  return {
    error: {
      name,
      issue: fields.issue ?? null,
      message: fields.message ?? null,
      debugId: fields.debugId ?? null,
      details: redact(fields.details ?? null),
    },
  };
}

/** Builds the stored `{ error }` from a non-2xx PayPal (or sim) response body. */
function errorFromResponse(httpStatus: number, body: unknown): OperationError {
  const record =
    body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const details = Array.isArray(record.details) ? record.details : null;
  const firstIssue = (details?.[0] as Record<string, unknown> | undefined)?.issue;
  return operationError(typeof record.name === "string" ? record.name : `HTTP_${httpStatus}`, {
    issue: typeof firstIssue === "string" ? firstIssue : null,
    message: typeof record.message === "string" ? record.message : null,
    debugId: typeof record.debug_id === "string" ? record.debug_id : null,
    details: details ?? (typeof body === "string" ? body : null),
  });
}

function errorCode(error: OperationError): string {
  return error.error.issue ?? error.error.name;
}

/** True when PayPal's error `name` or *any* `details[].issue` equals `code`. */
function hasErrorCode(body: unknown, code: string): boolean {
  const record =
    body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
  if (record.name === code) {
    return true;
  }
  const details = Array.isArray(record.details) ? record.details : [];
  return details.some(
    (detail) =>
      detail !== null &&
      typeof detail === "object" &&
      (detail as Record<string, unknown>).issue === code,
  );
}

/**
 * Sends one request for `row` over its rail: PayPal via `paypalFetch`
 * (with `PayPal-Request-Id` = the operation id), or the sim rail's in-DB
 * handler, which answers with the same PayPal-shaped `{httpStatus, body}`
 * so everything after this point is rail-agnostic.
 */
async function send(
  db: Db,
  row: OperationRow,
  kind: OperationKind,
  request: ExecutableRequest,
): Promise<SendResult> {
  const startedAt = Date.now();

  if (row.rail === "sim") {
    const res = await simHandle(db, {
      worldId: row.worldId,
      operationId: row.id,
      kind,
      request,
    });
    return { ok: true, ...res, attempts: 1, latencyMs: Date.now() - startedAt };
  }

  try {
    const res = await paypalFetch({ ...request, requestId: row.id });
    return { ok: true, ...res };
  } catch (err) {
    if (err instanceof PayPalNetworkError) {
      return {
        ok: false,
        error: operationError("PayPalNetworkError", { message: err.message, details: err.details }),
        attempts: err.attempts,
        latencyMs: err.latencyMs,
      };
    }
    if (err instanceof PayPalConfigError) {
      // Nothing was sent. Retryable rather than terminal: once the
      // deployment's credentials are fixed, the reconcile cron can still
      // complete the operation.
      return {
        ok: false,
        error: operationError("PayPalConfigError", { message: err.message }),
        attempts: 0,
        latencyMs: Date.now() - startedAt,
      };
    }
    throw err;
  }
}

/** Parses a 2xx body into the kind's stored result shape. Throws if the body is malformed. */
function parseSuccess(
  kind: OperationKind,
  request: ExecutableRequest,
  body: unknown,
): { response: OperationResponse; paypalId: string } {
  switch (kind) {
    case "order.create": {
      const result = parseCreateOrderResponse(body);
      return { response: result, paypalId: result.orderId };
    }
    case "order.capture": {
      const orderId = orderIdFromPath(request.path);
      return { response: parseCaptureOrderResponse(orderId, body), paypalId: orderId };
    }
    case "order.get": {
      const result = parseGetOrderResponse(body);
      return { response: result, paypalId: result.orderId };
    }
    case "payout.send": {
      const result = parseSendPayoutResponse(body);
      return { response: result, paypalId: result.batchId };
    }
    case "payout.get": {
      const result = parseGetPayoutResponse(body);
      return { response: result, paypalId: result.batchId };
    }
    case "payout.cancel_item": {
      const result = parseCancelPayoutItemResponse(body);
      return { response: result, paypalId: payoutItemIdFromCancelPath(request.path) };
    }
  }
}

function failure(
  status: "failed_retryable" | "failed_terminal",
  httpStatus: number | null,
  error: OperationError,
  attempts: number,
  latencyMs: number,
): Outcome {
  return {
    status,
    httpStatus,
    response: error,
    paypalId: null,
    lastError: errorCode(error),
    attempts,
    latencyMs,
  };
}

/**
 * The capture's outcome is known to have moved money (or may have) but
 * we don't hold a parsed capture: PayPal said `ORDER_ALREADY_CAPTURED`
 * (an earlier attempt, or another capture of the same order, already
 * captured it), or it answered 2xx with a body we couldn't parse.
 * Recover the existing capture with a GET on the order and treat it as
 * success. If the GET itself fails or shows no capture, the outcome is
 * `failed_retryable` — never terminal, because the money may well have
 * moved and a later run must find it.
 */
async function recoverCapture(
  db: Db,
  row: OperationRow,
  request: ExecutableRequest,
  captureAttempt: { httpStatus: number; error: OperationError; attempts: number; latencyMs: number },
): Promise<Outcome> {
  const orderId = orderIdFromPath(request.path);
  const got = await send(db, row, "order.get", buildGetOrderRequest(orderId));
  const attempts = captureAttempt.attempts + got.attempts;
  const latencyMs = captureAttempt.latencyMs + got.latencyMs;

  let recoveryProblem: unknown;
  if (got.ok && got.httpStatus >= 200 && got.httpStatus < 300) {
    try {
      const result = parseCaptureOrderResponse(orderId, got.body, true);
      return {
        status: "succeeded",
        httpStatus: got.httpStatus,
        response: result,
        paypalId: orderId,
        lastError: null,
        attempts,
        latencyMs,
      };
    } catch (err) {
      recoveryProblem = { message: err instanceof Error ? err.message : String(err) };
    }
  } else {
    recoveryProblem = got.ok
      ? { getHttpStatus: got.httpStatus, getError: errorFromResponse(got.httpStatus, got.body).error }
      : { getError: got.error.error };
  }

  return failure(
    "failed_retryable",
    captureAttempt.httpStatus,
    operationError(captureAttempt.error.error.name, {
      issue: captureAttempt.error.error.issue,
      message: `Capture outcome unconfirmed (${errorCode(captureAttempt.error)}) and the recovery GET did not return the capture; will retry`,
      debugId: captureAttempt.error.error.debugId,
      details: recoveryProblem,
    }),
    attempts,
    latencyMs,
  );
}

/** Runs one attempt for a claimed row and classifies it. Never writes `paypal_operations` status. */
async function runClaimed(db: Db, row: OperationRow): Promise<Outcome> {
  const request = row.executableRequest as ExecutableRequest | null;
  if (!isOperationKind(row.kind) || !request) {
    return failure(
      "failed_terminal",
      null,
      operationError("INVALID_OPERATION", {
        message: `row has kind=${row.kind} and ${request ? "an" : "no"} executable_request`,
      }),
      0,
      0,
    );
  }
  const kind = row.kind;

  const sent = await send(db, row, kind, request);
  if (!sent.ok) {
    return failure("failed_retryable", null, sent.error, sent.attempts, sent.latencyMs);
  }

  if (sent.httpStatus >= 200 && sent.httpStatus < 300) {
    try {
      const { response, paypalId } = parseSuccess(kind, request, sent.body);
      return {
        status: "succeeded",
        httpStatus: sent.httpStatus,
        response,
        paypalId,
        lastError: null,
        attempts: sent.attempts,
        latencyMs: sent.latencyMs,
      };
    } catch (err) {
      const error = operationError("RESPONSE_UNPARSEABLE", {
        message: err instanceof Error ? err.message : String(err),
        details: sent.body,
      });
      // PayPal accepted the request but the body isn't what this kind
      // promises. For a money-moving kind that must never be terminal:
      // a capture may have happened (confirm it via GET), and a payout
      // batch was likely created (re-sending the same PayPal-Request-Id
      // replays that same batch, never a second one). For non-money kinds
      // the same request id would replay the same body, so it's terminal.
      if (kind === "order.capture") {
        return recoverCapture(db, row, request, {
          httpStatus: sent.httpStatus,
          error,
          attempts: sent.attempts,
          latencyMs: sent.latencyMs,
        });
      }
      return failure(
        kind === "payout.send" ? "failed_retryable" : "failed_terminal",
        sent.httpStatus,
        error,
        sent.attempts,
        sent.latencyMs,
      );
    }
  }

  const error = errorFromResponse(sent.httpStatus, sent.body);
  if (kind === "order.capture" && hasErrorCode(sent.body, "ORDER_ALREADY_CAPTURED")) {
    error.error.issue = "ORDER_ALREADY_CAPTURED";
    return recoverCapture(db, row, request, {
      httpStatus: sent.httpStatus,
      error,
      attempts: sent.attempts,
      latencyMs: sent.latencyMs,
    });
  }
  return failure(
    classifyFailureStatus(sent.httpStatus),
    sent.httpStatus,
    error,
    sent.attempts,
    sent.latencyMs,
  );
}

/**
 * An `in_flight` claim older than this is presumed abandoned (worker
 * crashed) and may be reclaimed. It MUST exceed the worst-case duration
 * of one `executeOperation` run, or a live, slow attempt could be
 * reclaimed and run concurrently. Worst case: `paypalFetch` is capped at
 * `PAYPAL_TOTAL_DEADLINE_MS` (60s, fetch.ts) across all its attempts,
 * token fetches and backoff, and a run makes at most two of those calls
 * (capture + recovery GET) = 120s, plus a few DB round trips — well
 * under 3 minutes. Keep these two constants in step.
 */
const STALE_CLAIM_INTERVAL = "3 minutes";
const STALE_CLAIM = sql.raw(`now() - interval '${STALE_CLAIM_INTERVAL}'`);

/**
 * Atomically claims a row: a `queued`/`failed_retryable` row whose
 * backoff has elapsed (or `ignoreBackoff`), or an `in_flight` row whose
 * claim is older than `STALE_CLAIM_INTERVAL` (its worker died mid-call). `claimed_at`
 * is truncated to milliseconds so the JS `Date` read back compares equal
 * in `recordOutcome`'s claim guard.
 */
async function claim(
  db: Db,
  operationId: string,
  ignoreBackoff: boolean,
): Promise<OperationRow | undefined> {
  const t = paypalOperations;
  const [row] = await db
    .update(t)
    .set({ status: "in_flight", claimedAt: sql`date_trunc('milliseconds', now())` })
    .where(
      and(
        eq(t.id, operationId),
        or(
          and(
            inArray(t.status, ["queued", "failed_retryable"]),
            ignoreBackoff ? undefined : or(isNull(t.nextAttemptAt), lte(t.nextAttemptAt, sql`now()`)),
          ),
          and(eq(t.status, "in_flight"), lt(t.claimedAt, STALE_CLAIM)),
        ),
      ),
    )
    .returning();
  return row;
}

/** Task 10b (Ruling U): a write op is given up on after this many cumulative attempts… */
export const RETRY_CAP_ATTEMPTS = 20;
/** …or once it was first enqueued (≈ first attempted) this long ago, in real time. */
export const RETRY_CAP_AGE_MS = 24 * 60 * 60 * 1000;
/** `last_error` (and the stored error's `issue`) of an operation given up on by the cap. */
export const RETRY_CAP_EXCEEDED = "retry_cap_exceeded";

/**
 * Task 10b (Ruling U): a money-moving (non-read) operation whose outcome
 * would be `failed_retryable` becomes `failed_terminal` once it has made
 * ≥ `RETRY_CAP_ATTEMPTS` attempts (counting this run) or was enqueued
 * more than `RETRY_CAP_AGE_MS` ago — e.g. the sandbox's
 * `payouts-item/{id}/cancel` answering 500 forever. The stored error keeps
 * PayPal's `name`, sets `issue` = `retry_cap_exceeded`, and keeps the
 * original issue/details under `details`; `last_error` =
 * `retry_cap_exceeded` (the reconcile cron lists these as
 * `operation_retry_cap_exceeded`). Reads are never capped (they are
 * throttled instead and move no money).
 */
function applyRetryCap(claimed: OperationRow, outcome: Outcome, counted: number): Outcome {
  if (outcome.status !== "failed_retryable" || (READ_KINDS as readonly string[]).includes(claimed.kind)) {
    return outcome;
  }
  const attempts = claimed.attempts + counted;
  const ageMs = Date.now() - claimed.createdAt.getTime();
  if (attempts < RETRY_CAP_ATTEMPTS && ageMs < RETRY_CAP_AGE_MS) {
    return outcome;
  }
  const original = (outcome.response as OperationError).error;
  return {
    ...outcome,
    status: "failed_terminal",
    lastError: RETRY_CAP_EXCEEDED,
    response: {
      error: {
        name: original.name,
        issue: RETRY_CAP_EXCEEDED,
        message: `Gave up after ${attempts} attempts over ${Math.round(ageMs / 60_000)} minutes: ${original.message ?? errorCode({ error: original })}`,
        debugId: original.debugId,
        details: {
          reason: RETRY_CAP_EXCEEDED,
          attempts,
          firstEnqueuedAt: claimed.createdAt.toISOString(),
          lastIssue: original.issue,
          lastDetails: original.details,
        },
      },
    },
  };
}

/**
 * The single place that writes an attempt's outcome (Ruling H):
 * `attempts` accumulates (`attempts + n`, n ≥ 1 for a failed run), `claimed_at` is cleared,
 * `next_attempt_at` uses the cumulative count.
 *
 * - A success may land on any non-final row (`queued`/`in_flight`/
 *   `failed_retryable`) — even if our claim went stale and someone else
 *   reclaimed it, a success is the truth (same request id, same result).
 * - A failure only lands while *our* claim still holds (`in_flight` with
 *   our `claimed_at`), so a slow, stale attempt can never overwrite a
 *   newer attempt's outcome.
 * - Neither ever touches a `succeeded` or `failed_terminal` row.
 *
 * When the guarded write loses, only the attempts are counted and the
 * row's current state is returned.
 */
async function recordOutcome(db: Db, claimed: OperationRow, rawOutcome: Outcome): Promise<OperationRow> {
  const t = paypalOperations;
  // A failed run counts as at least one attempt, even when nothing was
  // sent (config error, internal error), so backoff keeps growing.
  const counted =
    rawOutcome.status === "succeeded" ? rawOutcome.attempts : Math.max(rawOutcome.attempts, 1);
  const outcome = applyRetryCap(claimed, rawOutcome, counted);
  const common = {
    status: outcome.status,
    httpStatus: outcome.httpStatus,
    response: outcome.response,
    latencyMs: outcome.latencyMs,
    lastError: outcome.lastError,
    attempts: sql`${t.attempts} + ${counted}`,
    claimedAt: null,
  };

  const [written] =
    outcome.status === "succeeded"
      ? await db
          .update(t)
          .set({ ...common, paypalId: outcome.paypalId, nextAttemptAt: null })
          .where(
            and(
              eq(t.id, claimed.id),
              inArray(t.status, ["queued", "in_flight", "failed_retryable"]),
            ),
          )
          .returning()
      : await db
          .update(t)
          .set({
            ...common,
            nextAttemptAt:
              outcome.status === "failed_retryable"
                ? computeNextAttemptAt(claimed.attempts + counted)
                : null,
          })
          .where(
            and(
              eq(t.id, claimed.id),
              eq(t.status, "in_flight"),
              claimed.claimedAt ? eq(t.claimedAt, claimed.claimedAt) : isNull(t.claimedAt),
            ),
          )
          .returning();

  if (written) {
    return written;
  }

  const [current] = await db
    .update(t)
    .set({ attempts: sql`${t.attempts} + ${counted}` })
    .where(eq(t.id, claimed.id))
    .returning();
  if (!current) {
    throw new Error(`paypal_operations row ${claimed.id} vanished mid-execution`);
  }
  return current;
}

/**
 * The full stored record for an operation, for a caller that doesn't yet
 * know the operation's `worldId` (e.g. an outcome applier that only has
 * an operation id to start from). Services stay off `paypal_operations`
 * directly (the world-isolation guard) by going through this instead of
 * reading the table themselves.
 */
export interface OperationRecord extends OperationResult {
  worldId: string;
  purpose: OperationPurpose | null;
  sourceId: string | null;
}

function toOperationRecord(row: OperationRow): OperationRecord {
  return {
    ...toOperationResult(row),
    worldId: row.worldId,
    purpose: row.purpose as OperationPurpose | null,
    sourceId: row.sourceId,
  };
}

/** Looks up an operation by id with no world filter, or `undefined` if it doesn't exist. */
export async function getOperation(db: Db, operationId: string): Promise<OperationRecord | undefined> {
  const [row] = await db.select().from(paypalOperations).where(eq(paypalOperations.id, operationId));
  return row ? toOperationRecord(row) : undefined;
}

/**
 * Task 8 (webhooks): the operation of `kind` whose PayPal-side id is
 * `paypalId` — an `order.create` by order id, a `payout.send` by batch
 * id — across ALL worlds (a webhook doesn't say which world it's for;
 * the operation does). Oldest first if, implausibly, more than one
 * matches. `undefined` when no operation knows that id.
 */
export async function findOperationByPaypalId(
  db: Db,
  kind: OperationKind,
  paypalId: string,
): Promise<OperationRecord | undefined> {
  const [row] = await db
    .select()
    .from(paypalOperations)
    .where(and(eq(paypalOperations.kind, kind), eq(paypalOperations.paypalId, paypalId)))
    .orderBy(paypalOperations.createdAt, paypalOperations.id)
    .limit(1);
  return row ? toOperationRecord(row) : undefined;
}

/**
 * Task 8 (reconcile, step 1): money-moving operations, across all
 * worlds, that the cron should (re-)execute — oldest first, at most
 * `limit`:
 * - `queued` with no backoff, enqueued at least `minQueuedAgeMs` ago (a
 *   younger one belongs to a request that is about to execute it itself);
 * - `queued`/`failed_retryable` whose `next_attempt_at` ≤ `now`;
 * - `in_flight` with a stale claim (the same window `claim` uses).
 * Read kinds (`order.get`/`payout.get`) are excluded — a stranded read
 * moves nothing and a fresh one is cheaper. `executeOperation`'s claim
 * re-checks every condition atomically, so a row listed here that is
 * no longer claimable is simply returned as-is.
 */
export async function listDueOperations(
  db: Db,
  { now, limit, minQueuedAgeMs }: { now: Date; limit: number; minQueuedAgeMs: number },
): Promise<OperationRecord[]> {
  if (limit <= 0) {
    return [];
  }
  const t = paypalOperations;
  const queuedBefore = new Date(now.getTime() - minQueuedAgeMs);
  const rows = await db
    .select()
    .from(t)
    .where(
      and(
        sql`${t.kind} not in (${sql.join(
          READ_KINDS.map((kind) => sql`${kind}`),
          sql`, `,
        )})`,
        or(
          and(eq(t.status, "queued"), isNull(t.nextAttemptAt), lte(t.createdAt, queuedBefore)),
          and(inArray(t.status, ["queued", "failed_retryable"]), lte(t.nextAttemptAt, now)),
          and(eq(t.status, "in_flight"), lt(t.claimedAt, STALE_CLAIM)),
        ),
      ),
    )
    .orderBy(t.createdAt, t.id)
    .limit(limit);
  return rows.map(toOperationRecord);
}

/** Task 10b: a write operation the reconcile cron reports as an anomaly. */
export interface TroubledOperation {
  operationId: string;
  kind: OperationKind;
  purpose: OperationPurpose | null;
  sourceId: string | null;
  attempts: number;
  lastError: string | null;
}

/**
 * Task 10b (reconcile anomalies), money-moving kinds only, oldest first,
 * at most `limit`, in one world:
 * - `retrying`: `failed_retryable` with ≥ `minAttempts` attempts;
 * - `capped`: `failed_terminal` given up on by the retry cap
 *   (`last_error = retry_cap_exceeded`).
 */
export async function listTroubledOperations(
  db: Db,
  worldId: string,
  which: "retrying" | "capped",
  { minAttempts = 0, limit = 100 }: { minAttempts?: number; limit?: number } = {},
): Promise<TroubledOperation[]> {
  const t = paypalOperations;
  const rows = await db
    .select()
    .from(t)
    .where(
      and(
        eq(t.worldId, worldId),
        sql`${t.kind} not in (${sql.join(
          READ_KINDS.map((kind) => sql`${kind}`),
          sql`, `,
        )})`,
        which === "retrying"
          ? and(eq(t.status, "failed_retryable"), gte(t.attempts, minAttempts))
          : and(eq(t.status, "failed_terminal"), eq(t.lastError, RETRY_CAP_EXCEEDED)),
      ),
    )
    .orderBy(t.createdAt, t.id)
    .limit(limit);
  return rows.map((row) => ({
    operationId: row.id,
    kind: row.kind as OperationKind,
    purpose: row.purpose as OperationPurpose | null,
    sourceId: row.sourceId,
    attempts: row.attempts,
    lastError: row.lastError,
  }));
}

/**
 * Task 8 (reconcile, step 3 throttle): when the `order.create` that made
 * `orderId` was enqueued, and when the newest `order.get` of that order
 * was enqueued — in ANY status (reads carry the order id in
 * `paypal_id` from enqueue), so failing reads throttle too. `null` when no
 * `order.create` in `worldId` made that order.
 */
export async function orderPollTimes(
  db: Db,
  worldId: string,
  orderId: string,
): Promise<{ createdAt: Date; lastReadCreatedAt: Date | null } | null> {
  const [createRow] = await db
    .select({ createdAt: paypalOperations.createdAt })
    .from(paypalOperations)
    .where(
      and(
        eq(paypalOperations.worldId, worldId),
        eq(paypalOperations.kind, "order.create"),
        eq(paypalOperations.paypalId, orderId),
      ),
    )
    .limit(1);
  if (!createRow) {
    return null;
  }
  const [read] = await db
    .select({ createdAt: paypalOperations.createdAt })
    .from(paypalOperations)
    .where(
      and(
        eq(paypalOperations.worldId, worldId),
        eq(paypalOperations.kind, "order.get"),
        eq(paypalOperations.paypalId, orderId),
      ),
    )
    .orderBy(desc(paypalOperations.createdAt), desc(paypalOperations.id))
    .limit(1);
  return { createdAt: createRow.createdAt, lastReadCreatedAt: read?.createdAt ?? null };
}

/**
 * Ruling Q: the newest succeeded `payout.get` read of the batch a
 * `payout.send` operation created, enqueued after that send — or `null`
 * if there is none (or the send has no batch id yet). Outcome appliers use
 * it to see a live item's status, which PayPal's POST response almost
 * never reports. Lives here (not in services) because services stay off
 * `paypal_operations` (the world-isolation guard).
 */
export async function latestPayoutGetForSend(
  db: Db,
  sendOperationId: string,
): Promise<OperationResultByKind["payout.get"] | null> {
  const send = await db.select().from(paypalOperations).where(eq(paypalOperations.id, sendOperationId));
  const sendRow = send[0];
  if (!sendRow || sendRow.kind !== "payout.send" || !sendRow.paypalId) {
    return null;
  }
  const [read] = await db
    .select()
    .from(paypalOperations)
    .where(
      and(
        eq(paypalOperations.worldId, sendRow.worldId),
        eq(paypalOperations.kind, "payout.get"),
        eq(paypalOperations.status, "succeeded"),
        eq(paypalOperations.paypalId, sendRow.paypalId),
        gte(paypalOperations.createdAt, sendRow.createdAt),
      ),
    )
    // No completion-time column exists; newest enqueue wins, id breaks ties deterministically.
    .orderBy(desc(paypalOperations.createdAt), desc(paypalOperations.id))
    .limit(1);
  return read ? (read.response as OperationResultByKind["payout.get"]) : null;
}

/**
 * Task 10b (reconcile, payout fees): succeeded `payout.send` operations
 * in `worldId` enqueued at or after `since`, oldest first, at most
 * `limit` — candidates whose PayPal fee may still have to be read and
 * journaled after their source settled.
 */
export async function listRecentSucceededPayoutSends(
  db: Db,
  worldId: string,
  { since, limit = 200 }: { since: Date; limit?: number },
): Promise<string[]> {
  const t = paypalOperations;
  const rows = await db
    .select({ id: t.id })
    .from(t)
    .where(and(eq(t.worldId, worldId), eq(t.kind, "payout.send"), eq(t.status, "succeeded"), gte(t.createdAt, since)))
    .orderBy(t.createdAt, t.id)
    .limit(limit);
  return rows.map((row) => row.id);
}

/**
 * For throttling `pollPayoutStatus`: when the `payout.send` was enqueued,
 * and when the newest `payout.get` of its batch was enqueued — in ANY
 * status (reads carry the batch id in `paypal_id` from enqueue — Fix
 * round 1, M3), so failing reads throttle too. `null` when the
 * operation isn't a send with a batch id.
 */
export async function payoutPollTimes(
  db: Db,
  sendOperationId: string,
): Promise<{ sendCreatedAt: Date; lastReadCreatedAt: Date | null } | null> {
  const [sendRow] = await db.select().from(paypalOperations).where(eq(paypalOperations.id, sendOperationId));
  if (!sendRow || sendRow.kind !== "payout.send" || !sendRow.paypalId) {
    return null;
  }
  const [read] = await db
    .select({ createdAt: paypalOperations.createdAt })
    .from(paypalOperations)
    .where(
      and(
        eq(paypalOperations.worldId, sendRow.worldId),
        eq(paypalOperations.kind, "payout.get"),
        eq(paypalOperations.paypalId, sendRow.paypalId),
      ),
    )
    .orderBy(desc(paypalOperations.createdAt), desc(paypalOperations.id))
    .limit(1);
  return { sendCreatedAt: sendRow.createdAt, lastReadCreatedAt: read?.createdAt ?? null };
}

async function readOperationRow(db: Db, operationId: string): Promise<OperationRow> {
  const [row] = await db.select().from(paypalOperations).where(eq(paypalOperations.id, operationId));
  if (!row) {
    throw new Error(`No paypal_operations row found for operationId ${operationId}`);
  }
  return row;
}

export interface ExecuteOperationOptions {
  /**
   * Skip the `next_attempt_at` backoff check when claiming — for a caller
   * that runs a row inline right after creating it (or a direct rail
   * facade call). The reconcile cron must not pass this.
   */
  ignoreBackoff?: boolean;
}

/**
 * Executes (or re-attempts) a queued operation. Never call it inside a
 * `db.transaction` — see `paypalFetch`'s JSDoc.
 *
 * 1. **Claim** atomically (see `claim`). Not claimable (already final,
 *    backing off, or freshly in flight elsewhere) → return the row's
 *    current result without calling anything.
 * 2. **Call** over the row's rail with `PayPal-Request-Id` = operation id
 *    (sim rail: the in-DB handler, dispatched by kind).
 * 3. **Classify**: 2xx → `succeeded` (parsed result stored); 4xx other
 *    than 401/409/429 → `failed_terminal`; 5xx, 401/409/429, network
 *    error or timeout → `failed_retryable` with `next_attempt_at` =
 *    now + 30s·2^attempts (cumulative, capped at 10 min). An
 *    `order.capture` answered `ORDER_ALREADY_CAPTURED` (any
 *    `details[].issue`) or a 2xx with an unparseable body recovers the
 *    capture via GET (`succeeded`), or is `failed_retryable` if that GET
 *    fails. An unparseable 2xx `payout.send` is `failed_retryable` (the
 *    same request id replays the same batch); for other kinds it is
 *    `failed_terminal`. An unexpected exception is `failed_retryable`.
 *    Every failed run counts as ≥ 1 attempt for backoff. Task 10b: a
 *    money-moving (non-read) kind that would be `failed_retryable` is
 *    `failed_terminal` (`retry_cap_exceeded`) once it reached 20 attempts
 *    or was enqueued > 24 h ago (`applyRetryCap`).
 * 4. **Return** `toOperationResult(row)` — identical on replay.
 */
export async function executeOperation(
  db: Db,
  operationId: string,
  options: ExecuteOperationOptions = {},
): Promise<OperationResult> {
  const claimed = await claim(db, operationId, options.ignoreBackoff ?? false);
  if (!claimed) {
    return toOperationResult(await readOperationRow(db, operationId));
  }

  let outcome: Outcome;
  try {
    outcome = await runClaimed(db, claimed);
  } catch (err) {
    outcome = failure(
      "failed_retryable",
      null,
      operationError("INTERNAL_ERROR", { message: err instanceof Error ? err.message : String(err) }),
      0,
      0,
    );
  }

  return toOperationResult(await recordOutcome(db, claimed, outcome));
}
