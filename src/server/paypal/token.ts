import { paypalConfig, paypalTimeoutMs } from "./config";

interface CachedToken {
  accessToken: string;
  /** Epoch ms after which the token must be refreshed. */
  expiresAt: number;
}

/** Refresh this long before the token's real expiry, to stay ahead of clock drift and in-flight requests. */
const REFRESH_SKEW_MS = 60_000;

let cached: CachedToken | null = null;

/**
 * Single-flight guard: while an OAuth request is in flight, concurrent
 * callers await the same promise instead of each firing their own
 * `/v1/oauth2/token` request.
 */
let inFlight: Promise<string> | null = null;

interface OAuthTokenResponse {
  access_token: string;
  expires_in: number;
}

/**
 * A non-2xx response from `/v1/oauth2/token` itself (as opposed to a
 * network/timeout failure reaching it at all). Carries the OAuth
 * endpoint's own status/body so a caller that exhausts its retry budget
 * can surface *what the OAuth failure actually was* in its error
 * details, instead of a bare "network error".
 */
export class PayPalOAuthError extends Error {
  constructor(
    readonly status: number,
    readonly responseBody: string,
  ) {
    super(`PayPal OAuth token request failed (${status}): ${responseBody}`);
    this.name = "PayPalOAuthError";
  }
}

async function requestNewToken(): Promise<string> {
  const { baseUrl, clientId, clientSecret } = paypalConfig();
  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString(
    "base64",
  );

  const res = await fetch(`${baseUrl}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
    signal: AbortSignal.timeout(paypalTimeoutMs()),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new PayPalOAuthError(res.status, text);
  }

  const body = (await res.json()) as OAuthTokenResponse;
  cached = {
    accessToken: body.access_token,
    expiresAt: Date.now() + body.expires_in * 1000,
  };
  return cached.accessToken;
}

/**
 * Returns a cached PayPal OAuth access token, refreshing it when it is
 * missing, within `REFRESH_SKEW_MS` of expiry, or when `force` is true
 * (used by `paypalFetch` after a 401). Concurrent refreshes are
 * single-flighted: only one `/v1/oauth2/token` request is ever in flight
 * at a time. A network/timeout/non-2xx failure here propagates to the
 * caller as a plain `Error` — `paypalFetch` treats it the same as any
 * other network error and retries within its own backoff budget.
 */
export async function getAccessToken(force = false): Promise<string> {
  const now = Date.now();
  if (!force && cached && cached.expiresAt - REFRESH_SKEW_MS > now) {
    return cached.accessToken;
  }

  if (!inFlight) {
    inFlight = requestNewToken().finally(() => {
      inFlight = null;
    });
  }

  return inFlight;
}

/** Test-only: clears the in-memory token cache between unit tests. */
export function __resetTokenCacheForTests(): void {
  cached = null;
  inFlight = null;
}
