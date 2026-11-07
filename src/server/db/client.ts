import { neonConfig, Pool } from "@neondatabase/serverless";
import { drizzle, type NeonDatabase } from "drizzle-orm/neon-serverless";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import ws from "ws";

import * as schema from "./schema";

// Node (unlike edge runtimes / browsers) does not provide a global
// `WebSocket` on every supported version, and the Neon serverless
// driver needs one to open pooled connections. Wiring `ws` in here
// keeps this client usable from a plain Node server.
neonConfig.webSocketConstructor = ws;

/**
 * `Db` is a union of the production (Neon) and test (PGlite) database
 * types. Both implement the same Drizzle query-builder surface
 * (`select`/`insert`/`update`/...), so code written against `Db` works
 * against either backend.
 */
export type Db = NeonDatabase<typeof schema> | PgliteDatabase<typeof schema>;

let instance: NeonDatabase<typeof schema> | null = null;

function createDb(): NeonDatabase<typeof schema> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is not set. The database client is created lazily " +
        "so modules can be imported without it, but a connection is " +
        "required to actually run a query.",
    );
  }

  const pool = new Pool({ connectionString });
  // An idle pooled client can error (e.g. Neon closing an idle connection
  // or a compute scaling to zero). Without a listener that `error` event
  // is unhandled and crashes the process. Log the error's name/code/
  // message only — never the connection string or query parameters.
  pool.on("error", (err: Error & { code?: string }) => {
    console.error(`[db] idle pool client error: ${err.name}${err.code ? ` (${err.code})` : ""}: ${err.message}`);
  });
  return drizzle(pool, { schema });
}

/**
 * Lazily-initialized production database client. The underlying Neon
 * `Pool` and Drizzle instance are not created until the first property
 * access, so importing this module never requires `DATABASE_URL` to be
 * set (e.g. in tests, or during `drizzle-kit generate`).
 */
export const db: NeonDatabase<typeof schema> = new Proxy(
  {} as NeonDatabase<typeof schema>,
  {
    get(_target, prop, receiver) {
      if (!instance) {
        instance = createDb();
      }
      return Reflect.get(instance, prop, receiver);
    },
  },
);

// Next's dev server tears down and recreates modules on every HMR reload, so
// a plain module-level variable would spin up a fresh in-memory PGlite (and
// re-run migrations) on every edit. Caching the promise on `globalThis`
// survives that reload and keeps one PGlite instance alive for the whole
// dev process.
declare global {
  var __mandateDevDb: Promise<Db> | undefined;
}

/**
 * Resolves the database client to use for a request:
 * - `DATABASE_URL` set → the Neon client above.
 * - Otherwise, outside production → a process-singleton in-memory PGlite
 *   with migrations applied (Neon is not provisioned yet for local/dev use).
 * - Otherwise (production with no `DATABASE_URL`) → throws, rather than
 *   silently falling back to an in-memory database in production.
 */
export async function getDb(): Promise<Db> {
  if (process.env.DATABASE_URL) {
    return db;
  }

  // `process.env.NODE_ENV` is inlined at build time, so in a production
  // build this whole branch — and with it the `./testing` import that pulls
  // in `@electric-sql/pglite` (a devDependency) — is dead code the bundler
  // drops. Keep the dynamic import INSIDE this literal NODE_ENV check.
  if (process.env.NODE_ENV !== "production") {
    if (!globalThis.__mandateDevDb) {
      // Assigned synchronously (no await before it) so concurrent first
      // requests share one PGlite; a failed start is evicted rather than
      // cached, so one bad attempt can't break every later request.
      const starting: Promise<Db> = import("./testing")
        .then(({ createTestDb }) => createTestDb())
        .catch((err: unknown) => {
          if (globalThis.__mandateDevDb === starting) {
            globalThis.__mandateDevDb = undefined;
          }
          throw err;
        });
      globalThis.__mandateDevDb = starting;
    }
    return globalThis.__mandateDevDb;
  }

  throw new Error(
    "DATABASE_URL is not set. A real database connection is required in " +
      "production; set DATABASE_URL to a Neon connection string.",
  );
}
