import { cp, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Db } from "@/server/db/client";
import * as schema from "@/server/db/schema";
import { createEmptyPgDatabase } from "@/server/db/testingPg";
import { runReconcile } from "@/server/jobs/reconcile";
import { trialBalance } from "@/server/ledger/trialBalance";
import { ensureMainWorld } from "@/server/services/worlds";

/**
 * I1 (final review): migration dry run on a real Postgres. Applies only
 * 0000+0001 (the P0 schema that is live in production), writes the kinds
 * of rows P0 wrote — a main world, its clock, the P0 chart of accounts, a
 * balanced journal, an idempotency row, and `paypal_operations` rows with
 * P0's `pending`/`succeeded`/`failed` statuses and raw PayPal bodies —
 * then applies 0002..latest with the same drizzle migrator production
 * uses, and checks the data migration and that current code runs on top.
 */

interface JournalFile {
  entries: { idx: number; tag: string }[];
}

const P0_CHART: Record<string, string> = {
  cash_paypal: "asset",
  loans_receivable: "asset",
  fees_receivable: "asset",
  allowance_for_losses: "contra_asset",
  notes_payable: "liability",
  payable_to_borrower: "liability",
  fee_income: "income",
  late_fee_income: "income",
  provision_expense: "expense",
  bank_equity: "equity",
  suspense: "asset",
};

let tmpDir: string | null = null;

afterEach(async () => {
  vi.unstubAllGlobals();
  if (tmpDir) {
    await rm(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
});

/** A copy of ./drizzle whose journal lists only the first `count` migrations. */
async function partialMigrationsFolder(count: number): Promise<string> {
  tmpDir = await mkdtemp(join(tmpdir(), "mandate-migrations-"));
  await cp("./drizzle", tmpDir, { recursive: true });
  const journalPath = join(tmpDir, "meta", "_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8")) as JournalFile;
  journal.entries = journal.entries.slice(0, count);
  await writeFile(journalPath, JSON.stringify(journal));
  return tmpDir;
}

describe("migration dry run: P0 data → 0002..latest (real Postgres)", () => {
  it("applies on top of P0 rows and data-migrates paypal_operations statuses", async () => {
    const { pool } = await createEmptyPgDatabase();
    const raw = drizzle(pool);

    // 1. The P0 schema only.
    await migrate(raw, { migrationsFolder: await partialMigrationsFolder(2) });
    const p0Applied = await pool.query(`select count(*)::int as n from drizzle.__drizzle_migrations`);
    expect(p0Applied.rows[0].n).toBe(2);

    // 2. Representative P0 rows (raw SQL: today's schema has columns P0 didn't).
    const world = await pool.query(
      `insert into worlds (slug, name, rail_mode) values ('main', 'Main', 'paypal') returning id`,
    );
    const worldId = world.rows[0].id as string;
    await pool.query(
      // A frozen main clock that was advanced 3 days by hand (sim now = 2030-01-04).
      `insert into clock (world_id, anchor_real, anchor_sim, speed, manual_offset_ms)
       values ($1, now() - interval '2 days', '2030-01-01T00:00:00Z', '0', 259200000)`,
      [worldId],
    );
    for (const [code, type] of Object.entries(P0_CHART)) {
      await pool.query(`insert into ledger_accounts (world_id, code, type) values ($1, $2, $3)`, [worldId, code, type]);
    }
    const accounts = await pool.query(`select id, code from ledger_accounts where world_id = $1`, [worldId]);
    const accountId = (code: string) => accounts.rows.find((r) => r.code === code)!.id as string;
    const entry = await pool.query(
      `insert into journal_entries (world_id, memo, source_type, source_id, sim_at, idempotency_key)
       values ($1, 'P0 test entry', 'test', gen_random_uuid(), now(), 'p0:test:1') returning id`,
      [worldId],
    );
    await pool.query(
      `insert into postings (world_id, entry_id, account_id, amount_cents) values ($1, $2, $3, 500), ($1, $2, $4, -500)`,
      [worldId, entry.rows[0].id, accountId("cash_paypal"), accountId("bank_equity")],
    );
    const agent = await pool.query(
      `insert into agents (world_id, name, operator, model, code_manifest_hash, status)
       values ($1, 'P0 Agent', 'op', 'model', 'hash', 'active') returning id`,
      [worldId],
    );
    await pool.query(
      `insert into idempotency_keys (world_id, agent_id, key, request_hash, response) values ($1, $2, 'k1', 'h1', $3)`,
      [worldId, agent.rows[0].id, JSON.stringify({ status: "OK", data: {} })],
    );

    // What P0's paypalFetch wrote: raw (redacted) PayPal bodies, P0 statuses.
    const ops: [string, string, string | null, unknown, number | null][] = [
      ["order.create", "succeeded", "5O190127TN364715T", { id: "5O190127TN364715T", status: "CREATED", links: [{ rel: "approve", href: "https://www.sandbox.paypal.com/checkoutnow?token=5O190127TN364715T" }] }, 201],
      ["order.capture", "succeeded", "5O190127TN364715T", { id: "5O190127TN364715T", status: "COMPLETED", purchase_units: [{ payments: { captures: [{ id: "3C679366HH908993F", status: "COMPLETED", amount: { currency_code: "USD", value: "10.00" }, seller_receivable_breakdown: { paypal_fee: { currency_code: "USD", value: "0.79" } } }] } }] }, 201],
      ["order.capture", "failed", "8AB12345CD678901E", { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "ORDER_NOT_APPROVED" }] }, 422],
      ["payout.send", "succeeded", "BATCH123", { batch_header: { payout_batch_id: "BATCH123", batch_status: "PENDING" } }, 201],
      ["payout.get", "pending", null, null, null],
    ];
    for (const [kind, status, paypalId, response, httpStatus] of ops) {
      await pool.query(
        `insert into paypal_operations (world_id, rail, kind, request_id, paypal_id, status, request, response, http_status, attempts)
         values ($1, 'paypal', $2, gen_random_uuid()::text, $3, $4, $5, $6, $7, 1)`,
        [worldId, kind, paypalId, status, JSON.stringify({ method: "POST" }), response === null ? null : JSON.stringify(response), httpStatus],
      );
    }

    // 3. Everything after P0, through the real migrator.
    await migrate(raw, { migrationsFolder: "./drizzle" });

    const journal = JSON.parse(await readFile("./drizzle/meta/_journal.json", "utf8")) as JournalFile;
    const applied = await pool.query(`select count(*)::int as n from drizzle.__drizzle_migrations`);
    expect(applied.rows[0].n).toBe(journal.entries.length);

    const statuses = await pool.query(
      `select kind, status, updated_at is not null as has_updated_at from paypal_operations order by kind, status`,
    );
    expect(statuses.rows.map((r) => `${r.kind}:${r.status}`).sort()).toEqual(
      [
        "order.capture:failed_terminal",
        "order.capture:succeeded",
        "order.create:succeeded",
        "payout.get:failed_terminal",
        "payout.send:succeeded",
      ].sort(),
    );
    expect(statuses.rows.every((r) => r.has_updated_at)).toBe(true);
    // Ruling P4-A data migration: speed 1, re-anchored at now, sim time preserved.
    const mainClock = await pool.query(
      `select speed::float8 as speed, manual_offset_ms::text as offset, anchor_sim, anchor_real > now() - interval '1 minute' as fresh from clock where world_id = $1`,
      [worldId],
    );
    expect(mainClock.rows[0]).toMatchObject({ speed: 1, offset: "0", fresh: true });
    expect((mainClock.rows[0].anchor_sim as Date).toISOString()).toBe("2030-01-04T00:00:00.000Z");
    const idem = await pool.query(`select http_status, response from idempotency_keys`);
    expect(idem.rows).toEqual([{ http_status: null, response: { status: "OK", data: {} } }]);

    // 4. Current code on top of the migrated P0 data.
    const fetchSpy = vi.fn(async () => {
      throw new Error("no network in tests");
    });
    vi.stubGlobal("fetch", fetchSpy);
    const db = drizzle(pool, { schema }) as unknown as Db;
    const main = await ensureMainWorld(db); // adopts the P0 main world, seeds series + capital
    expect(main.worldId).toBe(worldId);
    const series = await db.execute(sql`select name from note_series where world_id = ${worldId}`);
    expect(series.rows).toEqual([{ name: "Mandate Pool A" }]);
    expect((await trialBalance(db, worldId)).totalCents).toBe(0n);

    const report = await runReconcile(db);
    expect(report.errors).toEqual([]);
    // P0 rows are terminal/succeeded: nothing is re-executed against PayPal.
    expect(report.executed).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
