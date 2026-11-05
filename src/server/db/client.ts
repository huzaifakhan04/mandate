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
