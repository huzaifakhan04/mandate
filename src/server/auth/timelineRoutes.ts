import type { Db } from "../db/client";
import { ownedPrivateWorld } from "../services/privateWorldAccess";
import { ownerTimeline } from "../services/timeline";
import { principalFromRequest } from "./guard";
import { isUuid } from "./ownership";

/**
 * P7 — `GET /api/dashboard/timeline?world=<id>`: the owner dashboard's
 * Timeline tab data (`ownerTimeline`), polled while the tab is open.
 *
 * - Owner-only: no session → 401. The rows are only the signed-in
 *   principal's own agents, so another owner's agents and loans never
 *   appear.
 * - `world` absent → the main view; one of the principal's active private
 *   worlds → that world; anything else (someone else's world, archived,
 *   malformed) → 404, never a fallback.
 * - `cache-control: no-store`; read-only (the agent drives the schedule).
 */

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export function createTimelineHandler({ getDb, now = () => new Date() }: { getDb: () => Promise<Db>; now?: () => Date }) {
  return async function GET(request: Request): Promise<Response> {
    const session = principalFromRequest(request);
    if (!session) {
      return json(401, { ok: false, error: "unauthorized", message: "Sign in with PayPal to continue." });
    }
    const requested = new URL(request.url).searchParams.get("world");
    try {
      const db = await getDb();
      let worldId: string | undefined;
      if (requested && requested !== "main") {
        const world = isUuid(requested) ? await ownedPrivateWorld(db, session.principalId, requested) : null;
        if (!world) {
          return json(404, { ok: false, error: "not_found", message: "World not found." });
        }
        worldId = world.id;
      }
      return json(200, { ok: true, timeline: await ownerTimeline(db, session.principalId, { worldId, now: now() }) });
    } catch (err) {
      console.error(`[timeline] failed: ${err instanceof Error ? err.name : "unknown error"}`);
      return json(500, { ok: false, error: "error", message: "Something went wrong." });
    }
  };
}
