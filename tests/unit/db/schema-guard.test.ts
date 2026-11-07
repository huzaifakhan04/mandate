import { describe, expect, it } from "vitest";
import { isTable } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";

import * as schema from "@/server/db/schema";

// P8: rate_limits buckets key on IPs / agents / principals across worlds.
const WORLD_ID_EXEMPT_TABLES = new Set(["worlds", "principals", "rate_limits"]);
const WORLD_ID_NULLABLE_TABLES = new Set(["webhook_events"]);

function getPgTables(): PgTable[] {
  return Object.values(schema).filter(isTable) as PgTable[];
}

describe("schema guard: world isolation", () => {
  const tables = getPgTables();

  it("discovers every table exported from schema.ts", () => {
    // Sanity check so this test fails loudly if schema.ts is empty/broken,
    // rather than silently iterating over zero tables.
    expect(tables.length).toBeGreaterThanOrEqual(28);
  });

  it.each(getPgTables().map((table) => [getTableConfig(table).name, table]))(
    "table %s has a correctly-scoped world_id column",
    (name, table) => {
      const config = getTableConfig(table as PgTable);
      const worldIdColumn = config.columns.find(
        (column) => column.name === "world_id",
      );

      if (WORLD_ID_EXEMPT_TABLES.has(config.name)) {
        expect(worldIdColumn).toBeUndefined();
        return;
      }

      expect(worldIdColumn).toBeDefined();

      if (WORLD_ID_NULLABLE_TABLES.has(config.name)) {
        expect(worldIdColumn?.notNull).toBe(false);
      } else {
        expect(worldIdColumn?.notNull).toBe(true);
      }
    },
  );
});
