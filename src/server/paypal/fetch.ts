import { randomUUID } from "crypto";

import { and, eq, ne } from "drizzle-orm";

import type { Db } from "../db/client";
import { scoped } from "../db/scoped";
import { paypalOperations } from "../db/schema";
import { PayPalConfigError, paypalConfig, paypalTimeoutMs } from "./config";
import { redact } from "./redact";
import { PayPalOAuthError, getAccessToken } from "./token";

/** Up to 2 retries (3 total attempts) on a 5xx or network error, same backoff PayPal recommends. */
const MAX_RETRIES = 2;
const BACKOFF_MS = [300, 900] as const;

export interface PaypalFetchOp {
  worldId: string;
  kind: string;
  method: "GET" | "POST" | "PATCH";
  path: string;
  body?: unknown;
  /**
   * Caller-supplied operation id. Used by callers that need the same
   * logical operation (e.g. a payout keyed by a loan/note id) to always
   * reuse the same `PayPal-Request-Id` / `paypal_operations.id` across
   * separate invocations — so a duplicate call for the same id never
   * re-sends money. When omitted, a fresh id is generated.
   */
  operationId?: string;
}

export interface PaypalFetchResult<T> {
  status: number;
  body: T;
  operationId: string;
}

export class PayPalApiError extends Error {
  readonly status: number;
  readonly details: unknown;
  readonly debugId: string | undefined;

  constructor(options: {
    status: number;
    name: string;
    details: unknown;
    debugId?: string;
  }) {
    super(`PayPal API error ${options.name} (status ${options.status})`);
    this.name = options.name;
    this.status = options.status;
    this.details = options.details;
    this.debugId = options.debugId;
  }
}

/**
 * A fatal, non-retryable failure that happened before/outside the normal
 * request/retry loop (or after exhausting it) — e.g. the retry budget
 * for a network/timeout error ran out.
 */
export class PayPalNetworkError extends Error {
  constructor(
    message: string,
    readonly operationCause: unknown,
  ) {
    super(message);
    this.name = "PayPalNetworkError";
  }
}

/**
 * Thrown when a caller-supplied `operationId` can't be reused: it
 * belongs to a different world, or was already used for a different
 * `rail`/`kind` of operation (e.g. reusing an id from an `order.create`
 * for a `payout.send`). PayPal is never called in this case.
 */
export class PayPalOperationReuseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayPalOperationReuseError";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function parseJsonSafe(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function extractPaypalId(body: unknown): string | null {
  if (body !== null && typeof body === "object") {
    const record = body as Record<string, unknown>;
    if (typeof record.id === "string") {
      return record.id;
    }
    const batchHeader = record.batch_header;
    if (batchHeader !== null && typeof batchHeader === "object") {
      const payoutBatchId = (batchHeader as Record<string, unknown>)
        .payout_batch_id;
      if (typeof payoutBatchId === "string") {
        return payoutBatchId;
      }
    }
  }
  return null;
}

function extractErrorName(body: unknown): string {
  if (body !== null && typeof body === "object") {
    const name = (body as Record<string, unknown>).name;
    if (typeof name === "string") {
      return name;
    }
  }
  return "PayPalApiError";
}

function extractDebugId(body: unknown): string | undefined {
  if (body !== null && typeof body === "object") {
    const debugId = (body as Record<string, unknown>).debug_id;
    if (typeof debugId === "string") {
      return debugId;
    }
  }
  return undefined;
}

/**
 * The headers logged alongside the request body. The bearer token is
 * never included in the first place (not merely masked) — only the
 * non-secret `PayPal-Request-Id` is kept for traceability.
 */
function buildLoggedHeaders(requestId: string): Record<string, string> {
  return { "PayPal-Request-Id": requestId };
}

interface EnsureOperationRowResult {
  id: string;
  /**
   * Set when an explicit, caller-supplied `operationId` was reused and
   * the prior call for it already succeeded — its stored result is
   * returned as-is, without ever calling PayPal again.
   */
  reusedResult: PaypalFetchResult<unknown> | null;
}

/**
 * Creates the `paypal_operations` row for this call before any request is
 * sent — its id is the value sent as `PayPal-Request-Id` for every
 * attempt of this call, including retries. The (redacted) request is
 * stored at insert time, so even a failure that never reaches the retry
 * loop (e.g. a config error) still leaves a row with the request on it.
 *
 * When `explicitId` names a row that already exists, it is re-selected
 * scoped to `worldId`: reusing an id that belongs to a different world
 * is refused outright (never silently creates/returns another world's
 * row), and reusing an id whose call already succeeded short-circuits —
 * no new PayPal call is made, the stored result is just replayed. This
 * is what makes `orders.create`/`payouts.send` idempotent for a
 * caller-supplied id (e.g. derived from a loan/note id): posting the
 * same logical payout twice can't move money twice.
 *
 * Writes directly with `db.insert` (rather than through `scoped()`) so an
 * explicit, caller-chosen `id` can be supplied — `scoped().insert()`
 * doesn't let the caller set the primary key. `worldId` is still only
 * ever the one passed in here.
 */
async function ensureOperationRow(
  db: Db,
  worldId: string,
  kind: string,
  id: string,
  loggedRequest: unknown,
): Promise<EnsureOperationRowResult> {
  const [inserted] = await db
    .insert(paypalOperations)
    .values({
      id,
      worldId,
      rail: "paypal",
      kind,
      requestId: id,
      status: "pending",
      attempts: 0,
      request: redact(loggedRequest),
    })
    .onConflictDoNothing({ target: paypalOperations.id })
    .returning();

  if (inserted) {
    return { id: inserted.id, reusedResult: null };
  }

  // The row already existed — this must be an explicit, caller-reused
  // operationId (a fresh `randomUUID()` would never collide).
  const [existing] = await db
    .select()
    .from(paypalOperations)
    .where(
      and(eq(paypalOperations.id, id), eq(paypalOperations.worldId, worldId)),
    );

  if (!existing) {
    throw new PayPalOperationReuseError(
      `operationId ${id} belongs to a different world, or vanished after a conflicting insert — refusing to reuse it`,
    );
  }

  if (existing.rail !== "paypal" || existing.kind !== kind) {
    throw new PayPalOperationReuseError(
      `operationId ${id} was already used for a different operation (rail=${existing.rail}, kind=${existing.kind}); refusing to reuse it for rail=paypal, kind=${kind}`,
    );
  }

  if (existing.status === "succeeded") {
    return {
      id: existing.id,
      reusedResult: {
        status: existing.httpStatus ?? 200,
        body: existing.response,
        operationId: existing.id,
      },
    };
  }

  return { id: existing.id, reusedResult: null };
}

/**
 * Writes the final outcome of a call onto its row — guarded by
 * `WHERE status <> 'succeeded'` so a losing concurrent attempt for the
 * same (reused) `operationId` can never downgrade a row some other,
 * already-finished attempt already marked `succeeded`. Whichever
 * attempt's UPDATE statement actually runs first wins; Postgres
 * evaluates the `WHERE` against the row as committed at that moment, so
 * this is safe without any extra locking.
 */
async function updateOperationRow(
  db: Db,
  worldId: string,
  id: string,
  patch: Partial<typeof paypalOperations.$inferInsert>,
): Promise<void> {
  await scoped(db, worldId).update(
    paypalOperations,
    patch,
    and(eq(paypalOperations.id, id), ne(paypalOperations.status, "succeeded")),
  );
}

/**
 * Idempotent PayPal REST call. Sends `PayPal-Request-Id` equal to the
 * `paypal_operations.id` created for this call, refreshes the access
 * token and retries once on a 401, retries up to twice (with 300ms/900ms
 * backoff) on a 5xx, a timed-out/aborted request, or any other network
 * error — always with the *same* request id — and persists the redacted
 * request/response, status, latency and attempt count. An OAuth token
 * failure (network/timeout/non-2xx) is retried within the same budget as
 * the main request, rather than failing the call outright.
 *
 * Every exit — success, a final non-2xx, a network-error budget
 * exhaustion, or an unexpected/config error — writes a terminal
 * `paypal_operations` status (`succeeded`/`failed`); none leave the row
 * stuck `pending`. Throws `PayPalApiError` on a final non-2xx response
 * (including an exhausted network-error budget, as status 0), or
 * rethrows a `PayPalConfigError` / wraps anything else as
 * `PayPalNetworkError`.
 */
export async function paypalFetch<T>(
  db: Db,
  op: PaypalFetchOp,
): Promise<PaypalFetchResult<T>> {
  const { worldId, kind, method, path, body: requestBody } = op;
  const operationIdCandidate = op.operationId ?? randomUUID();

  const loggedRequest = {
    method,
    path,
    headers: buildLoggedHeaders(operationIdCandidate),
    body: requestBody,
  };

  const { id: operationId, reusedResult } = await ensureOperationRow(
    db,
    worldId,
    kind,
    operationIdCandidate,
    loggedRequest,
  );

  if (reusedResult) {
    return reusedResult as PaypalFetchResult<T>;
  }

  const requestId = operationId;
  const startedAt = Date.now();

  let attempts = 0;
  let lastStatus = 0;
  let lastBody: unknown;
  let lastErrorMessage: string | undefined;
  /**
   * Set whenever `lastStatus === 0` (every stage that can fail this way —
   * OAuth, the request itself, or reading its body — lands here), so the
   * final `PayPalApiError.details` always says *what* failed, not just
   * that something did. For an exhausted OAuth failure this carries the
   * OAuth endpoint's own status/body.
   */
  let lastFailureDetails: Record<string, unknown> | undefined;
  let fatalError: unknown;

  function describeOAuthFailure(err: unknown): Record<string, unknown> {
    if (err instanceof PayPalOAuthError) {
      return {
        stage: "oauth",
        oauthStatus: err.status,
        oauthResponseBody: err.responseBody,
      };
    }
    return { stage: "oauth", message: describeError(err) };
  }

  try {
    const { baseUrl } = paypalConfig();
    const url = `${baseUrl}${path}`;

    let triedRefresh = false;
    let forceTokenRefresh = false;
    let retries = 0;

    for (;;) {
      attempts += 1;

      let accessToken: string;
      try {
        accessToken = await getAccessToken(forceTokenRefresh);
        forceTokenRefresh = false;
      } catch (err) {
        lastErrorMessage = describeError(err);
        lastStatus = 0;
        lastBody = undefined;
        lastFailureDetails = describeOAuthFailure(err);
        if (retries < MAX_RETRIES) {
          await sleep(BACKOFF_MS[retries] as number);
          retries += 1;
          continue;
        }
        break;
      }

      // The request and reading its body are one retryable unit: an
      // abort/timeout can happen mid-body-read just as easily as while
      // waiting for headers, and both must be retried with the same
      // request id exactly like a failure to connect at all.
      let res: Response;
      let parsedBody: unknown;
      try {
        res = await fetch(url, {
          method,
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${accessToken}`,
            "PayPal-Request-Id": requestId,
          },
          signal: AbortSignal.timeout(paypalTimeoutMs()),
          ...(requestBody !== undefined
            ? { body: JSON.stringify(requestBody) }
            : {}),
        });
        parsedBody = await parseJsonSafe(res);
      } catch (err) {
        // Includes an `AbortError` from the timeout above (whether it
        // fired before headers arrived or mid-body-read) — treated the
        // same as any other network error.
        lastErrorMessage = describeError(err);
        lastStatus = 0;
        lastBody = undefined;
        lastFailureDetails = { stage: "request", message: lastErrorMessage };
        if (retries < MAX_RETRIES) {
          await sleep(BACKOFF_MS[retries] as number);
          retries += 1;
          continue;
        }
        break;
      }

      lastStatus = res.status;
      lastBody = parsedBody;
      lastErrorMessage = undefined;
      lastFailureDetails = undefined;

      if (lastStatus === 401 && !triedRefresh) {
        triedRefresh = true;
        forceTokenRefresh = true;
        continue;
      }

      if (lastStatus >= 500 && retries < MAX_RETRIES) {
        await sleep(BACKOFF_MS[retries] as number);
        retries += 1;
        continue;
      }

      break;
    }
  } catch (err) {
    fatalError = err;
    if (attempts === 0) {
      attempts = 1;
    }
    lastStatus = 0;
    lastBody = undefined;
    lastErrorMessage = describeError(err);
  }

  const latencyMs = Date.now() - startedAt;
  const success =
    fatalError === undefined && lastStatus >= 200 && lastStatus < 300;

  // Every exit path reaches this update — success, a final non-2xx, an
  // exhausted retry budget, or the fatal-error catch above — so no row is
  // ever left `pending`. `updateOperationRow` itself guards against
  // downgrading a row a concurrent, already-finished attempt for the
  // same operationId marked `succeeded`.
  await updateOperationRow(db, worldId, operationId, {
    response: redact(lastStatus === 0 ? lastFailureDetails : lastBody),
    httpStatus: lastStatus === 0 ? null : lastStatus,
    latencyMs,
    attempts,
    status: success ? "succeeded" : "failed",
    lastError: success
      ? null
      : (lastErrorMessage ?? extractErrorName(lastBody)),
    paypalId: extractPaypalId(lastBody),
  });

  if (fatalError !== undefined) {
    if (fatalError instanceof PayPalConfigError) {
      throw fatalError;
    }
    throw new PayPalNetworkError(
      lastErrorMessage ?? "PayPal request failed before any attempt completed",
      fatalError,
    );
  }

  if (!success) {
    // Whichever stage ultimately failed (OAuth, the request, or reading
    // its body), an exhausted network-side failure always surfaces as
    // the same error shape: status 0, name "PayPalNetworkError" — with
    // `details` saying which stage it was and, for OAuth, PayPal's own
    // status/body.
    throw new PayPalApiError({
      status: lastStatus,
      name: lastStatus === 0 ? "PayPalNetworkError" : extractErrorName(lastBody),
      details:
        lastStatus === 0
          ? redact(lastFailureDetails ?? { message: lastErrorMessage })
          : redact(lastBody),
      debugId: extractDebugId(lastBody),
    });
  }

  return { status: lastStatus, body: lastBody as T, operationId };
}
