import { mkdtemp, rm } from "fs/promises";
import { createServer } from "net";
import { tmpdir } from "os";
import { join } from "path";

import EmbeddedPostgres from "embedded-postgres";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

/**
 * `npm run test:pg` global setup: boots ONE real Postgres (embedded-postgres
 * ships the official binaries via npm — no Docker/psql needed), migrates a
 * template database from `./drizzle` with drizzle-orm's node-postgres
 * migrator (the same migrator code path production uses), and exports the
 * connection details to the test workers through env vars. Each
 * `createTestDb()` call under `TEST_PG=1` then clones the template into a
 * fresh database (see `src/server/db/testingPg.ts`), dropped after its file.
 */

const TEMPLATE_DB = "mandate_template";
const USER = "postgres";
const PASSWORD = "postgres";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("could not allocate a port"));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

export default async function setup(): Promise<() => Promise<void>> {
  const dir = await mkdtemp(join(tmpdir(), "mandate-pg-"));
  const port = await freePort();
  const pg = new EmbeddedPostgres({
    databaseDir: join(dir, "data"),
    port,
    user: USER,
    password: PASSWORD,
    persistent: false,
    autoRehydrateSymlinks: true,
    // Many short-lived per-test pools across parallel workers.
    postgresFlags: ["-c", "max_connections=400", "-c", "fsync=off", "-c", "synchronous_commit=off"],
    onLog: () => {},
    onError: (err) => console.error("[embedded-postgres]", err),
  });

  await pg.initialise();
  await pg.start();

  const baseUrl = `postgres://${USER}:${PASSWORD}@127.0.0.1:${port}`;

  const admin = new Pool({ connectionString: `${baseUrl}/postgres`, max: 1 });
  await admin.query(`CREATE DATABASE "${TEMPLATE_DB}"`);
  await admin.end();

  const templatePool = new Pool({ connectionString: `${baseUrl}/${TEMPLATE_DB}`, max: 1 });
  await migrate(drizzle(templatePool), { migrationsFolder: "./drizzle" });
  await templatePool.end();

  process.env.TEST_PG = "1";
  process.env.TEST_PG_BASE_URL = baseUrl;
  process.env.TEST_PG_TEMPLATE = TEMPLATE_DB;

  return async () => {
    await pg.stop();
    await rm(dir, { recursive: true, force: true });
  };
}
