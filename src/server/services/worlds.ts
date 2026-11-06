import { and, eq } from "drizzle-orm";

import { getSimNow } from "../clock/clock";
import type { Db } from "../db/client";
import { clock, noteSeries, worlds } from "../db/schema";
import { ensureChartOfAccounts } from "../ledger/accounts";
import { postJournal } from "../ledger/postJournal";

export interface CreateWorldInput {
  name: string;
  ownerPrincipalId: string | null;
  railMode: "paypal" | "sim" | "mixed";
  /** P2 Task 6: `private` worlds are sim-only sandboxes (default `main`). */
  kind?: "main" | "private";
  /** P2 Task 6: the system principal owning a private world's borrower bots. */
  botPrincipalId?: string | null;
  /** P2 Task 6: the bots' RNG seed (defaults to the world id). */
  botSeed?: string | null;
}

/**
 * The plan's single per-world note series name (plan: "one note series
 * per world, `Mandate Pool A`"). `poolType: "general"` is this task's
 * only choice — the plan doesn't define a pool-type vocabulary yet, and
 * P1 has no second pool to distinguish it from.
 */
const MANDATE_POOL_A_NAME = "Mandate Pool A";
const MANDATE_POOL_A_TYPE = "general";

/**
 * Seeds the world's single note series ("Mandate Pool A") if it doesn't
 * already exist. Idempotent and race-safe the same way `worlds.slug`/
 * `clock.worldId` are: `ON CONFLICT (world_id, name) DO NOTHING` against
 * `note_series_world_name_idx`, so two concurrent callers for the same
 * world can never create two series rows.
 *
 * This writes `worldId` directly (not through `scoped()`) because this
 * file, like the rest of `worlds.ts`, is allowlisted bootstrap
 * infrastructure called before a `scoped()` world context exists.
 */
async function ensureNoteSeries(db: Db, worldId: string): Promise<void> {
  await db
    .insert(noteSeries)
    .values({
      worldId,
      name: MANDATE_POOL_A_NAME,
      poolType: MANDATE_POOL_A_TYPE,
    })
    .onConflictDoNothing({ target: [noteSeries.worldId, noteSeries.name] });
}

/** Ruling W: the default opening capital when `BANK_SEED_CAPITAL_CENTS` is unset. */
export const DEFAULT_BANK_SEED_CAPITAL_CENTS = 10000n;

function parseBankSeedCapital(raw: string | undefined): bigint | Error {
  const value = raw?.trim();
  if (!value) {
    return DEFAULT_BANK_SEED_CAPITAL_CENTS;
  }
  if (!/^\d+$/.test(value)) {
    return new Error(
      `BANK_SEED_CAPITAL_CENTS must be a non-negative integer number of cents (e.g. "10000"), got ${JSON.stringify(value)}`,
    );
  }
  return BigInt(value);
}

/**
 * Fix round 3 (M4): the parsed `BANK_SEED_CAPITAL_CENTS`, validated once
 * per distinct env value (the process env doesn't change between
 * requests; keying on the raw string keeps tests that set it working)
 * — a malformed value's error is cached and rethrown, not re-parsed.
 */
let seedCapitalCache: { raw: string | undefined; result: bigint | Error } | undefined;

/** `BANK_SEED_CAPITAL_CENTS` (a non-negative integer number of cents), or the default. Throws if malformed. */
export function bankSeedCapitalCents(): bigint {
  const raw = process.env.BANK_SEED_CAPITAL_CENTS;
  if (!seedCapitalCache || seedCapitalCache.raw !== raw) {
    seedCapitalCache = { raw, result: parseBankSeedCapital(raw) };
  }
  if (seedCapitalCache.result instanceof Error) {
    throw seedCapitalCache.result;
  }
  return seedCapitalCache.result;
}

/**
 * Ruling W: the bank's opening capital — Dr `cash_paypal` / Cr
 * `bank_equity`, `BANK_SEED_CAPITAL_CENTS` (default 10000), posted once
 * per world (idempotency key `bank_capital:seed:<worldId>`, so repeated
 * ensures are no-ops; a later change of the env var doesn't re-seed).
 * PayPal's fees are the bank's expense, paid from `cash_paypal`; without
 * capital a pool funded only by note purchases would hold less cash than
 * it owes holders. Available liquidity includes it (it is cash).
 *
 * For a `sim` world it is simulated money. For the main world on the real
 * PayPal rail it represents real sandbox funds already sitting in the
 * bank's PayPal (sandbox business) account before any agent traded — set
 * `BANK_SEED_CAPITAL_CENTS` to no more than that account's balance so
 * `cash_paypal` never claims money PayPal doesn't hold.
 */
async function ensureBankSeedCapital(db: Db, worldId: string): Promise<void> {
  const cents = bankSeedCapitalCents();
  if (cents === 0n) {
    return;
  }
  await postJournal(db, {
    worldId,
    memo: "Bank opening capital",
    sourceType: "worlds",
    sourceId: worldId,
    // Fix round 3 (M3): the world's simulated now (its clock row exists by now — same transaction).
    simAt: await getSimNow(db, worldId),
    idempotencyKey: `bank_capital:seed:${worldId}`,
    postings: [
      { accountCode: "cash_paypal", amountCents: cents },
      { accountCode: "bank_equity", amountCents: -cents },
    ],
  });
}

/**
 * Maps a world's `rail_mode` to the `OperationRail` money-moving tools
 * must enqueue on (Ruling I, amended): `sim` worlds (tests/bots) stay
 * `sim`; every other mode (`paypal`, or the not-yet-implemented `mixed`)
 * uses the real PayPal rail. Reads `worlds` directly — this file, like
 * the rest of `worlds.ts`, is allowlisted bootstrap infrastructure (see
 * the world-isolation guard test).
 */
export async function railForWorld(db: Db, worldId: string): Promise<"paypal" | "sim"> {
  const [world] = await db.select().from(worlds).where(eq(worlds.id, worldId)).limit(1);
  if (!world) {
    throw new Error(`Expected world ${worldId} to exist`);
  }
  // P2 Task 6: a private world is sim-only whatever its rail_mode says
  // (the row's CHECK constraint enforces it too).
  return world.railMode === "sim" || world.kind === "private" ? "sim" : "paypal";
}

/**
 * Every active world's id, oldest first — for Task 8's crons, which run
 * across all worlds (reads `worlds` directly, like `railForWorld`).
 */
export async function listActiveWorldIds(db: Db): Promise<string[]> {
  const rows = await db
    .select({ id: worlds.id })
    .from(worlds)
    .where(eq(worlds.status, "active"))
    .orderBy(worlds.createdAt, worlds.id);
  return rows.map((row) => row.id);
}

/** P2 Task 6: every active private world's id, oldest first (the tick runs their bots). */
export async function listActivePrivateWorldIds(db: Db): Promise<string[]> {
  const rows = await db
    .select({ id: worlds.id })
    .from(worlds)
    .where(and(eq(worlds.status, "active"), eq(worlds.kind, "private")))
    .orderBy(worlds.createdAt, worlds.id);
  return rows.map((row) => row.id);
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

/**
 * Ensures the singleton "main" world exists (slug `main`, rail mode
 * `paypal`, clock speed 1 — Ruling P4-A — anchors set to now), seeding its chart of
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
        // Ruling P4-A: the main world's clock runs in real time (1 sim day = 1
        // real day) so due dates pass and the delinquency ladder runs.
        speed: "1",
        manualOffsetMs: 0n,
      })
      .onConflictDoNothing({ target: clock.worldId });

    await ensureChartOfAccounts(tx, world.id);
    await ensureNoteSeries(tx, world.id);
    await ensureBankSeedCapital(tx, world.id);

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
 *
 * On a successful resolution, the memo is permanent for that `db`'s
 * lifetime — there is no invalidation/TTL. That's fine because the memoised
 * value (the main world's id) is immutable once created; the main world is
 * never deleted or recreated under a running process. If that ever stops
 * being true (e.g. a future "reset the sandbox" operation that drops and
 * recreates worlds), this memo would need an explicit invalidation hook.
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
  return db.transaction((tx) => createWorldInTx(tx, input));
}

/**
 * `createWorld`'s body, for a caller that already holds a transaction
 * (P2 Task 6: a private world is created under the owner's row lock).
 */
export async function createWorldInTx(
  tx: Db,
  input: CreateWorldInput,
): Promise<{ worldId: string; slug: string }> {
  const base = (slugify(input.name) || "world").slice(0, 40);
  const suffix = Math.random().toString(36).slice(2, 8);
  const slug = `${base}-${suffix}`;
  const now = new Date();

  const [world] = await tx
    .insert(worlds)
    .values({
      slug,
      name: input.name,
      ownerPrincipalId: input.ownerPrincipalId,
      railMode: input.railMode,
      kind: input.kind ?? "main",
      botPrincipalId: input.botPrincipalId ?? null,
      botSeed: input.botSeed ?? null,
      lastBotSimDay: input.kind === "private" ? 0 : null,
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
  await ensureNoteSeries(tx, world.id);
  await ensureBankSeedCapital(tx, world.id);

  return { worldId: world.id, slug: world.slug };
}
