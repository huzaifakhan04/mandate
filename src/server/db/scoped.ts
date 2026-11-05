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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rows = await (db.update(anyTable) as any)
        .set(set)
        .where(condition)
        .returning();
      return rows as T["$inferSelect"][];
    },
  };
}
