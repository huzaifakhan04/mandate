import { randomUUID } from "crypto";

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import type { Db } from "./client";
import * as schema from "./schema";

/**
 * Real-Postgres test databases for `npm run test:pg` (`TEST_PG=1`). The
 * global setup (`tests/pg/globalSetup.ts`) boots an embedded Postgres and
 * migrates a template database from `./drizzle` with drizzle-orm's
 * migrator; every call here clones that template into a fresh database and
 * returns a Drizzle client over a real multi-connection `pg` Pool — so a
 * `Promise.all` of two transactions really runs on two backends (PGlite
 * runs one transaction at a time and cannot exercise row locks).
 *
 * Test-only: imported dynamically from `./testing` and never from
 * production code.
 */

interface Created {
  name: string;
  pool: Pool;
}

const created: Created[] = [];
let adminPool: Pool | null = null;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set — run real-Postgres tests through \`npm run test:pg\`.`);
  }
  return value;
}

function admin(): Pool {
  if (!adminPool) {
    adminPool = new Pool({ connectionString: `${requireEnv("TEST_PG_BASE_URL")}/postgres`, max: 1 });
  }
  return adminPool;
}

/** A Pool on a database cloned from the migrated template (raw `pg`, for tests that need SQL-level access). */
export async function createPgTestPool(): Promise<{ pool: Pool; name: string }> {
  const template = requireEnv("TEST_PG_TEMPLATE");
  const name = `t_${randomUUID().replace(/-/g, "")}`;
  await admin().query(`CREATE DATABASE "${name}" TEMPLATE "${template}"`);
  const pool = new Pool({
    connectionString: `${requireEnv("TEST_PG_BASE_URL")}/${name}`,
    max: 8,
    idleTimeoutMillis: 1_000,
  });
  pool.on("error", (err) => console.error("[testingPg] idle client error:", err.message));
  created.push({ name, pool });
  return { pool, name };
}

/** An empty database (no migrations) — for the migration dry-run test. */
export async function createEmptyPgDatabase(): Promise<{ pool: Pool; name: string; url: string }> {
  const name = `e_${randomUUID().replace(/-/g, "")}`;
  await admin().query(`CREATE DATABASE "${name}"`);
  const url = `${requireEnv("TEST_PG_BASE_URL")}/${name}`;
  const pool = new Pool({ connectionString: url, max: 4, idleTimeoutMillis: 1_000 });
  pool.on("error", (err) => console.error("[testingPg] idle client error:", err.message));
  created.push({ name, pool });
  return { pool, name, url };
}

export async function createPgTestDb(): Promise<Db> {
  const { pool } = await createPgTestPool();
  // node-postgres implements the same Drizzle pg-core surface as the Neon
  // serverless Pool driver used in production (both are `pg`-protocol pools).
  return drizzle(pool, { schema }) as unknown as Db;
}

/** Ends every pool created by this worker and drops its databases. */
export async function disposePgTestDbs(): Promise<void> {
  const toDrop = created.splice(0, created.length);
  for (const { name, pool } of toDrop) {
    await pool.end().catch(() => {});
    await admin()
      .query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
      .catch((err: Error) => console.error(`[testingPg] drop ${name} failed:`, err.message));
  }
}
