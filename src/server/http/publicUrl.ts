/**
 * Absolute URLs for redirects. Self-hosted `next start` (e.g. Render)
 * builds `request.url` from its own bind address (`localhost:<PORT>`),
 * ignoring the proxy's Host header, so redirects resolved against it send
 * browsers to localhost. There, in production, the public origin comes
 * from PUBLIC_BASE_URL. Vercel fills `request.url` with the real host, and
 * `next dev` / tests are served directly, so they keep `request.url`.
 */
function publicOrigin(request: Request): string {
  const base = process.env.PUBLIC_BASE_URL;
  if (process.env.NODE_ENV === "production" && !process.env.VERCEL && base) {
    try {
      return new URL(base).origin;
    } catch {
      // A malformed PUBLIC_BASE_URL falls back to the request's origin.
    }
  }
  return new URL(request.url).origin;
}

/** `path` (absolute path, may carry a query) resolved against the public origin. */
export function absoluteUrl(path: string, request: Request): string {
  return new URL(path, publicOrigin(request)).toString();
}
