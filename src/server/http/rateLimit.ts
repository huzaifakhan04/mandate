/**
 * P6: a small in-memory token bucket keyed by client (IP). Each key holds
 * up to `capacity` tokens and regains `refillPerSecond`; a request spends
 * one. Per-instance only (a serverless instance has its own buckets) —
 * enough to stop one browser or script from hammering the public console
 * snapshot, not a distributed limiter. The map is bounded: when it grows
 * past `maxKeys`, the stalest buckets are dropped.
 */

export interface RateLimitResult {
  allowed: boolean;
  /** Whole tokens left after this request. */
  remaining: number;
  /** Seconds until one token is back (0 when allowed). */
  retryAfterSeconds: number;
}

export interface TokenBucketOptions {
  capacity: number;
  refillPerSecond: number;
  maxKeys?: number;
}

interface Bucket {
  tokens: number;
  updatedMs: number;
}

export function createTokenBucket({ capacity, refillPerSecond, maxKeys = 10_000 }: TokenBucketOptions) {
  const buckets = new Map<string, Bucket>();

  function evict(): void {
    if (buckets.size <= maxKeys) {
      return;
    }
    // Map order is recency order (`take` re-inserts), so the first keys are the stalest.
    for (const key of buckets.keys()) {
      if (buckets.size <= maxKeys) {
        break;
      }
      buckets.delete(key);
    }
  }

  return {
    take(key: string, nowMs: number = Date.now()): RateLimitResult {
      const bucket = buckets.get(key) ?? { tokens: capacity, updatedMs: nowMs };
      const elapsed = Math.max(0, nowMs - bucket.updatedMs) / 1000;
      bucket.tokens = Math.min(capacity, bucket.tokens + elapsed * refillPerSecond);
      bucket.updatedMs = nowMs;
      // Re-insert so Map order tracks recency.
      buckets.delete(key);
      buckets.set(key, bucket);
      evict();
      if (bucket.tokens >= 1) {
        bucket.tokens -= 1;
        return { allowed: true, remaining: Math.floor(bucket.tokens), retryAfterSeconds: 0 };
      }
      return { allowed: false, remaining: 0, retryAfterSeconds: Math.max(1, Math.ceil((1 - bucket.tokens) / refillPerSecond)) };
    },
    size(): number {
      return buckets.size;
    },
  };
}

/**
 * The caller's IP from the hosting proxy's headers, or `null`. Which header
 * is trustworthy depends on the host:
 * - Render (`RENDER` set) sits behind Cloudflare, which overwrites
 *   `cf-connecting-ip` / `true-client-ip` with the real client IP — but it
 *   keeps a client-supplied `x-forwarded-for` as the first hop, so that
 *   header is spoofable there and never read.
 * - Elsewhere (local dev, tests, a proxy that overwrites `x-forwarded-for`):
 *   the first `x-forwarded-for` hop, else `x-real-ip`; `cf-*` headers are
 *   not trusted there (a client could send them).
 */
export function clientIpFromHeaders(headers: Headers): string | null {
  if (process.env.RENDER) {
    const ip = headers.get("cf-connecting-ip")?.trim() || headers.get("true-client-ip")?.trim();
    return ip ? ip.slice(0, 64) : null;
  }
  const first = headers.get("x-forwarded-for")?.split(",")[0]?.trim() || headers.get("x-real-ip")?.trim();
  return first ? first.slice(0, 64) : null;
}

/** The client key for rate limiting: the trusted client IP (`clientIpFromHeaders`), else `unknown`. */
export function clientKey(request: Request): string {
  return clientKeyFromHeaders(request.headers);
}

/** `clientKey` from bare headers (the MCP route only has the request's headers per tool call). */
export function clientKeyFromHeaders(headers: Headers): string {
  return clientIpFromHeaders(headers) ?? "unknown";
}
