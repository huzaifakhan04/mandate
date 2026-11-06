/**
 * Read-only production database census (I1, final review).
 *
 *   npx tsx --env-file=.env.local scripts/ops/prod-db-census.ts
 *
 * Prints ONLY: row counts per public table, the distinct
 * `paypal_operations.status` values (with counts), and which drizzle
 * migrations are applied (matched to ./drizzle tags by content hash, the
 * way drizzle's migrator records them) or still pending. Never prints row
 * data or the connection string. Every query runs inside a
 * `BEGIN TRANSACTION READ ONLY` that is rolled back — it cannot write.
 */
import { createHash } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";

import { neonConfig, Pool } from "@neondatabase/serverless";
import ws from "ws";

neonConfig.webSocketConstructor = ws;

interface JournalFile {
  entries: { idx: number; tag: string; when: number }[];
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is not set (run with --env-file=.env.local).");
  }

  const pool = new Pool({ connectionString: url, max: 1 });
  const client = await pool.connect();
  try {
    await client.query("BEGIN TRANSACTION READ ONLY");

    const tables = await client.query<{ table_name: string }>(
      `select table_name from information_schema.tables
       where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name`,
    );
    console.log("== row counts (public) ==");
    for (const { table_name } of tables.rows) {
      const quoted = `"${table_name.replace(/"/g, '""')}"`;
      const count = await client.query<{ n: string }>(`select count(*)::text as n from ${quoted}`);
      console.log(`${table_name.padEnd(24)} ${count.rows[0]!.n}`);
    }

    console.log("\n== paypal_operations.status ==");
    const statuses = await client.query<{ status: string; n: string }>(
      `select status, count(*)::text as n from paypal_operations group by status order by status`,
    );
    if (statuses.rows.length === 0) {
      console.log("(no rows)");
    }
    for (const row of statuses.rows) {
      console.log(`${row.status.padEnd(24)} ${row.n}`);
    }

    console.log("\n== drizzle migrations ==");
    const journal = JSON.parse(readFileSync(join("drizzle", "meta", "_journal.json"), "utf8")) as JournalFile;
    const localByHash = new Map(
      journal.entries.map((entry) => [
        createHash("sha256").update(readFileSync(join("drizzle", `${entry.tag}.sql`)).toString()).digest("hex"),
        entry.tag,
      ]),
    );
    let appliedHashes: string[] = [];
    try {
      const applied = await client.query<{ hash: string }>(
        `select hash from drizzle.__drizzle_migrations order by created_at, id`,
      );
      appliedHashes = applied.rows.map((row) => row.hash);
    } catch {
      console.log("(no drizzle.__drizzle_migrations table)");
    }
    for (const hash of appliedHashes) {
      console.log(`applied  ${localByHash.get(hash) ?? `<unknown hash ${hash.slice(0, 12)}…>`}`);
    }
    const appliedSet = new Set(appliedHashes);
    for (const [hash, tag] of localByHash) {
      if (!appliedSet.has(hash)) {
        console.log(`pending  ${tag}`);
      }
    }
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
    await pool.end();
  }
}

main().catch((err: unknown) => {
  // Name + message only — never a stack with connection details.
  const e = err instanceof Error ? err : new Error(String(err));
  console.error(`census failed: ${e.name}: ${e.message}`);
  process.exit(1);
});
