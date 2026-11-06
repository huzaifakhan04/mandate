/**
 * P2 Task 6: the "Sandbox worlds" owner routes — create, +1 / +7 days,
 * reset — and path B into a private world.
 *
 * Every route is same origin (403) → session (401) → ownership (404):
 * another principal's world, an archived one, the main world or a
 * malformed id all 404 with nothing changed.
 */
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createOwnerHandlers } from "@/server/auth/ownerRoutes";
import { SESSION_COOKIE_NAME, createSession } from "@/server/auth/session";
import { createWorldHandlers } from "@/server/auth/worldRoutes";
import type { Db } from "@/server/db/client";
import { agents, events, principals, worlds } from "@/server/db/schema";
import { createTestDb } from "@/server/db/testing";
import { createPrivateWorld } from "@/server/services/privateWorlds";
import { ensureMainWorld } from "@/server/services/worlds";

const ORIGIN = "https://mandate.test";
const EVIL = "https://evil.example.com";

describe("sandbox world routes (P2 Task 6)", () => {
  let db: Db;
  let handlers: ReturnType<typeof createWorldHandlers>;
  let owner: string;
  let other: string;

  beforeEach(async () => {
    vi.stubEnv("SESSION_SECRET", "unit-test-session-secret-0123456789abcdef");
    vi.stubEnv("API_KEY_PEPPER", "test-pepper");
    vi.stubEnv("PUBLIC_BASE_URL", ORIGIN);
    db = await createTestDb();
    handlers = createWorldHandlers({ getDb: async () => db });
    owner = await newPrincipal("OWNER");
    other = await newPrincipal("OTHER");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function newPrincipal(name: string): Promise<string> {
    const [row] = await db
      .insert(principals)
      .values({ paypalPayerId: name, email: `${name}@example.com`, name, entityType: "individual", verifiedAt: new Date() })
      .returning();
    return row!.id;
  }

  function post(
    path: string,
    principalId: string | null,
    fields: Record<string, string> = {},
    { origin = ORIGIN, html = false }: { origin?: string; html?: boolean } = {},
  ): Request {
    const headers: Record<string, string> = {
      origin,
      accept: html ? "text/html" : "application/json",
      "content-type": "application/x-www-form-urlencoded",
    };
    if (principalId) {
      headers.cookie = `${SESSION_COOKIE_NAME}=${encodeURIComponent(createSession(principalId))}`;
    }
    return new Request(`${ORIGIN}${path}`, { method: "POST", headers, body: new URLSearchParams(fields) });
  }

  async function makeWorld(principalId = owner, name = "Mine"): Promise<string> {
    const created = await createPrivateWorld(db, principalId, { name });
    if (created.outcome !== "created") throw new Error(created.outcome);
    return created.worldId;
  }

  async function world(id: string) {
    const [row] = await db.select().from(worlds).where(eq(worlds.id, id));
    return row!;
  }

  it("create: 303 to the new world's page; the fourth world → 409 limit", async () => {
    const res = await handlers.create(post("/dashboard/worlds/create", owner, { name: "Judges" }, { html: true }));
    expect(res.status).toBe(303);
    const location = new URL(res.headers.get("location")!);
    const id = location.pathname.split("/").pop()!;
    expect(location.pathname).toBe(`/dashboard/worlds/${id}`);
    expect(await world(id)).toMatchObject({ kind: "private", ownerPrincipalId: owner, name: "Judges", railMode: "sim" });

    await makeWorld(owner, "Two");
    await makeWorld(owner, "Three");
    const fourth = await handlers.create(post("/dashboard/worlds/create", owner, { name: "Four" }));
    expect(fourth.status).toBe(409);
    expect(await fourth.json()).toMatchObject({ error: "world_limit" });
    const fourthHtml = await handlers.create(post("/dashboard/worlds/create", owner, { name: "Four" }, { html: true }));
    expect(fourthHtml.status).toBe(303);
    expect(fourthHtml.headers.get("location")).toContain("/dashboard/worlds?error=limit");

    const blank = await handlers.create(post("/dashboard/worlds/create", other, { name: "   " }));
    expect(blank.status).toBe(400);
  }, 60_000);

  it("create: cross-origin → 403, no session → 401, and nothing is created", async () => {
    expect((await handlers.create(post("/dashboard/worlds/create", owner, { name: "X" }, { origin: EVIL }))).status).toBe(403);
    expect((await handlers.create(post("/dashboard/worlds/create", null, { name: "X" }))).status).toBe(401);
    const html = await handlers.create(post("/dashboard/worlds/create", null, { name: "X" }, { html: true }));
    expect(html.status).toBe(303);
    expect(html.headers.get("location")).toContain("/verify");
    expect(await db.select().from(worlds).where(eq(worlds.kind, "private"))).toEqual([]);
  });

  it("advance: +1 / +7 moves the owner's clock and runs the bots; other days → 400", async () => {
    const id = await makeWorld();
    const one = await handlers.advance(post(`/dashboard/worlds/${id}/advance`, owner, { days: "1" }), id);
    expect(one.status).toBe(200);
    expect(await one.json()).toMatchObject({ ok: true, sim_day: 1 });
    const seven = await handlers.advance(post(`/dashboard/worlds/${id}/advance`, owner, { days: "7" }, { html: true }), id);
    expect(seven.status).toBe(303);
    expect(seven.headers.get("location")).toContain(`/dashboard/worlds/${id}?advanced=7`);
    expect((await world(id)).lastBotSimDay).toBe(8);

    for (const days of ["0", "8", "2", "abc", ""]) {
      expect((await handlers.advance(post(`/dashboard/worlds/${id}/advance`, owner, { days }), id)).status).toBe(400);
    }
    expect((await world(id)).lastBotSimDay).toBe(8);
  }, 60_000);

  it("P5 stress (Review Focus 5): owner-only; main world, another owner's world, archived and malformed → 404; nothing recorded", async () => {
    const id = await makeWorld();
    const { worldId: mainId } = await ensureMainWorld(db);
    const stressEvents = async () => (await db.select().from(events)).filter((event) => event.type.startsWith("stress."));
    for (const target of [id, mainId, "not-a-uuid"]) {
      const who = target === id ? other : owner;
      const res = await handlers.stress(post(`/dashboard/worlds/${target}/stress`, who, { scenario: "rate_spike" }), target);
      expect(res.status).toBe(404);
    }
    // Same origin and a session come first.
    expect(
      (await handlers.stress(post(`/dashboard/worlds/${id}/stress`, owner, { scenario: "rate_spike" }, { origin: EVIL }), id)).status,
    ).toBe(403);
    expect((await handlers.stress(post(`/dashboard/worlds/${id}/stress`, null, { scenario: "rate_spike" }), id)).status).toBe(401);
    for (const scenario of ["", "meteor", "RATE_SPIKE"]) {
      expect((await handlers.stress(post(`/dashboard/worlds/${id}/stress`, owner, { scenario }), id)).status).toBe(400);
    }
    expect(await stressEvents()).toEqual([]);

    const res = await handlers.stress(post(`/dashboard/worlds/${id}/stress`, owner, { scenario: "rate_spike" }), id);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, scenario: "rate_spike", sim_day: 0, params: { bump_bps: 500, apply_sim_day: 1 } });
    const html = await handlers.stress(post(`/dashboard/worlds/${id}/stress`, owner, { scenario: "default_wave" }, { html: true }), id);
    expect(html.status).toBe(303);
    expect(html.headers.get("location")).toContain(`/dashboard/worlds/${id}?stress=default_wave`);
    const recorded = await stressEvents();
    expect(recorded.map((event) => [event.type, event.worldId]).sort()).toEqual(
      [
        ["stress.default_wave", id],
        ["stress.rate_spike", id],
      ].sort(),
    );

    // Archived (after reset) → 404.
    const reset = await handlers.reset(post(`/dashboard/worlds/${id}/reset`, owner), id);
    expect(reset.status).toBe(200);
    expect((await handlers.stress(post(`/dashboard/worlds/${id}/stress`, owner, { scenario: "note_run" }), id)).status).toBe(404);
    expect((await stressEvents()).length).toBe(2);
  }, 60_000);

  it("Review Focus 3/5: another principal's world, the main world, an archived world and a malformed id → 404, unchanged", async () => {
    const id = await makeWorld();
    const { worldId: mainId } = await ensureMainWorld(db);
    for (const target of [id, mainId, "not-a-uuid"]) {
      const who = target === id ? other : owner;
      expect((await handlers.advance(post(`/dashboard/worlds/${target}/advance`, who, { days: "1" }), target)).status).toBe(404);
      expect((await handlers.reset(post(`/dashboard/worlds/${target}/reset`, who), target)).status).toBe(404);
    }
    expect((await world(id)).lastBotSimDay).toBe(0);
    expect((await world(id)).status).toBe("active");

    // Cross-origin and signed-out come first.
    expect((await handlers.advance(post(`/dashboard/worlds/${id}/advance`, owner, { days: "1" }, { origin: EVIL }), id)).status).toBe(403);
    expect((await handlers.reset(post(`/dashboard/worlds/${id}/reset`, null), id)).status).toBe(401);

    // Reset → the old world is archived and 404s from then on.
    const reset = await handlers.reset(post(`/dashboard/worlds/${id}/reset`, owner, {}, { html: true }), id);
    expect(reset.status).toBe(303);
    const freshId = new URL(reset.headers.get("location")!).pathname.split("/").pop()!;
    expect(freshId).not.toBe(id);
    expect(await world(id)).toMatchObject({ status: "archived" });
    expect(await world(freshId)).toMatchObject({ status: "active", kind: "private", name: "Mine" });
    expect((await handlers.reset(post(`/dashboard/worlds/${id}/reset`, owner), id)).status).toBe(404);
    expect((await handlers.advance(post(`/dashboard/worlds/${id}/advance`, owner, { days: "1" }), id)).status).toBe(404);
  }, 60_000);

  it("path B: register into my private world (key bound to it); someone else's world → 404", async () => {
    const owners = createOwnerHandlers({ getDb: async () => db });
    const id = await makeWorld();
    const fields = { name: "Sandbox agent", operator: "me", model: "claude", payout: "sb@example.com" };
    const res = await owners.register(post("/dashboard/agents", owner, { ...fields, world: id }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { agent_id: string; world_id: string };
    expect(body.world_id).toBe(id);
    const [agent] = await db.select().from(agents).where(eq(agents.id, body.agent_id));
    expect(agent).toMatchObject({ worldId: id, principalId: owner, isBot: false });

    const intruder = await owners.register(post("/dashboard/agents", other, { ...fields, world: id }));
    expect(intruder.status).toBe(404);
    expect(await db.select().from(agents).where(and(eq(agents.worldId, id), eq(agents.principalId, other)))).toEqual([]);

    const main = await owners.register(post("/dashboard/agents", owner, { ...fields, world: "main" }));
    expect(main.status).toBe(201);
    const { worldId: mainId } = await ensureMainWorld(db);
    expect(((await main.json()) as { world_id: string }).world_id).toBe(mainId);
  }, 60_000);
});
