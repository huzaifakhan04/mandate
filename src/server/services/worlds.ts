import { eq } from "drizzle-orm";

import type { Db } from "../db/client";
import { clock, worlds } from "../db/schema";
import { ensureChartOfAccounts } from "../ledger/accounts";

export interface CreateWorldInput {
  name: string;
  ownerPrincipalId: string | null;
  railMode: "paypal" | "sim" | "mixed";
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

/**
 * Ensures the singleton "main" world exists (slug `main`, rail mode
 * `paypal`, clock speed 0, anchors set to now), seeding its chart of
 * accounts. Idempotent and race-safe: uses `ON CONFLICT (slug) DO
 * NOTHING` followed by a reselect (never select-then-insert), so two
 * concurrent cold starts racing to create the main world never create
 * two of it, and both end up returning the same `worldId`.
 */
export async function ensureMainWorld(db: Db): Promise<{ worldId: string }> {
  const now = new Date();

  await db
    .insert(worlds)
    .values({
      slug: "main",
      name: "Main",
      ownerPrincipalId: null,
      railMode: "paypal",
    })
    .onConflictDoNothing({ target: worlds.slug });

  const [world] = await db
    .select()
    .from(worlds)
    .where(eq(worlds.slug, "main"))
    .limit(1);

  if (!world) {
    throw new Error("Expected main world to exist after ON CONFLICT insert");
  }

  await db
    .insert(clock)
    .values({
      worldId: world.id,
      anchorReal: now,
      anchorSim: now,
      speed: "0",
      manualOffsetMs: 0n,
    })
    .onConflictDoNothing({ target: clock.worldId });

  await ensureChartOfAccounts(db, world.id);

  return { worldId: world.id };
}

/**
 * Creates a new world with a fresh clock (speed 0, anchors set to now)
 * and a seeded chart of accounts. The slug is derived from `name` with a
 * random suffix to keep it short and unique.
 */
export async function createWorld(
  db: Db,
  input: CreateWorldInput,
): Promise<{ worldId: string; slug: string }> {
  const base = slugify(input.name) || "world";
  const suffix = Math.random().toString(36).slice(2, 8);
  const slug = `${base}-${suffix}`;
  const now = new Date();

  const [world] = await db
    .insert(worlds)
    .values({
      slug,
      name: input.name,
      ownerPrincipalId: input.ownerPrincipalId,
      railMode: input.railMode,
    })
    .returning();

  if (!world) {
    throw new Error("Expected world to be inserted");
  }

  await db.insert(clock).values({
    worldId: world.id,
    anchorReal: now,
    anchorSim: now,
    speed: "0",
    manualOffsetMs: 0n,
  });

  await ensureChartOfAccounts(db, world.id);

  return { worldId: world.id, slug: world.slug };
}
