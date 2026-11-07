import { PayPalConfigError, paypalConfig, paypalTimeoutMs } from "./config";
import { redact } from "./redact";
import { PayPalOAuthError, getAccessToken } from "./token";

/** Up to 2 retries (3 total attempts) on a 5xx or network error, same backoff PayPal recommends. */
const MAX_RETRIES = 2;
const DEFAULT_BACKOFF_MS = [300, 900] as const;
let backoffMs: readonly [number, number] = DEFAULT_BACKOFF_MS;

/**
 * Test-only hook: overrides the inline retry backoff delays so retry
 * tests don't have to sleep for real (300ms/900ms, compounding across
 * several tests).
 */
export function __setBackoffMsForTests(ms: readonly [number, number]): void {
  backoffMs = ms;
}

/** Test-only hook: restores the real PayPal-recommended backoff delays. */
export function __resetBackoffMsForTests(): void {
  backoffMs = DEFAULT_BACKOFF_MS;
}

/**
 * Hard cap on one `paypalFetch` call: every attempt, token fetch and
 * backoff sleep together. This bounds how long an `executeOperation` run
 * can hold its claim: a run makes at most two `paypalFetch` calls
 * (capture + recovery GET) = 120s, which must stay below the stale-claim
 * window `STALE_CLAIM_INTERVAL` (3 minutes, operations.ts) so a live
 * attempt is never reclaimed. Keep these two constants in step.
 */
export const PAYPAL_TOTAL_DEADLINE_MS = 60_000;
let totalDeadlineMs = PAYPAL_TOTAL_DEADLINE_MS;

/** Test-only hook: shortens the total deadline. */
export function __setTotalDeadlineMsForTests(ms: number): void {
  totalDeadlineMs = ms;
}

/** Test-only hook: restores `PAYPAL_TOTAL_DEADLINE_MS`. */
export function __resetTotalDeadlineMsForTests(): void {
  totalDeadlineMs = PAYPAL_TOTAL_DEADLINE_MS;
}

export interface PaypalHttpRequest {
  method: "GET" | "POST" | "PATCH";
  path: string;
  body?: unknown;
  /** Sent as `PayPal-Request-Id` on every attempt of a POST/PATCH, including retries (not on GET). */
  requestId: string;
  /**
   * Optional per-call total deadline (ms), used only when shorter than the
   * global `PAYPAL_TOTAL_DEADLINE_MS` — e.g. webhook verification, which
   * must answer PayPal quickly.
   */
  deadlineMs?: number;
}

/**
 * The final HTTP response PayPal gave this call — 2xx or not. A non-2xx
 * is *returned*, not thrown: deciding what it means for the operation
 * (succeeded / retryable / terminal) is `operations.ts`'s job.
 */
export interface PaypalHttpResponse {
  httpStatus: number;
  body: unknown;
  /** HTTP attempts this call made (the 401 token refresh and inline retries included). */
  attempts: number;
  latencyMs: number;
}

/**
 * A non-2xx PayPal outcome surfaced as an exception — thrown by the rail
 * facades (`rail/operationRail.ts`) when an operation didn't succeed.
 * `paypalFetch` itself never throws this.
 */
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
 * The inline retry budget ran out without PayPal ever returning an HTTP
 * response (network error, timeout, or the OAuth token request failing).
 * `details.stage` says which (`"oauth"` | `"request"`); for OAuth it also
 * carries the token endpoint's own status/body (redacted).
 */
export class PayPalNetworkError extends Error {
  constructor(
    message: string,
    readonly attempts: number,
    readonly details: Record<string, unknown>,
    readonly latencyMs: number,
  ) {
    super(message);
    this.name = "PayPalNetworkError";
  }
}

/**
 * A derived operation id is already used for a different `rail`/`kind`
 * (or by another world). PayPal is never called in this case.
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

class DeadlineExceededError extends Error {
  constructor() {
    super("PayPal call exceeded its total deadline");
    this.name = "DeadlineExceededError";
  }
}

/** Rejects with `DeadlineExceededError` if `promise` hasn't settled within `ms`. */
async function withinDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new DeadlineExceededError()), Math.max(ms, 0));
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function describeOAuthFailure(err: unknown): Record<string, unknown> {
  if (err instanceof PayPalOAuthError) {
    return {
      stage: "oauth",
      oauthStatus: err.status,
      oauthResponseBody: redact(err.responseBody),
    };
  }
  return { stage: "oauth", message: describeError(err) };
}

/**
 * Pure PayPal REST HTTP client. It writes no database rows and knows
 * nothing about `paypal_operations` — `operations.ts` owns every status,
 * attempts, backoff and `claimed_at` write (Ruling H).
 *
 * - Sends `PayPal-Request-Id: req.requestId` on every attempt of a write
 *   (POST/PATCH); a GET is a read and carries no idempotency key.
 * - Caches the OAuth token; on a 401 refreshes it once and retries.
 * - Retries a 5xx, a timeout/abort or any other network error (including
 *   an OAuth token failure) up to twice, with 300ms/900ms backoff.
 * - Never runs longer than `PAYPAL_TOTAL_DEADLINE_MS` in total; past it,
 *   the last HTTP response is returned if there was one, else
 *   `PayPalNetworkError` (`details.stage = "deadline"`).
 * - Sends `Prefer: return=representation` on POST/PATCH so PayPal returns
 *   the full resource (e.g. the capture record) rather than a minimal body.
 * - Returns the final HTTP response, 2xx or not.
 * - Throws `PayPalNetworkError` (carrying `attempts`) when the retry
 *   budget ran out without any HTTP response, or `PayPalConfigError`
 *   when the PayPal credentials aren't configured (nothing was sent).
 *
 * IMPORTANT — never call this from inside a `db.transaction` (nor
 * `executeOperation`, which calls it). A PayPal round trip can take
 * seconds; holding a transaction open across it blocks other work and
 * risks the transaction timing out with an ambiguous outcome (money may
 * or may not have moved). Enqueue inside the transaction
 * (`enqueueOperation(ctx.tx, …)`), then `ctx.afterCommit(() =>
 * executeOperation(ctx.db, id))`. In app code only
 * `src/server/paypal/operations.ts` calls this — enforced statically by
 * `tests/unit/paypal/noTransactionCalls.test.ts`.
 */
export async function paypalFetch(req: PaypalHttpRequest): Promise<PaypalHttpResponse> {
  const { baseUrl } = paypalConfig(); // throws PayPalConfigError before any attempt
  const url = `${baseUrl}${req.path}`;
  const startedAt = Date.now();
  const deadline =
    startedAt + (req.deadlineMs !== undefined ? Math.min(req.deadlineMs, totalDeadlineMs) : totalDeadlineMs);
  const remaining = () => deadline - Date.now();

  let attempts = 0;
  let retries = 0;
  let triedRefresh = false;
  let forceTokenRefresh = false;
  let lastFailure: Record<string, unknown> = { stage: "request" };
  let lastResponse: PaypalHttpResponse | undefined;

  const giveUp = (): PaypalHttpResponse => {
    if (lastResponse) {
      return { ...lastResponse, attempts, latencyMs: Date.now() - startedAt };
    }
    throw new PayPalNetworkError(
      `PayPal ${req.method} ${req.path} failed without a response after ${attempts} attempts`,
      attempts,
      lastFailure,
      Date.now() - startedAt,
    );
  };

  for (;;) {
    if (remaining() <= 0) {
      lastFailure = { ...lastFailure, stage: "deadline", lastStage: lastFailure.stage };
      return giveUp();
    }
    attempts += 1;

    let accessToken: string | undefined;
    try {
      accessToken = await withinDeadline(getAccessToken(forceTokenRefresh), remaining());
      forceTokenRefresh = false;
    } catch (err) {
      if (err instanceof PayPalConfigError) {
        throw err;
      }
      lastFailure = describeOAuthFailure(err);
    }

    if (accessToken !== undefined) {
      // The request and reading its body are one retryable unit: an
      // abort/timeout can fire mid-body-read just as easily as while
      // waiting for headers.
      let res: Response | undefined;
      let parsedBody: unknown;
      try {
        res = await fetch(url, {
          method: req.method,
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${accessToken}`,
            // APIMatic audit: `PayPal-Request-Id` is an idempotency key for
            // writes (createOrder/captureOrder declare it); `getOrder`
            // declares none, so a read doesn't send it. `Prefer` is
            // `return=representation` (the SDK's default is
            // `return=minimal`) so a capture carries its fee breakdown.
            ...(req.method === "GET"
              ? {}
              : { "PayPal-Request-Id": req.requestId, Prefer: "return=representation" }),
          },
          signal: AbortSignal.timeout(Math.max(1, Math.min(paypalTimeoutMs(), remaining()))),
          ...(req.body !== undefined ? { body: JSON.stringify(req.body) } : {}),
        });
        parsedBody = await parseJsonSafe(res);
      } catch (err) {
        res = undefined;
        lastFailure = { stage: "request", message: describeError(err) };
      }

      if (res) {
        lastResponse = {
          httpStatus: res.status,
          body: parsedBody,
          attempts,
          latencyMs: Date.now() - startedAt,
        };
        if (res.status === 401 && !triedRefresh) {
          triedRefresh = true;
          forceTokenRefresh = true;
          continue;
        }
        if (res.status >= 500 && retries < MAX_RETRIES) {
          await sleep(Math.min(backoffMs[retries] as number, Math.max(remaining(), 0)));
          retries += 1;
          continue;
        }
        return lastResponse;
      }
    }

    if (retries < MAX_RETRIES) {
      await sleep(Math.min(backoffMs[retries] as number, Math.max(remaining(), 0)));
      retries += 1;
      continue;
    }

    return giveUp();
  }
}
