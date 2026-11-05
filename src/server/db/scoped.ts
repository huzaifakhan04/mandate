import { and, eq, type SQL } from "drizzle-orm";
import type { AnyPgColumn, PgTable } from "drizzle-orm/pg-core";

import type { Db } from "./client";

/** Any schema table that carries a non-null `world_id` column. */
type WorldScopedTable = PgTable & {
  worldId: AnyPgColumn;
  $inferInsert: { worldId: string };
  $inferSelect: { worldId: string };
};

/**
 * Wraps a `Db` so every read and write is confined to a single world.
 * This is the only sanctioned way to query a world-scoped table —
 * querying `db` directly risks leaking rows across worlds.
 *
 * INVARIANT: every method here must inject/filter `world_id` itself and
 * must never accept it from the caller. `insert`'s `values` and
 * `update`'s `set` deliberately omit `worldId` at the type level (so a
 * caller-supplied value doesn't even type-check), and at runtime the
 * scope's `worldId` always overwrites whatever is in the spread object,
 * even if a caller forces one in via an `as any`/`as unknown` cast. Any
 * new method added here (e.g. a future `delete`) MUST uphold the same
 * guarantee — see tests/unit/db/scoped.types.test.ts for the compile-time
 * regression test and tests/unit/db/scoped.test.ts for the runtime one.
 *
 * Internally this casts through `PgTable`/`any` to call Drizzle's
 * generic query builders (whose overloads otherwise can't be satisfied
 * by a type-parameterized table), but the public surface below stays
 * strongly typed against the caller's own table type `T`.
 */
export function scoped(db: Db, worldId: string) {
  return {
    select<T extends WorldScopedTable>(table: T): Promise<T["$inferSelect"][]> {
      const anyTable = table as unknown as PgTable;
      return db
        .select()
        .from(anyTable)
        .where(eq(table.worldId, worldId)) as unknown as Promise<
        T["$inferSelect"][]
      >;
    },

    async insert<T extends WorldScopedTable>(
      table: T,
      values: Omit<T["$inferInsert"], "worldId">,
    ): Promise<T["$inferSelect"][]> {
      const anyTable = table as unknown as PgTable;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rows = await (db.insert(anyTable) as any)
        .values({ ...values, worldId })
        .returning();
      return rows as T["$inferSelect"][];
    },

    async update<T extends WorldScopedTable>(
      table: T,
      set: Partial<Omit<T["$inferInsert"], "worldId">>,
      where?: SQL,
    ): Promise<T["$inferSelect"][]> {
      const anyTable = table as unknown as PgTable;
      const condition = where
        ? and(eq(table.worldId, worldId), where)
        : eq(table.worldId, worldId);
      // Defensively strip any caller-supplied `worldId`, even though the
      // public type above already excludes it: a cast (`as any`/`as
      // unknown`) around the type could otherwise slip a `worldId` into
      // `set` and move the row to a different world. `set` must never
      // touch `world_id` — only the `where` filter above may reference it.
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { worldId: _ignoredWorldId, ...safeSet } = set as Record<
        string,
        unknown
      >;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rows = await (db.update(anyTable) as any)
        .set(safeSet)
        .where(condition)
        .returning();
      return rows as T["$inferSelect"][];
    },
  };
}
