/**
 * PayPal sandbox configuration, read lazily from `process.env` on every
 * call (no caching) so tests can swap credentials between cases via
 * `process.env.PAYPAL_*` without restarting the process.
 */

export class PayPalConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayPalConfigError";
  }
}

export interface PayPalConfig {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
}

const DEFAULT_BASE_URL = "https://api-m.sandbox.paypal.com";
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Reads `PAYPAL_BASE_URL` (defaults to the sandbox host), `PAYPAL_CLIENT_ID`
 * and `PAYPAL_CLIENT_SECRET` from `process.env`. Throws `PayPalConfigError`
 * if either credential is missing.
 */
export function paypalConfig(): PayPalConfig {
  const baseUrl = process.env.PAYPAL_BASE_URL ?? DEFAULT_BASE_URL;
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new PayPalConfigError(
      "PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET must be set in the environment",
    );
  }

  return { baseUrl, clientId, clientSecret };
}

/**
 * Per-request timeout, in ms, for every outbound PayPal fetch (token and
 * API calls alike). Defaults to 15s; override with `PAYPAL_TIMEOUT_MS`.
 * An abort from this timeout is treated as a network error upstream (and
 * so is retried with the same `PayPal-Request-Id`, within the normal
 * retry budget).
 */
export function paypalTimeoutMs(): number {
  const raw = process.env.PAYPAL_TIMEOUT_MS;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
}
