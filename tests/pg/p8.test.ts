/**
 * P8 on real Postgres (separate pool connections, genuinely concurrent):
 * the rate-limit upsert admits exactly `limit` of N concurrent hits;
 * concurrent `ensureDemoWorld` calls create one demo world; concurrent
 * demo-world ticks never advance the same sim day twice.
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getSimDay } from "@/server/clock/clock";
import type { Db } from "@/server/db/client";
import { rateLimits, worlds } from "@/server/db/schema";
import { createTestDb } from "@/server/db/testing";
import { HOUR_MS, takeDbRateLimits } from "@/server/http/dbRateLimit";
import { advanceDemoWorld, DEMO_REAL_MS_PER_SIM_DAY, ensureDemoWorld, findDemoWorld } from "@/server/services/demoWorld";

describe("P8 on real Postgres", () => {
  let db: Db;

  beforeEach(async () => {
    vi.stubEnv("API_KEY_PEPPER", "test-pepper");
    vi.stubEnv("RATE_LIMITS_DISABLED", "");
    db = await createTestDb();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("40 concurrent hits on a limit of 10: exactly 10 allowed, every hit counted", async () => {
    const now = new Date("2026-11-08T12:30:00Z");
    const results = await Promise.all(
      Array.from({ length: 40 }, () => takeDbRateLimits(db, [{ key: "pg:burst", limit: 10, windowMs: HOUR_MS }], now)),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(10);
    expect(results.filter((r) => !r.allowed).every((r) => r.retryAfterSeconds === 30 * 60)).toBe(true);
    const rows = await db.select().from(rateLimits).where(eq(rateLimits.bucketKey, "pg:burst"));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.count).toBe(40);
  });

  it("concurrent ensureDemoWorld calls create exactly one demo world", async () => {
    const results = await Promise.all([ensureDemoWorld(db), ensureDemoWorld(db), ensureDemoWorld(db)]);
    expect(new Set(results.map((r) => r.worldId)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(await db.select().from(worlds).where(eq(worlds.kind, "demo"))).toHaveLength(1);
  });

  it("concurrent demo ticks never advance a day twice", async () => {
    await ensureDemoWorld(db);
    const world = (await findDemoWorld(db))!;
    const now = new Date(world.createdAt.getTime() + 2 * DEMO_REAL_MS_PER_SIM_DAY + 1_000);
    const reports = await Promise.all([advanceDemoWorld(db, { now }), advanceDemoWorld(db, { now }), advanceDemoWorld(db, { now })]);
    expect(reports.reduce((sum, r) => sum + r.days, 0)).toBe(2);
    expect((await getSimDay(db, world.id)).day).toBe(2);
  });
});
