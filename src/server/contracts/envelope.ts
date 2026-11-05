/**
 * The response envelope every tool (REST and MCP) returns. Shape is fixed by
 * the global constraints: `{ status, summary, reason_codes, data,
 * next_actions, docs_url }`.
 */
export interface NextAction {
  tool: string;
  args: Record<string, unknown>;
}

export interface Envelope<T> {
  status: string;
  summary: string;
  reason_codes: string[];
  data: T;
  next_actions: NextAction[];
  docs_url: string;
}

/**
 * `docs_url` always resolves to a valid absolute URL, even when
 * `PUBLIC_BASE_URL` is unset (e.g. local dev).
 */
function docsUrl(): string {
  const base = process.env.PUBLIC_BASE_URL || "http://localhost:3000";
  return `${base.replace(/\/+$/, "")}/agents.md`;
}

export interface OkOptions {
  status: string;
  summary: string;
  next_actions?: NextAction[];
  reason_codes?: string[];
}

/** Builds a success (or otherwise non-error) envelope wrapping `data`. */
export function ok<T>(data: T, opts: OkOptions): Envelope<T> {
  return {
    status: opts.status,
    summary: opts.summary,
    reason_codes: opts.reason_codes ?? [],
    data,
    next_actions: opts.next_actions ?? [],
    docs_url: docsUrl(),
  };
}

/**
 * Builds an error envelope. `data` is an empty object unless an explicit
 * `data` is passed (e.g. `{ request_id }` for correlating an internal
 * error against server logs).
 */
export function fail(
  status: string,
  summary: string,
  reasonCodes: string[],
  data: Record<string, unknown> = {},
): Envelope<Record<string, unknown>> {
  return {
    status,
    summary,
    reason_codes: reasonCodes,
    data,
    next_actions: [],
    docs_url: docsUrl(),
  };
}

/**
 * The HTTP status every known envelope `status` maps to. A status not in
 * this table (e.g. a business-level outcome a handler invents, like
 * `REJECTED` or `PENDING`) is not a transport-level error — it defaults to
 * `200`: the request was handled fine, the *business* outcome just wasn't
 * a plain success. Only transport-level statuses runTool itself produces
 * (unknown tool, bad auth, bad input, conflicting/in-flight idempotency
 * key, an inactive agent, or an unexpected server error) get a non-200
 * status here.
 */
const STATUS_HTTP: Record<string, number> = {
  NOT_FOUND: 404,
  INVALID_REQUEST: 400,
  UNAUTHORIZED: 401,
  AGENT_NOT_ACTIVE: 403,
  METHOD_NOT_ALLOWED: 405,
  IDEMPOTENCY_CONFLICT: 409,
  IDEMPOTENCY_IN_PROGRESS: 409,
  INTERNAL_ERROR: 500,
  INSUFFICIENT_NOTE_BALANCE: 400,
  INSUFFICIENT_LIQUIDITY: 400,
  // Fix round 1.
  CHECKOUT_FAILED: 400,
  PAYOUT_RECEIVER_MISSING: 400,
};

/** Maps an envelope's `status` to the HTTP status it should be served with. */
export function httpStatusForEnvelope(envelope: Envelope<unknown>): number {
  return STATUS_HTTP[envelope.status] ?? 200;
}
