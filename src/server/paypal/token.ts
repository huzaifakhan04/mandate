import { paypalConfig } from "./config";

interface CachedToken {
  accessToken: string;
  /** Epoch ms after which the token must be refreshed. */
  expiresAt: number;
}

/** Refresh this long before the token's real expiry, to stay ahead of clock drift and in-flight requests. */
const REFRESH_SKEW_MS = 60_000;

let cached: CachedToken | null = null;

interface OAuthTokenResponse {
  access_token: string;
  expires_in: number;
}

/**
 * Returns a cached PayPal OAuth access token, refreshing it when it is
 * missing, within `REFRESH_SKEW_MS` of expiry, or when `force` is true
 * (used by `paypalFetch` after a 401).
 */
export async function getAccessToken(force = false): Promise<string> {
  const now = Date.now();
  if (!force && cached && cached.expiresAt - REFRESH_SKEW_MS > now) {
    return cached.accessToken;
  }

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
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `PayPal OAuth token request failed (${res.status}): ${text}`,
    );
  }

  const body = (await res.json()) as OAuthTokenResponse;
  cached = {
    accessToken: body.access_token,
    expiresAt: now + body.expires_in * 1000,
  };
  return cached.accessToken;
}

/** Test-only: clears the in-memory token cache between unit tests. */
export function __resetTokenCacheForTests(): void {
  cached = null;
}
