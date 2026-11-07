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
 * `PUBLIC_BASE_URL` is unset (e.g. local dev). With a `toolName`, it
 * resolves to that tool's own anchor in `/agents.md` (the tool reference
 * section gives every registered tool an anchor matching its name) — used
 * by `runTool` to point each response at its own documentation instead of
 * the page's top.
 */
function docsUrl(toolName?: string): string {
  const base = (process.env.PUBLIC_BASE_URL || "http://localhost:3000").replace(/\/+$/, "");
  return toolName ? `${base}/agents.md#${toolName}` : `${base}/agents.md`;
}

/** Exported so `runTool` can re-point an already-built envelope's `docs_url` at its own tool anchor. */
export function docsUrlForTool(toolName: string): string {
  return docsUrl(toolName);
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
  // Task 6 (lending).
  DISCLOSURE_MISMATCH: 400,
  OFFER_EXPIRED: 400,
  INVALID_TRANSITION: 409,
  OPEN_LOAN_EXISTS: 409,
  // Task 7 (repayment).
  AMOUNT_EXCEEDS_OUTSTANDING: 400,
  // P2 Task 2 (KYA tiers): borrowing needs a claim, then a signed mandate.
  CLAIM_REQUIRED: 403,
  MANDATE_REQUIRED: 403,
  // P2 Task 4 (mandates): accept_offer re-checks the mandate the offer was made under.
  MANDATE_REVOKED: 409,
  MANDATE_LIMIT: 400,
  // P4 Task 1: a loan of the principal's is substandard — no new loans for any of their agents.
  MANDATE_FROZEN: 409,
  // P3 Task 4 (ALA G): apply_for_loan named a mandate version that is no longer current.
  MANDATE_CHANGED: 409,
  // P5 Task 3: accept_offer re-checks the treasury policy (reserve floor, concentration, daily budget).
  TREASURY_LIMIT: 409,
  // P2 Task 3 (Ed25519 request signing).
  SIGNATURE_REQUIRED: 401,
  SIGNATURE_INVALID: 401,
  SIGNATURE_EXPIRED: 401,
  SIGNATURE_REPLAYED: 401,
  // P2 Task 6 (private worlds): the agent's sandbox world was reset.
  WORLD_ARCHIVED: 410,
  // P7 (repayment plans): plan_repayments / reschedule_installment broke a plan rule, or the loan already has a plan.
  INVALID_PLAN: 400,
  PLAN_EXISTS: 409,
};

/** Maps an envelope's `status` to the HTTP status it should be served with. */
export function httpStatusForEnvelope(envelope: Envelope<unknown>): number {
  return STATUS_HTTP[envelope.status] ?? 200;
}

/**
 * The full known `status` → HTTP table, as `{ status, http }` rows in
 * declaration order. Exported so `/agents.md`'s errors section documents
 * every transport-level status exactly once, straight from this table —
 * it can never drift from what `httpStatusForEnvelope` actually does.
 */
export function knownStatusTable(): Array<{ status: string; http: number }> {
  return Object.entries(STATUS_HTTP).map(([status, http]) => ({ status, http }));
}
