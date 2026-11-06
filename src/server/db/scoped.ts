import { and, desc, eq, type SQL } from "drizzle-orm";
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
  /** `where?` is always ANDed with the world filter, never OR'd/replacing it. */
  function worldCondition<T extends WorldScopedTable>(table: T, where?: SQL): SQL {
    return where ? and(eq(table.worldId, worldId), where)! : eq(table.worldId, worldId);
  }

  return {
    select<T extends WorldScopedTable>(
      table: T,
      where?: SQL,
    ): Promise<T["$inferSelect"][]> {
      const anyTable = table as unknown as PgTable;
      return db
        .select()
        .from(anyTable)
        .where(worldCondition(table, where)) as unknown as Promise<
        T["$inferSelect"][]
      >;
    },

    /**
     * Like `select`, but only the given columns (e.g. document metadata
     * without its bytea `content`), optionally bounded by `limit`. Same
     * world filter.
     */
    selectFields<T extends WorldScopedTable, F extends Record<string, AnyPgColumn>>(
      table: T,
      fields: F,
      where?: SQL,
      orderBy?: SQL | AnyPgColumn,
      limit?: number,
    ): Promise<Array<{ [K in keyof F]: F[K]["_"]["notNull"] extends true ? F[K]["_"]["data"] : F[K]["_"]["data"] | null }>> {
      const anyTable = table as unknown as PgTable;
      let query = db.select(fields).from(anyTable).where(worldCondition(table, where)).$dynamic();
      if (orderBy) {
        query = query.orderBy(orderBy);
      }
      if (limit !== undefined) {
        query = query.limit(limit);
      }
      return query as unknown as Promise<
        Array<{ [K in keyof F]: F[K]["_"]["notNull"] extends true ? F[K]["_"]["data"] : F[K]["_"]["data"] | null }>
      >;
    },

    async findOne<T extends WorldScopedTable>(
      table: T,
      where: SQL,
    ): Promise<T["$inferSelect"] | undefined> {
      const anyTable = table as unknown as PgTable;
      const rows = (await db
        .select()
        .from(anyTable)
        .where(worldCondition(table, where))
        .limit(1)) as T["$inferSelect"][];
      return rows[0];
    },

    /**
     * The newest matching row by `orderBy` (descending), or `undefined` —
     * one row, never a scan into memory.
     */
    async findLatest<T extends WorldScopedTable>(
      table: T,
      where: SQL,
      orderBy: AnyPgColumn,
    ): Promise<T["$inferSelect"] | undefined> {
      const anyTable = table as unknown as PgTable;
      const rows = (await db
        .select()
        .from(anyTable)
        .where(worldCondition(table, where))
        .orderBy(desc(orderBy))
        .limit(1)) as T["$inferSelect"][];
      return rows[0];
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

    /**
     * Like `insert`, but resolves conflicts on `target` (the unique
     * constraint/index's columns) by doing nothing instead of throwing.
     * Returns the inserted rows via `RETURNING` — empty when the row
     * already existed (Postgres's `ON CONFLICT DO NOTHING` returns no row
     * for a skipped insert, so callers must not assume one row back).
     */
    async insertOnConflictDoNothing<T extends WorldScopedTable>(
      table: T,
      values: Omit<T["$inferInsert"], "worldId">,
      target: AnyPgColumn | AnyPgColumn[],
    ): Promise<T["$inferSelect"][]> {
      const anyTable = table as unknown as PgTable;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rows = await (db.insert(anyTable) as any)
        .values({ ...values, worldId })
        .onConflictDoNothing({ target })
        .returning();
      return rows as T["$inferSelect"][];
    },

    async update<T extends WorldScopedTable>(
      table: T,
      set: Partial<Omit<T["$inferInsert"], "worldId">>,
      where?: SQL,
    ): Promise<T["$inferSelect"][]> {
      const anyTable = table as unknown as PgTable;
      const condition = worldCondition(table, where);
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

    async delete<T extends WorldScopedTable>(
      table: T,
      where: SQL,
    ): Promise<T["$inferSelect"][]> {
      const anyTable = table as unknown as PgTable;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rows = await (db.delete(anyTable) as any)
        .where(worldCondition(table, where))
        .returning();
      return rows as T["$inferSelect"][];
    },

    /**
     * `SELECT ... FOR UPDATE`, row-locking the matching rows until the
     * current transaction commits or rolls back. This is only meaningful
     * when `db` (the handle this `scoped()` was constructed with) is
     * itself a transaction — e.g. `scoped(tx, worldId)` inside a
     * `db.transaction(async (tx) => ...)` callback, which is exactly how
     * `runTool` wires mutating tools (see `ToolCtx.scoped`). Called
     * against a non-transactional `db` it still runs, but the lock is
     * released the instant the statement finishes, so it buys nothing.
     */
    forUpdate<T extends WorldScopedTable>(
      table: T,
      where: SQL,
    ): Promise<T["$inferSelect"][]> {
      const anyTable = table as unknown as PgTable;
      return db
        .select()
        .from(anyTable)
        .where(worldCondition(table, where))
        .for("update") as unknown as Promise<T["$inferSelect"][]>;
    },
  };
}
