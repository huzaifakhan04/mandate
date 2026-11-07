import { lt, sql } from "drizzle-orm";

import type { Db } from "../db/client";
import { describeError } from "../db/errors";
import { rateLimits } from "../db/schema";
import type { RateLimitResult } from "./rateLimit";

/**
 * P8: Postgres-backed fixed-window rate limits, so a limit holds across
 * every server instance (the in-memory token bucket in `rateLimit.ts` is
 * per instance). One `rate_limits` row per (bucket, window); each hit is
 * ONE atomic statement —
 *
 *   INSERT … VALUES (key, window_start, 1)
 *   ON CONFLICT (bucket_key, window_start) DO UPDATE SET count = count + 1
 *   RETURNING count
 *
 * — so concurrent hits on separate connections serialise on the row and
 * each sees its own count (no read-then-write race). A hit over the limit
 * still counts (a client hammering a closed window stays closed).
 *
 * Fails OPEN on a database error (logged): a rate limiter must never take
 * the bank down with it. `RATE_LIMITS_DISABLED=1` turns every DB limit off
 * (the local e2e dev server, which shares one PGlite and one client IP
 * across all specs).
 */

export interface DbLimit {
  /** The bucket key, e.g. `register:ip:1.2.3.4`. Truncated to 200 chars. */
  key: string;
  /** Hits allowed per window. */
  limit: number;
  /** The window length. */
  windowMs: number;
  /**
   * The clock the window is measured on (default: real now). `apply_for_loan`'s
   * per-sim-day cap passes the world's simulated now.
   */
  now?: Date;
}

export interface DbRateLimitResult extends RateLimitResult {
  /** The first limit that refused the hit (`null` when allowed). */
  key: string | null;
}

export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

export function dbRateLimitsDisabled(): boolean {
  // Test/e2e escape hatch only — never honoured in production.
  return process.env.NODE_ENV !== "production" && process.env.RATE_LIMITS_DISABLED === "1";
}

/** The start of the fixed window `at` falls in. */
export function windowStart(at: Date, windowMs: number): Date {
  return new Date(Math.floor(at.getTime() / windowMs) * windowMs);
}

/** Bumps one bucket and returns its count in the current window. Throws on a DB error. */
export async function bumpRateLimit(db: Db, key: string, windowMs: number, at: Date): Promise<number> {
  const start = windowStart(at, windowMs);
  const [row] = await db
    .insert(rateLimits)
    .values({ bucketKey: key.slice(0, 200), windowStart: start, count: 1 })
    .onConflictDoUpdate({
      target: [rateLimits.bucketKey, rateLimits.windowStart],
      set: { count: sql`${rateLimits.count} + 1` },
    })
    .returning();
  return Number(row?.count ?? 0);
}

/**
 * Takes one hit from every limit in `limits` (all are counted, even after
 * one refuses). Allowed only if every count is within its limit; otherwise
 * `retryAfterSeconds` is the longest wait among the refusing windows.
 */
export async function takeDbRateLimits(db: Db, limits: DbLimit[], realNow: Date = new Date()): Promise<DbRateLimitResult> {
  if (limits.length === 0 || dbRateLimitsDisabled()) {
    return { allowed: true, remaining: Number.MAX_SAFE_INTEGER, retryAfterSeconds: 0, key: null };
  }
  let allowed = true;
  let remaining = Number.MAX_SAFE_INTEGER;
  let retryAfterSeconds = 0;
  let refusedKey: string | null = null;
  try {
    for (const limit of limits) {
      const at = limit.now ?? realNow;
      const count = await bumpRateLimit(db, limit.key, limit.windowMs, at);
      remaining = Math.min(remaining, Math.max(0, limit.limit - count));
      if (count > limit.limit) {
        allowed = false;
        refusedKey ??= limit.key;
        const end = windowStart(at, limit.windowMs).getTime() + limit.windowMs;
        retryAfterSeconds = Math.max(retryAfterSeconds, Math.max(1, Math.ceil((end - at.getTime()) / 1000)));
      }
    }
  } catch (err) {
    // Fail open: a limiter outage must not refuse real traffic.
    console.error(`[rate-limit] failing open after a database error: ${describeError(err)}`);
    return { allowed: true, remaining: 0, retryAfterSeconds: 0, key: null };
  }
  return { allowed, remaining, retryAfterSeconds, key: refusedKey };
}

/** Deletes windows that ended before `olderThan` (the tick prunes anything older than 2 days). */
export async function pruneRateLimits(db: Db, olderThan: Date): Promise<void> {
  await db.delete(rateLimits).where(lt(rateLimits.windowStart, olderThan));
}

/** A plain JSON 429 for the non-tool routes (console, verify, dashboard). */
export function rateLimitedResponse(retryAfterSeconds: number, message = "Too many requests; slow down."): Response {
  return new Response(
    JSON.stringify({ ok: false, error: "rate_limited", message, retry_after_seconds: retryAfterSeconds }),
    {
      status: 429,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "retry-after": String(retryAfterSeconds),
      },
    },
  );
}
