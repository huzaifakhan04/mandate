import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";

import type { Db } from "./client";
import * as schema from "./schema";

/**
 * Creates an in-memory PGlite database with every migration in
 * `drizzle/` applied, for use in unit/integration tests. No network
 * access or `DATABASE_URL` is required.
 */
export async function createTestDb(): Promise<Db> {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: "./drizzle" });
  return db;
}
