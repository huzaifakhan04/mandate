import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";

import type { Db } from "./client";
import * as schema from "./schema";

/**
 * Creates a fresh test database with every migration in `drizzle/`
 * applied. No network access or `DATABASE_URL` is required.
 *
 * - Default (`npm test`): an in-memory PGlite.
 * - `TEST_PG=1` (`npm run test:pg`): a fresh database on the local
 *   embedded Postgres started by `tests/pg/globalSetup.ts`, over a real
 *   multi-connection pool (see `./testingPg`).
 */
export async function createTestDb(): Promise<Db> {
  if (process.env.TEST_PG === "1") {
    const { createPgTestDb } = await import("./testingPg");
    return createPgTestDb();
  }
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: "./drizzle" });
  return db;
}
