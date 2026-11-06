import type { Db } from "../db/client";
import { invalidateConsoleSnapshot } from "../services/console";
import { advancePrivateWorld, createPrivateWorld, resetPrivateWorld } from "../services/privateWorlds";
import { STRESS_SCENARIOS, triggerStressScenario } from "../services/stress";
import { failure, gate, json, readFields, seeOther, wantsHtml } from "./ownerRoutes";
import { isUuid } from "./ownership";

/**
 * P2 Task 6: the "Sandbox worlds" owner routes, built over `getDb` so
 * tests drive them with PGlite:
 *
 * - `POST /dashboard/worlds/create` — create a private world (form: `name`).
 *   303 → `/dashboard/worlds/<id>`; the principal's fourth → 409.
 * - `POST /dashboard/worlds/<id>/advance` — `days` = 1 or 7: the clock
 *   moves a day at a time and the bots act for each day. 303 back.
 * - `POST /dashboard/worlds/<id>/reset` — archive the world, open a
 *   fresh one with the same name. 303 → the new world.
 * - `POST /dashboard/worlds/<id>/stress` — P5 Task 4: `scenario` =
 *   `default_wave` | `note_run` | `rate_spike` (`services/stress.ts`).
 *   303 back (`?stress=<scenario>`); JSON 200 `{event_id, sim_day, params}`.
 *
 * Every route: same origin (403), a session (401; a browser goes to
 * /verify), then ownership — another principal's world, an archived one,
 * the main world or a malformed id → 404 with nothing changed.
 */

export const ADVANCE_CHOICES = [1, 7] as const;

export function worldPagePath(worldId: string, query: Record<string, string> = {}): string {
  const params = new URLSearchParams(query).toString();
  return `/dashboard/worlds/${worldId}${params ? `?${params}` : ""}`;
}

function worldBack(worldId: string, query: Record<string, string>) {
  return { path: worldPagePath(worldId, query), returnTo: worldPagePath(worldId) };
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : "unknown error";
}

export function createWorldHandlers({ getDb }: { getDb: () => Promise<Db> }) {
  async function create(request: Request): Promise<Response> {
    const back = { path: "/dashboard/worlds?error=invalid", returnTo: "/dashboard/worlds" };
    const gated = gate(request, back);
    if (gated instanceof Response) {
      return gated;
    }
    const fields = await readFields(request);
    try {
      const result = await createPrivateWorld(await getDb(), gated.principalId, { name: fields?.name });
      switch (result.outcome) {
        case "created":
          return wantsHtml(request)
            ? seeOther(request, worldPagePath(result.worldId, { created: "1" }))
            : json(201, { world_id: result.worldId });
        case "limit":
          return failure(request, 409, "world_limit", "You already have 3 sandbox worlds. Reset one instead.", {
            path: "/dashboard/worlds?error=limit",
            returnTo: "/dashboard/worlds",
          });
        case "unverified":
          return failure(request, 403, "unverified", "Verify with PayPal first.", null);
        case "invalid":
          return failure(request, 400, "invalid_name", "Give the world a name (1–60 characters).", back);
      }
    } catch (err) {
      console.error(`[worlds] create failed: ${errorName(err)}`);
      return failure(request, 500, "error", "Something went wrong creating the world.", {
        path: "/dashboard/worlds?error=error",
        returnTo: "/dashboard/worlds",
      });
    }
  }

  async function advance(request: Request, worldId: string): Promise<Response> {
    if (!isUuid(worldId)) {
      return failure(request, 404, "not_found", "World not found.", null);
    }
    const gated = gate(request, worldBack(worldId, {}));
    if (gated instanceof Response) {
      return gated;
    }
    const fields = await readFields(request);
    const days = Number(typeof fields?.days === "string" ? fields.days : NaN);
    const allowed = (ADVANCE_CHOICES as readonly number[]).includes(days);
    try {
      // Ownership first: a foreign world 404s whatever `days` says.
      const result = await advancePrivateWorld(await getDb(), gated.principalId, worldId, allowed ? days : 0);
      if (result.outcome === "not_found") {
        return failure(request, 404, "not_found", "World not found.", null);
      }
      if (result.outcome === "invalid") {
        return failure(request, 400, "invalid_days", "Advance by 1 or 7 days.", worldBack(worldId, { error: "days" }));
      }
      invalidateConsoleSnapshot(worldId); // P6: the console shows the change on its next poll
      return wantsHtml(request)
        ? seeOther(request, worldPagePath(worldId, { advanced: String(days) }))
        : json(200, { ok: true, sim_day: result.simDay, sim_now: result.simNow.toISOString() });
    } catch (err) {
      console.error(`[worlds] advance failed: ${errorName(err)}`);
      return failure(request, 500, "error", "Something went wrong.", worldBack(worldId, { error: "error" }));
    }
  }

  async function reset(request: Request, worldId: string): Promise<Response> {
    if (!isUuid(worldId)) {
      return failure(request, 404, "not_found", "World not found.", null);
    }
    const gated = gate(request, worldBack(worldId, {}));
    if (gated instanceof Response) {
      return gated;
    }
    try {
      const result = await resetPrivateWorld(await getDb(), gated.principalId, worldId);
      if (result.outcome === "not_found") {
        return failure(request, 404, "not_found", "World not found.", null);
      }
      invalidateConsoleSnapshot(worldId); // P6: the console shows the change on its next poll
      return wantsHtml(request)
        ? seeOther(request, worldPagePath(result.worldId, { reset: "1" }))
        : json(200, { ok: true, world_id: result.worldId, archived_world_id: worldId });
    } catch (err) {
      console.error(`[worlds] reset failed: ${errorName(err)}`);
      return failure(request, 500, "error", "Something went wrong.", worldBack(worldId, { error: "error" }));
    }
  }

  async function stress(request: Request, worldId: string): Promise<Response> {
    if (!isUuid(worldId)) {
      return failure(request, 404, "not_found", "World not found.", null);
    }
    const gated = gate(request, worldBack(worldId, {}));
    if (gated instanceof Response) {
      return gated;
    }
    const fields = await readFields(request);
    try {
      // Ownership first: a foreign world or the main world 404s whatever `scenario` says.
      const result = await triggerStressScenario(await getDb(), gated.principalId, worldId, fields?.scenario);
      if (result.outcome === "not_found") {
        return failure(request, 404, "not_found", "World not found.", null);
      }
      if (result.outcome === "invalid") {
        return failure(
          request,
          400,
          "invalid_scenario",
          `Choose a scenario: ${STRESS_SCENARIOS.join(", ")}.`,
          worldBack(worldId, { error: "scenario" }),
        );
      }
      invalidateConsoleSnapshot(worldId); // P6: the console shows the change on its next poll
      return wantsHtml(request)
        ? seeOther(request, worldPagePath(worldId, { stress: result.scenario }))
        : json(200, { ok: true, scenario: result.scenario, event_id: result.eventId, sim_day: result.simDay, params: result.params });
    } catch (err) {
      console.error(`[worlds] stress failed: ${errorName(err)}`);
      return failure(request, 500, "error", "Something went wrong.", worldBack(worldId, { error: "error" }));
    }
  }

  return { create, advance, reset, stress };
}
