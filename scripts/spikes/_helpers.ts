import { randomUUID } from "crypto";

import { createTestDb } from "@/server/db/testing";
import { worlds } from "@/server/db/schema";
import type { Db } from "@/server/db/client";

/**
 * Spin up an in-memory PGlite db with every migration applied and one
 * `worlds` row, for day-1 PayPal spike scripts. Never touches the real
 * Neon database, so spikes don't pollute production `paypal_operations`
 * rows.
 */
export async function spikeDb(): Promise<{ db: Db; worldId: string }> {
  const db = await createTestDb();
  const [world] = await db
    .insert(worlds)
    .values({ slug: `spike-${randomUUID()}`, name: "Spike", railMode: "paypal" })
    .returning();
  if (!world) {
    throw new Error("expected a world to be inserted");
  }
  return { db, worldId: world.id };
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}
