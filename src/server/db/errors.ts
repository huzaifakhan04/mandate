/**
 * Error helpers that are safe to log (M12, final review).
 *
 * Drizzle wraps a failed query in `DrizzleQueryError`, whose `message` is
 * `Failed query: <sql>\nparams: <values>` — the bound values can be API key
 * hashes, emails or payout receivers. Logs and stored job output must only
 * ever carry an error's name, Postgres SQLSTATE code and the driver's own
 * message, never the query text or its parameters.
 */

interface ErrorLike {
  name?: unknown;
  message?: unknown;
  code?: unknown;
  cause?: unknown;
}

function isErrorLike(value: unknown): value is ErrorLike {
  return typeof value === "object" && value !== null;
}

/** The innermost error worth describing: a Drizzle query wrapper is replaced by its driver `cause`. */
function unwrap(err: unknown): unknown {
  let current = err;
  for (let depth = 0; depth < 5; depth += 1) {
    if (!isErrorLike(current)) {
      return current;
    }
    const message = typeof current.message === "string" ? current.message : "";
    const isQueryWrapper = current.name === "DrizzleQueryError" || message.startsWith("Failed query:");
    if (isQueryWrapper && current.cause !== undefined) {
      current = current.cause;
      continue;
    }
    return current;
  }
  return current;
}

/** The Postgres SQLSTATE (e.g. `40P01`) of `err` or of any error in its `cause` chain, else `null`. */
export function pgErrorCode(err: unknown): string | null {
  let current = err;
  for (let depth = 0; depth < 5 && isErrorLike(current); depth += 1) {
    if (typeof current.code === "string" && /^[0-9A-Z]{5}$/.test(current.code)) {
      return current.code;
    }
    current = current.cause;
  }
  return null;
}

/** `40P01` deadlock_detected / `40001` serialization_failure — safe to retry in a fresh transaction. */
export function isRetryableTransactionError(err: unknown): boolean {
  const code = pgErrorCode(err);
  return code === "40P01" || code === "40001";
}

/** The error's message with any query text / params stripped (for logs and stored job output). */
export function safeErrorMessage(err: unknown): string {
  const inner = unwrap(err);
  if (!isErrorLike(inner)) {
    return String(inner);
  }
  const message = typeof inner.message === "string" ? inner.message : String(inner);
  if (message.startsWith("Failed query:")) {
    return "Failed query (query text and parameters omitted)";
  }
  // Belt and braces for any other wrapper that appends parameters.
  return message.split("\nparams:")[0]!;
}

/** `Name (CODE): message` — name, SQLSTATE code and a stripped message only. */
export function describeError(err: unknown): string {
  const inner = unwrap(err);
  const name = isErrorLike(inner) && typeof inner.name === "string" ? inner.name : "Error";
  const code = pgErrorCode(err);
  return `${name}${code ? ` (${code})` : ""}: ${safeErrorMessage(err)}`;
}
