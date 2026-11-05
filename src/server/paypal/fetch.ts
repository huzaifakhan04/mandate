import { randomUUID } from "crypto";

import { eq } from "drizzle-orm";

import type { Db } from "../db/client";
import { scoped } from "../db/scoped";
import { paypalOperations } from "../db/schema";
import { paypalConfig } from "./config";
import { redact } from "./redact";
import { getAccessToken } from "./token";

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
   * Caller-supplied operation id. Used by callers (e.g. `payouts.send`)
   * that must embed the id into the request body itself (PayPal's
   * `sender_batch_id`) before the request is sent. When omitted, a fresh
   * id is generated and becomes the `paypal_operations.id` /
   * `PayPal-Request-Id`.
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
 * Creates the `paypal_operations` row for this call before any request is
 * sent. Its id is the value PayPal's idempotency header (`PayPal-Request-Id`)
 * carries for every attempt of this call, including retries.
 *
 * Writes directly with `db.insert` (rather than through `scoped()`) so an
 * explicit, caller-chosen `id` can be supplied — `scoped().insert()`
 * doesn't let the caller set the primary key. `worldId` is still only ever
 * the one passed in here.
 */
async function createOperationRow(
  db: Db,
  worldId: string,
  kind: string,
  explicitId: string | undefined,
): Promise<string> {
  const id = explicitId ?? randomUUID();
  const [row] = await db
    .insert(paypalOperations)
    .values({
      id,
      worldId,
      rail: "paypal",
      kind,
      requestId: id,
      status: "pending",
      attempts: 0,
    })
    .onConflictDoNothing({ target: paypalOperations.id })
    .returning();

  if (row) {
    return row.id;
  }
  // The row already existed (an explicit, reused operationId) — trust the caller's id.
  return id;
}

async function updateOperationRow(
  db: Db,
  worldId: string,
  id: string,
  patch: Partial<typeof paypalOperations.$inferInsert>,
): Promise<void> {
  await scoped(db, worldId).update(
    paypalOperations,
    patch,
    eq(paypalOperations.id, id),
  );
}

/**
 * Idempotent PayPal REST call. Sends `PayPal-Request-Id` equal to the
 * `paypal_operations.id` created for this call, refreshes the access
 * token and retries once on a 401, retries up to twice (with 300ms/900ms
 * backoff) on a 5xx or network error — always with the *same* request id
 * — and persists the redacted request/response, status, latency and
 * attempt count. Throws `PayPalApiError` on a final non-2xx response.
 */
export async function paypalFetch<T>(
  db: Db,
  op: PaypalFetchOp,
): Promise<PaypalFetchResult<T>> {
  const { worldId, kind, method, path, body: requestBody } = op;
  const operationId = await createOperationRow(
    db,
    worldId,
    kind,
    op.operationId,
  );
  const requestId = operationId;

  const { baseUrl } = paypalConfig();
  const url = `${baseUrl}${path}`;

  let accessToken = await getAccessToken();
  let triedRefresh = false;
  let networkRetries = 0;
  let attempts = 0;
  let lastStatus = 0;
  let lastBody: unknown;
  let networkErrorMessage: string | undefined;
  const startedAt = Date.now();

  for (;;) {
    attempts += 1;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
      "PayPal-Request-Id": requestId,
    };

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        ...(requestBody !== undefined
          ? { body: JSON.stringify(requestBody) }
          : {}),
      });
    } catch (err) {
      networkErrorMessage = err instanceof Error ? err.message : String(err);
      lastStatus = 0;
      lastBody = undefined;
      if (networkRetries < MAX_RETRIES) {
        await sleep(BACKOFF_MS[networkRetries] as number);
        networkRetries += 1;
        continue;
      }
      break;
    }

    lastStatus = res.status;
    lastBody = await parseJsonSafe(res);
    networkErrorMessage = undefined;

    if (lastStatus === 401 && !triedRefresh) {
      triedRefresh = true;
      accessToken = await getAccessToken(true);
      continue;
    }

    if (lastStatus >= 500 && networkRetries < MAX_RETRIES) {
      await sleep(BACKOFF_MS[networkRetries] as number);
      networkRetries += 1;
      continue;
    }

    break;
  }

  const latencyMs = Date.now() - startedAt;
  const success = lastStatus >= 200 && lastStatus < 300;

  await updateOperationRow(db, worldId, operationId, {
    request: redact({ method, path, headers: buildLoggedHeaders(requestId), body: requestBody }),
    response: redact(lastBody),
    httpStatus: lastStatus === 0 ? null : lastStatus,
    latencyMs,
    attempts,
    status: success ? "succeeded" : "failed",
    lastError: success
      ? null
      : (networkErrorMessage ?? extractErrorName(lastBody)),
    paypalId: extractPaypalId(lastBody),
  });

  if (!success) {
    if (lastStatus === 0) {
      throw new PayPalApiError({
        status: 0,
        name: "PayPalNetworkError",
        details: { message: networkErrorMessage },
      });
    }
    throw new PayPalApiError({
      status: lastStatus,
      name: extractErrorName(lastBody),
      details: lastBody,
      debugId: extractDebugId(lastBody),
    });
  }

  return { status: lastStatus, body: lastBody as T, operationId };
}

/**
 * The headers logged alongside the request body, with the bearer token
 * never included in the first place (not merely masked) — only the
 * non-secret `PayPal-Request-Id` is kept for traceability.
 */
function buildLoggedHeaders(requestId: string): Record<string, string> {
  return { "PayPal-Request-Id": requestId };
}
