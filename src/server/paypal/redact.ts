/**
 * Redaction used before persisting PayPal request/response bodies to
 * `paypal_operations`. Two rules:
 *  - any object key matching `/token|secret|password|authorization/i` has
 *    its value replaced with `"[REDACTED]"`, regardless of type;
 *  - any string value that looks like an email address has its local
 *    part truncated to the first two characters (`ab***@example.com`).
 */

const SENSITIVE_KEY_RE = /token|secret|password|authorization/i;
const EMAIL_RE = /^([^\s@]+)(@[^\s@]+)$/;

/** `ab***@example.com`; a value that isn't an email is returned unchanged. */
export function maskEmail(value: string): string {
  const match = EMAIL_RE.exec(value);
  if (!match) {
    return value;
  }
  const [, local, domain] = match as unknown as [string, string, string];
  const visible = local.slice(0, 2);
  const masked = "*".repeat(Math.max(local.length - visible.length, 0));
  return `${visible}${masked}${domain}`;
}

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redact(item));
  }

  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (SENSITIVE_KEY_RE.test(key)) {
        result[key] = "[REDACTED]";
      } else {
        result[key] = redact(entry);
      }
    }
    return result;
  }

  if (typeof value === "string") {
    return maskEmail(value);
  }

  // `jsonb` columns go through `JSON.stringify`, which cannot serialize
  // `bigint` (e.g. `amountCents`) — store its decimal string instead.
  if (typeof value === "bigint") {
    return value.toString();
  }

  return value;
}
