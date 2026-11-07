import type { Db } from "../db/client";
import { createTokenBucket, clientKey } from "../http/rateLimit";
import { cachedConsoleSnapshot, resolveConsoleWorld } from "../services/console";
import { consoleCalendar } from "../services/timeline";
import { principalFromRequest } from "./guard";

/**
 * P6 — `GET /api/console/snapshot?world=<main|id>`: the public console's
 * live JSON (`services/console.ts`), polled every 2 s by `/console`.
 *
 * - No auth for the main world. A private world is served only to its
 *   signed-in owner (session cookie); anyone else — and any unknown,
 *   archived or malformed id — gets the same 404.
 * - `cache-control: no-store` on every response; server-side, snapshots
 *   come from a 1.5 s single-flight per-world cache (`cachedConsoleSnapshot`).
 * - P7: `GET /api/console/calendar?world=<main|id>` — the Calendar tab's
 *   events (`consoleCalendar`), same world rules, PII rules and limiter.
 * - Rate limited per client IP by an in-memory token bucket (burst 30,
 *   2 requests/s sustained — a page polls at 0.5/s): 429 + `retry-after`.
 */

export const SNAPSHOT_BURST = 30;
export const SNAPSHOT_REFILL_PER_SECOND = 2;

const NO_STORE = { "cache-control": "no-store" };

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...NO_STORE, ...headers },
  });
}

export function createConsoleHandlers({
  getDb,
  limiter = createTokenBucket({ capacity: SNAPSHOT_BURST, refillPerSecond: SNAPSHOT_REFILL_PER_SECOND }),
  now = () => new Date(),
}: {
  getDb: () => Promise<Db>;
  limiter?: ReturnType<typeof createTokenBucket>;
  now?: () => Date;
}) {
  async function serve(
    request: Request,
    what: string,
    build: (db: Db, world: NonNullable<Awaited<ReturnType<typeof resolveConsoleWorld>>>) => Promise<unknown>,
  ): Promise<Response> {
    const limit = limiter.take(clientKey(request), now().getTime());
    if (!limit.allowed) {
      return jsonResponse(
        429,
        { ok: false, error: "rate_limited", message: "Too many requests; slow down." },
        { "retry-after": String(limit.retryAfterSeconds) },
      );
    }
    const requested = new URL(request.url).searchParams.get("world");
    const session = principalFromRequest(request);
    try {
      const db = await getDb();
      const world = await resolveConsoleWorld(db, session?.principalId ?? null, requested);
      if (!world) {
        return jsonResponse(404, { ok: false, error: "not_found", message: "World not found." });
      }
      return jsonResponse(200, await build(db, world));
    } catch (err) {
      console.error(`[console] ${what} failed: ${err instanceof Error ? err.name : "unknown error"}`);
      return jsonResponse(500, { ok: false, error: "error", message: "Something went wrong." });
    }
  }

  return {
    snapshot(request: Request): Promise<Response> {
      return serve(request, "snapshot", async (db, world) => ({ ok: true, snapshot: await cachedConsoleSnapshot(db, world, () => now().getTime()) }));
    },
    calendar(request: Request): Promise<Response> {
      return serve(request, "calendar", async (db, world) => ({ ok: true, calendar: await consoleCalendar(db, world, now()) }));
    },
  };
}
