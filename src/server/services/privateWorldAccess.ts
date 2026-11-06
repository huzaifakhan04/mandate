import { and, asc, eq } from "drizzle-orm";

import { isUuid } from "../auth/ownership";
import type { Db } from "../db/client";
import { worlds } from "../db/schema";
import { ensureMainWorldOnce } from "./worlds";

/**
 * P2 Task 6: who may see or act on a private world. A private world is
 * reachable only by its owner while it is active — someone else's world,
 * an archived one, the main world and a malformed id all look the same
 * (`null` → 404). Kept apart from `privateWorlds.ts` (which drives the
 * bots) so the dashboard and path B can check ownership cheaply.
 */

export type WorldRow = typeof worlds.$inferSelect;

export async function ownedPrivateWorld(db: Db, principalId: string, worldId: string): Promise<WorldRow | null> {
  if (!isUuid(worldId) || !isUuid(principalId)) {
    return null;
  }
  const [world] = await db
    .select()
    .from(worlds)
    .where(
      and(
        eq(worlds.id, worldId),
        eq(worlds.ownerPrincipalId, principalId),
        eq(worlds.kind, "private"),
        eq(worlds.status, "active"),
      ),
    )
    .limit(1);
  return world ?? null;
}

/** The principal's active private worlds, oldest first. */
export async function listOwnedPrivateWorlds(db: Db, principalId: string): Promise<WorldRow[]> {
  if (!isUuid(principalId)) {
    return [];
  }
  return db
    .select()
    .from(worlds)
    .where(and(eq(worlds.ownerPrincipalId, principalId), eq(worlds.kind, "private"), eq(worlds.status, "active")))
    .orderBy(asc(worlds.createdAt), asc(worlds.id));
}

export interface DashboardWorld {
  id: string;
  name: string;
  kind: "main" | "private";
}

/**
 * The world the dashboard shows: `requested` when it is one of the
 * principal's active private worlds, otherwise the main world (the
 * default; an unknown, foreign or archived id silently falls back).
 */
export async function resolveDashboardWorld(
  db: Db,
  principalId: string,
  requested: string | null | undefined,
): Promise<DashboardWorld> {
  if (requested) {
    const world = await ownedPrivateWorld(db, principalId, requested);
    if (world) {
      return { id: world.id, name: world.name, kind: "private" };
    }
  }
  const { worldId } = await ensureMainWorldOnce(db);
  return { id: worldId, name: "Main", kind: "main" };
}
