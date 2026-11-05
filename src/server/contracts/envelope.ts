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

/** Builds an error envelope. `data` is always an empty object. */
export function fail(
  status: string,
  summary: string,
  reasonCodes: string[],
): Envelope<Record<string, never>> {
  return {
    status,
    summary,
    reason_codes: reasonCodes,
    data: {},
    next_actions: [],
    docs_url: docsUrl(),
  };
}
