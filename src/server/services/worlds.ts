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

  // All three steps run in one transaction so a failure partway through
  // (e.g. ensureChartOfAccounts throwing) rolls back the whole thing
  // instead of leaving a half-built main world (a world/clock row with
  // no chart of accounts, or a world row with no clock row at all —
  // which would make getSimNow throw forever for that world).
  return db.transaction(async (tx) => {
    await tx
      .insert(worlds)
      .values({
        slug: "main",
        name: "Main",
        ownerPrincipalId: null,
        railMode: "paypal",
      })
      .onConflictDoNothing({ target: worlds.slug });

    const [world] = await tx
      .select()
      .from(worlds)
      .where(eq(worlds.slug, "main"))
      .limit(1);

    if (!world) {
      throw new Error("Expected main world to exist after ON CONFLICT insert");
    }

    await tx
      .insert(clock)
      .values({
        worldId: world.id,
        anchorReal: now,
        anchorSim: now,
        speed: "0",
        manualOffsetMs: 0n,
      })
      .onConflictDoNothing({ target: clock.worldId });

    await ensureChartOfAccounts(tx, world.id);

    return { worldId: world.id };
  });
}

/**
 * Per-`Db`-instance memo of `ensureMainWorld`'s result, so hot paths like
 * `runTool` (called on every `auth: 'none'` request) don't re-run its
 * transaction (insert/select/insert) every time. Keyed by the `Db` instance
 * (a `WeakMap` so it never keeps a test's in-memory PGlite db alive past its
 * own lifetime) rather than globally, so tests using independent `createTestDb()`
 * instances never see another test's cached world id.
 */
const mainWorldMemo = new WeakMap<Db, Promise<{ worldId: string }>>();

/**
 * Memoised `ensureMainWorld`: the first call for a given `db` does the real
 * work and caches the resulting promise; every later call for that same
 * `db` returns the cached promise instead of hitting the database again. A
 * failed attempt is evicted from the cache so a transient error doesn't
 * poison every later call for that `db`.
 */
export function ensureMainWorldOnce(db: Db): Promise<{ worldId: string }> {
  let cached = mainWorldMemo.get(db);
  if (!cached) {
    cached = ensureMainWorld(db).catch((err) => {
      mainWorldMemo.delete(db);
      throw err;
    });
    mainWorldMemo.set(db, cached);
  }
  return cached;
}

/**
 * Creates a new world with a fresh clock (speed 0, anchors set to now)
 * and a seeded chart of accounts. The slug is derived from `name` with a
 * random suffix to keep it short and unique.
 *
 * Note: the suffix is 6 random base-36 characters (36^6 ≈ 2.2 billion
 * possibilities), so a collision with an existing slug is astronomically
 * unlikely but not impossible; if it ever happens it surfaces as a
 * unique-constraint violation on `worlds.slug` from the insert below,
 * not a silent overwrite.
 *
 * All three writes (world, clock, chart of accounts) run in a single
 * transaction so a failure partway through — e.g. `ensureChartOfAccounts`
 * throwing — rolls back the whole thing instead of leaving an orphaned
 * world with no clock row (which would make `getSimNow` throw forever
 * for that world).
 */
export async function createWorld(
  db: Db,
  input: CreateWorldInput,
): Promise<{ worldId: string; slug: string }> {
  const base = slugify(input.name) || "world";
  const suffix = Math.random().toString(36).slice(2, 8);
  const slug = `${base}-${suffix}`;
  const now = new Date();

  return db.transaction(async (tx) => {
    const [world] = await tx
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

    await tx.insert(clock).values({
      worldId: world.id,
      anchorReal: now,
      anchorSim: now,
      speed: "0",
      manualOffsetMs: 0n,
    });

    await ensureChartOfAccounts(tx, world.id);

    return { worldId: world.id, slug: world.slug };
  });
}
