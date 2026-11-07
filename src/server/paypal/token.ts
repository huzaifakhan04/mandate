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
  /** Seconds. RFC 6749 §5.1 makes it RECOMMENDED, not required. */
  expires_in?: number;
}

/**
 * Lifetime assumed when PayPal omits `expires_in`. The APIMatic SDK caches
 * such a token forever (until a 401); we cap it instead — a 401 still
 * forces a refresh either way (`paypalFetch`).
 */
const DEFAULT_TOKEN_TTL_MS = 5 * 60_000;

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

/**
 * APIMatic audit: the SDK *decodes* the token response against a schema
 * rather than casting it. A 2xx without a non-empty `access_token` (or with
 * a non-numeric `expires_in`) is a `PayPalOAuthError`, never a cached
 * `undefined` token sent as `Bearer undefined`.
 */
function parseTokenResponse(status: number, text: string): OAuthTokenResponse {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new PayPalOAuthError(status, "token response is not JSON");
  }
  const record = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const accessToken = record.access_token;
  const expiresIn = record.expires_in;
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new PayPalOAuthError(status, "token response has no access_token");
  }
  if (expiresIn !== undefined && (typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0)) {
    throw new PayPalOAuthError(status, "token response has an invalid expires_in");
  }
  return { access_token: accessToken, ...(expiresIn !== undefined ? { expires_in: expiresIn } : {}) };
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

  const body = parseTokenResponse(res.status, await res.text());
  cached = {
    accessToken: body.access_token,
    expiresAt:
      body.expires_in === undefined ? Date.now() + DEFAULT_TOKEN_TTL_MS : Date.now() + body.expires_in * 1000,
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
