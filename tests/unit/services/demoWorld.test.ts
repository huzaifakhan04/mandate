/**
 * P8: the public demo world — created idempotently, sim-only with bots v2
 * (incl. a defaulter), auto-advanced by the tick (1 sim day / 10 real
 * minutes, bounded catch-up, mild stress every 3rd day), reset after 90
 * sim days, read-only from outside, the console's default for anonymous
 * visitors, and template-only AI (no LLM spend).
 */
import { and, eq, inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { generateApiKey } from "@/server/auth/apiKeys";
import { createConsoleHandlers } from "@/server/auth/consoleRoutes";
import { createWorldHandlers } from "@/server/auth/worldRoutes";
import { SESSION_COOKIE_NAME, createSession } from "@/server/auth/session";
import { advanceClock, getSimDay } from "@/server/clock/clock";
import "@/server/contracts/tools";
import { findTool } from "@/server/contracts/registry";
import { runTool } from "@/server/contracts/runTool";
import { borrowerArchetype } from "@/server/bots/borrowerBot";
import type { Db } from "@/server/db/client";
import { agents, apiKeys, economyState, events, principals, worlds } from "@/server/db/schema";
import { createTestDb } from "@/server/db/testing";
import { runTick } from "@/server/jobs/tick";
import { trialBalance } from "@/server/ledger/trialBalance";
import {
  consoleWorldParam,
  defaultConsoleWorld,
  resolveConsoleWorld,
} from "@/server/services/console";
import {
  advanceDemoWorld,
  demoStressFor,
  DEMO_REAL_MS_PER_SIM_DAY,
  DEMO_RESET_SIM_DAYS,
  ensureDemoWorld,
  findDemoWorld,
  pickDemoSeed,
} from "@/server/services/demoWorld";
import { railForWorld } from "@/server/services/worlds";

const ORIGIN = "https://mandate.test";

describe("P8 demo world", () => {
  let db: Db;

  beforeEach(async () => {
    vi.stubEnv("SESSION_SECRET", "unit-test-session-secret-0123456789abcdef");
    vi.stubEnv("API_KEY_PEPPER", "test-pepper");
    vi.stubEnv("PUBLIC_BASE_URL", ORIGIN);
    vi.stubEnv("OPENAI_API_KEY", "");
    db = await createTestDb();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function demo() {
    const world = await findDemoWorld(db);
    expect(world).not.toBeNull();
    return world!;
  }

  it("ensureDemoWorld is idempotent: one sim-rail demo world with bots v2 (4 lenders, 6 borrowers incl. a defaulter), funded", async () => {
    const first = await ensureDemoWorld(db);
    const second = await ensureDemoWorld(db);
    expect(first.created).toBe(true);
    expect(second).toEqual({ worldId: first.worldId, created: false });
    const rows = await db.select().from(worlds).where(eq(worlds.kind, "demo"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ railMode: "sim", status: "active", ownerPrincipalId: null, botVersion: 2 });
    expect(await railForWorld(db, first.worldId)).toBe("sim");

    const bots = await db.select().from(agents).where(eq(agents.worldId, first.worldId));
    expect(bots).toHaveLength(10);
    expect(bots.every((bot) => bot.isBot)).toBe(true);
    // No API keys on the demo world's agents.
    expect(await db.select().from(apiKeys).where(eq(apiKeys.worldId, first.worldId))).toHaveLength(0);
    const borrowers = bots.filter((bot) => bot.principalId !== null);
    expect(borrowers).toHaveLength(6);
    const archetypes = new Set(borrowers.map((_, i) => borrowerArchetype(rows[0]!.botSeed!, i)));
    expect(archetypes).toEqual(new Set(["good", "late", "defaulter"]));
    expect((await trialBalance(db, first.worldId)).totalCents).toBe(0n);
  });

  it("pickDemoSeed always yields a defaulter, a late and a good payer", () => {
    for (const base of ["a", "b", "c", "d"]) {
      const seed = pickDemoSeed(base);
      const kinds = new Set([0, 1, 2, 3, 4, 5].map((i) => borrowerArchetype(seed, i)));
      expect(kinds.has("defaulter") && kinds.has("late") && kinds.has("good")).toBe(true);
    }
  });

  it("the row CHECK keeps a demo world off the PayPal rail, and only one demo world can be active", async () => {
    await ensureDemoWorld(db);
    await expect(
      db.insert(worlds).values({ slug: "demo-paypal", name: "x", railMode: "paypal", kind: "demo", status: "archived" }),
    ).rejects.toThrow();
    await expect(db.insert(worlds).values({ slug: "demo-two", name: "x", railMode: "sim", kind: "demo" })).rejects.toThrow();
  });

  it("the tick advances one sim day per 10 real minutes, at most 3 per tick, running bots, economy and memo", async () => {
    await ensureDemoWorld(db);
    const world = await demo();
    const t0 = world.createdAt.getTime();

    // 9 minutes in: nothing to do.
    let report = await advanceDemoWorld(db, { now: new Date(t0 + 9 * 60_000) });
    expect(report.days).toBe(0);
    // 25 minutes in: days 1 and 2.
    report = await advanceDemoWorld(db, { now: new Date(t0 + 25 * 60_000) });
    expect(report).toMatchObject({ worldId: world.id, days: 2, simDay: 2 });
    expect((await getSimDay(db, world.id)).day).toBe(2);
    // Again at the same instant: idempotent.
    expect((await advanceDemoWorld(db, { now: new Date(t0 + 25 * 60_000) })).days).toBe(0);
    // 3 hours in (day 18 due): bounded catch-up of 3 days per call.
    report = await advanceDemoWorld(db, { now: new Date(t0 + 3 * 3_600_000) });
    expect(report.days).toBe(3);
    expect((await getSimDay(db, world.id)).day).toBe(5);

    const fresh = await demo();
    expect(fresh.lastBotSimDay).toBe(5);
    const economyDays = (await db.select().from(economyState).where(eq(economyState.worldId, world.id))).map((r) => r.simDay);
    expect(Math.max(...economyDays)).toBe(5);
    const botDays = await db.select().from(events).where(and(eq(events.worldId, world.id), eq(events.type, "bot.day")));
    // Day 0 (the seed purchases) plus days 1–5.
    expect(botDays.map((e) => (e.payload as { day: number }).day).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5]);
    // Template memo only — no LLM in the demo world.
    const memos = (await db.select().from(economyState).where(eq(economyState.worldId, world.id))).filter((r) => r.treasuryMemo);
    expect(memos.length).toBeGreaterThan(0);
    expect(memos.every((r) => (r.treasuryMemo as { source: string }).source === "template")).toBe(true);
    expect((await trialBalance(db, world.id)).totalCents).toBe(0n);
  });

  it("injects a mild stress event every 3rd sim day, in rotation", async () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 12].map(demoStressFor)).toEqual([
      null,
      null,
      "rate_spike",
      null,
      null,
      "note_run",
      null,
      null,
      "default_wave",
      "rate_spike",
    ]);
    await ensureDemoWorld(db);
    const world = await demo();
    const t0 = world.createdAt.getTime();
    const report = await advanceDemoWorld(db, { now: new Date(t0 + 3 * DEMO_REAL_MS_PER_SIM_DAY), maxDays: 3 });
    expect(report.stress).toEqual(["rate_spike"]);
    const [spike] = await db.select().from(events).where(and(eq(events.worldId, world.id), eq(events.type, "stress.rate_spike")));
    expect(spike!.payload).toMatchObject({ sim_day: 3, mild: true, params: { bump_bps: 200, apply_sim_day: 4 } });
    const more = await advanceDemoWorld(db, { now: new Date(t0 + 6 * DEMO_REAL_MS_PER_SIM_DAY), maxDays: 3 });
    expect(more.stress).toEqual(["note_run"]);
    const [run] = await db.select().from(events).where(and(eq(events.worldId, world.id), eq(events.type, "stress.note_run")));
    expect((run!.payload as { params: { order: string[] } }).params.order).toHaveLength(1);
  });

  it("resets after 90 sim days: archived (never deleted) and recreated", async () => {
    await ensureDemoWorld(db);
    const old = await demo();
    await advanceClock(db, old.id, DEMO_RESET_SIM_DAYS);
    const report = await advanceDemoWorld(db, { now: new Date(old.createdAt.getTime() + 1_000 * DEMO_REAL_MS_PER_SIM_DAY) });
    expect(report.reset).toMatchObject({ archivedWorldId: old.id });
    const [archived] = await db.select().from(worlds).where(eq(worlds.id, old.id));
    expect(archived).toMatchObject({ status: "archived" });
    const fresh = await demo();
    expect(fresh.id).not.toBe(old.id);
    expect(fresh.id).toBe(report.reset!.worldId);
    expect((await getSimDay(db, fresh.id)).day).toBe(0);
    expect(await db.select().from(agents).where(eq(agents.worldId, fresh.id))).toHaveLength(10);
  });

  it("runTick: the cron's ensureDemo creates it; a plain tick advances an existing one and reports it", async () => {
    const plain = await runTick(db, { now: new Date() });
    expect(plain.demo).toMatchObject({ worldId: null, days: 0 });
    expect(await findDemoWorld(db)).toBeNull();
    const cron = await runTick(db, { ensureDemo: true });
    expect(cron.demo).toMatchObject({ created: true });
    const world = await demo();
    const later = await runTick(db, { now: new Date(world.createdAt.getTime() + 11 * 60_000) });
    expect(later.demo).toMatchObject({ worldId: world.id, days: 1, simDay: 1 });
  });

  describe("immutability", () => {
    it("nobody acts in the demo world through the API: a key on a demo agent → DEMO_WORLD_READ_ONLY; register_agent lands in main", async () => {
      const { worldId } = await ensureDemoWorld(db);
      const [bot] = await db.select().from(agents).where(eq(agents.worldId, worldId)).limit(1);
      // Even a key smuggled onto a demo agent is refused (defence in depth).
      const generated = generateApiKey();
      await db.insert(apiKeys).values({ worldId, agentId: bot!.id, prefix: generated.prefix, keyHash: generated.hash });
      for (const tool of ["get_status", "buy_notes"]) {
        const result = await runTool(findTool(tool), tool, tool === "buy_notes" ? { amount_cents: 1000 } : {}, {
          getDb: async () => db,
          authorization: `Bearer ${generated.key}`,
        });
        expect(result.httpStatus).toBe(403);
        expect(result.envelope.status).toBe("DEMO_WORLD_READ_ONLY");
      }
      const registered = await runTool(findTool("register_agent"), "register_agent", { name: "Visitor", payout_email: "v@example.com" }, {
        getDb: async () => db,
      });
      const [agent] = await db.select().from(agents).where(eq(agents.id, (registered.envelope.data as { agent_id: string }).agent_id));
      expect(agent!.worldId).not.toBe(worldId);
      // The server's own bots still act there.
      const botCall = await runTool(findTool("get_status"), "get_status", {}, { getDb: async () => db, actingBotId: bot!.id });
      expect(botCall.httpStatus).toBe(200);
    });

    it("owner world controls (advance / stress / reset) 404 for the demo world", async () => {
      const { worldId } = await ensureDemoWorld(db);
      const [someone] = await db
        .insert(principals)
        .values({ paypalPayerId: "SOMEONE", email: "s@example.com", name: "S", entityType: "individual", verifiedAt: new Date() })
        .returning();
      const handlers = createWorldHandlers({ getDb: async () => db });
      const headers = {
        origin: ORIGIN,
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
        cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(createSession(someone!.id))}`,
      };
      const post = (path: string, body: string) => new Request(`${ORIGIN}${path}`, { method: "POST", headers, body });
      expect((await handlers.advance(post(`/dashboard/worlds/${worldId}/advance`, "days=7"), worldId)).status).toBe(404);
      expect((await handlers.stress(post(`/dashboard/worlds/${worldId}/stress`, "scenario=note_run"), worldId)).status).toBe(404);
      expect((await handlers.reset(post(`/dashboard/worlds/${worldId}/reset`, ""), worldId)).status).toBe(404);
      expect((await getSimDay(db, worldId)).day).toBe(0);
      expect(await db.select().from(worlds).where(and(eq(worlds.kind, "demo"), inArray(worlds.status, ["active"])))).toHaveLength(1);
    });
  });

  describe("console", () => {
    it("everyone defaults to the main world; `demo` is public, its raw id is not", async () => {
      expect(defaultConsoleWorld()).toBe("main");
      const world = await resolveConsoleWorld(db, null, "demo");
      expect(world).toMatchObject({ kind: "demo", rail: "sim", name: "Demo world" });
      expect(consoleWorldParam(world!)).toBe("demo");
      expect(await resolveConsoleWorld(db, null, world!.id)).toBeNull();
    });

    it("the snapshot and calendar APIs serve ?world=demo to anyone, no-store and PII-free", async () => {
      const handlers = createConsoleHandlers({ getDb: async () => db });
      const res = await handlers.snapshot(new Request(`${ORIGIN}/api/console/snapshot?world=demo`));
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const text = await res.text();
      expect(text).not.toContain("@");
      const body = JSON.parse(text) as { snapshot: { world: { kind: string; rail: string }; flow: { lenderCount: number; borrowerCount: number } } };
      expect(body.snapshot.world).toMatchObject({ kind: "demo", rail: "sim" });
      expect(body.snapshot.flow.lenderCount).toBe(4);
      const calendar = await handlers.calendar(new Request(`${ORIGIN}/api/console/calendar?world=demo`));
      expect(calendar.status).toBe(200);
    });
  });
});
