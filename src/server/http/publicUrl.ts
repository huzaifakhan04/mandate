/**
 * Absolute URLs for redirects. `next start` behind a proxy (Render) builds
 * `request.url` from its own bind address (`localhost:<PORT>`), ignoring
 * the proxy's Host header, so redirects resolved against it send browsers
 * to localhost. In production the public origin therefore comes from
 * PUBLIC_BASE_URL; `next dev` and tests are served directly, so they keep
 * `request.url`.
 */
function publicOrigin(request: Request): string {
  const base = process.env.PUBLIC_BASE_URL;
  if (process.env.NODE_ENV === "production" && base) {
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
