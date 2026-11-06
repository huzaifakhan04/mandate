/**
 * PII redaction for everything sent to OpenAI (Review Focus 5). The first
 * line of defence is the allowlisted input schemas (`ai/schemas.ts`): no
 * email, payout receiver, payer id, API key or principal id is ever a
 * field. This is the second: free-text fields an agent or human controls
 * (agent name, operator, file name) are scrubbed of anything that looks
 * like one.
 */

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
/** Any `mnd_…` API key or key prefix (`auth/apiKeys.ts`), whole or truncated. */
const API_KEY_RE = /\bmnd_[A-Za-z0-9_]*/g;
const UUID_RE = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g;
/**
 * PayPal payer / merchant ids: 13 upper-case alphanumerics with at least
 * one digit and one letter (e.g. `SIMPAYER00001`, `7WJ8XLGQZ9P2A`).
 */
const PAYER_ID_RE = /\b(?=[A-Z0-9]{13}\b)(?=[A-Z0-9]*[0-9])(?=[A-Z0-9]*[A-Z])[A-Z0-9]{13}\b/g;

export function redactText(text: string): string {
  return text
    .replace(EMAIL_RE, "[email]")
    .replace(API_KEY_RE, "[key]")
    .replace(UUID_RE, "[id]")
    .replace(PAYER_ID_RE, "[payer-id]");
}

/** Deep-redacts every string in a JSON-like value (objects, arrays, scalars). */
export function redact<T>(value: T): T {
  if (typeof value === "string") {
    return redactText(value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redact(item)) as T;
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item)])) as T;
  }
  return value;
}
