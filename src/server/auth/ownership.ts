import { and, asc, eq, isNotNull } from "drizzle-orm";

import type { Db } from "../db/client";
import { agents } from "../db/schema";

/**
 * Owner-route ownership checks (P2, Review Focus 3).
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

export type OwnedAgent = typeof agents.$inferSelect;

/**
 * The agent `agentId` if `principalId` claimed it, else `null` (a
 * malformed id, someone else's agent and an unknown one all look the
 * same → 404). Looked up by id across worlds — an owner's agents may live
 * in a private world — so callers must scope every later query to
 * `agent.worldId`.
 */
export async function ownedAgent(db: Db, principalId: string, agentId: string): Promise<OwnedAgent | null> {
  if (!isUuid(agentId)) {
    return null;
  }
  const [agent] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.principalId, principalId)))
    .limit(1);
  return agent && agent.claimedAt ? agent : null;
}

/**
 * Every agent `principalId` has claimed, across worlds, oldest first. The
 * dashboard's read model groups them by `worldId` and scopes every later
 * query to that world.
 */
export async function ownedAgents(db: Db, principalId: string): Promise<OwnedAgent[]> {
  const rows = await db
    .select()
    .from(agents)
    .where(and(eq(agents.principalId, principalId), isNotNull(agents.claimedAt)))
    .orderBy(asc(agents.createdAt), asc(agents.id));
  return rows;
}
