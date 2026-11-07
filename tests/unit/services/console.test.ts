/**
 * P6: the public bank console's read model (`services/console.ts`) and its
 * snapshot route (`auth/consoleRoutes.ts`).
 *
 * - No PII: the snapshot JSON of a busy private world carries no email
 *   (no '@' at all), no PayPal payer id, no payout receiver, no PayPal
 *   request/response bodies.
 * - Ownership: the main world is public; a private world is served only to
 *   its signed-in owner — another principal, no session, an archived
 *   world, another main-kind world or a malformed id all 404.
 * - Rate limit: a per-IP token bucket answers 429 + retry-after past the burst.
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createConsoleHandlers, SNAPSHOT_BURST } from "@/server/auth/consoleRoutes";
import { SESSION_COOKIE_NAME, createSession } from "@/server/auth/session";
import type { Db } from "@/server/db/client";
import { agents, principals, worlds } from "@/server/db/schema";
import { createTestDb } from "@/server/db/testing";
import { clientKey, createTokenBucket } from "@/server/http/rateLimit";
import { clientIp } from "@/server/services/mandates";
import { dailyMovements } from "@/server/ledger/consoleLedger";
import { getSimDay } from "@/server/clock/clock";
import {
  SNAPSHOT_CACHE_TTL_MS,
  cachedConsoleSnapshot,
  invalidateConsoleSnapshot,
  consoleSnapshot,
  consoleWorldChoices,
  requestAmountCents,
  resolveConsoleWorld,
  scrubText,
  truncateId,
} from "@/server/services/console";
import { advancePrivateWorld, createPrivateWorld } from "@/server/services/privateWorlds";
import { createWorld, ensureMainWorld } from "@/server/services/worlds";

const OWNER_PAYER_ID = "QX7PAYER9KZ2M";
const OTHER_PAYER_ID = "ZZ4OTHER8HJ1N";
const RECEIVER = "secret.receiver@example.com";
/** PayPal payer ids are 13 upper-case alphanumerics. */
const PAYER_ID_RE = /\b[A-Z0-9]{13}\b/;

describe("console read model (P6)", () => {
  let db: Db;
  let owner: string;
  let other: string;

  beforeEach(async () => {
    vi.stubEnv("SESSION_SECRET", "unit-test-session-secret-0123456789abcdef");
    vi.stubEnv("API_KEY_PEPPER", "test-pepper");
    db = await createTestDb();
    owner = await newPrincipal("Owner", OWNER_PAYER_ID);
    other = await newPrincipal("Other", OTHER_PAYER_ID);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function newPrincipal(name: string, payerId: string): Promise<string> {
    const [row] = await db
      .insert(principals)
      .values({
        paypalPayerId: payerId,
        email: `${name.toLowerCase()}@example.com`,
        name,
        entityType: "individual",
        verifiedAt: new Date(),
      })
      .returning();
    return row!.id;
  }

  async function busyWorld(days = 7): Promise<string> {
    const created = await createPrivateWorld(db, owner, { name: "Judges", seed: "console-seed" });
    if (created.outcome !== "created") {
      throw new Error(`world not created: ${created.outcome}`);
    }
    // An agent whose free text and payout details carry PII.
    await db.insert(agents).values({
      worldId: created.worldId,
      principalId: owner,
      name: "Leaky bob@corp.example",
      operator: "ops@corp.example",
      model: "test-model",
      codeManifestHash: "deadbeef",
      status: "active",
      payoutReceiver: RECEIVER,
      payoutReceiverType: "email",
    });
    const advanced = await advancePrivateWorld(db, owner, created.worldId, days);
    expect(advanced.outcome).toBe("advanced");
    return created.worldId;
  }

  describe("snapshot", () => {
    it("shows a busy private world's KPIs, series, log, flow and grids with no PII", async () => {
      const worldId = await busyWorld(7);
      const world = await resolveConsoleWorld(db, owner, worldId);
      expect(world).toMatchObject({ id: worldId, kind: "private", rail: "sim", name: "Judges" });
      const snapshot = await consoleSnapshot(db, world!);

      expect(snapshot.clock.simDay).toBe(7);
      expect(snapshot.series.length).toBe(8);
      expect(snapshot.series.at(-1)!.day).toBe(7);
      expect(snapshot.kpis.cashCents).toBeGreaterThan(0);
      expect(snapshot.kpis.notesOutstandingCents).toBeGreaterThan(0);
      expect(snapshot.kpis.baseRateBps).toBeGreaterThan(0);
      expect(snapshot.series.at(-1)!.cashCents).toBe(snapshot.kpis.cashCents);
      expect(snapshot.series.at(-1)!.notesCents).toBe(snapshot.kpis.notesOutstandingCents);
      expect(snapshot.kpis.memo?.headline).toBeTruthy();
      expect(snapshot.paypalLog.length).toBeGreaterThan(0);
      expect(snapshot.paypalLog.length).toBeLessThanOrEqual(50);
      expect(snapshot.paypalLog.every((op) => op.rail === "sim")).toBe(true);
      // newest first
      const times = snapshot.paypalLog.map((op) => op.at);
      expect([...times].sort().reverse()).toEqual(times);
      expect(snapshot.flow.activity.length).toBeGreaterThan(0);
      expect(snapshot.flow.lenderCount).toBeGreaterThan(0);
      expect(snapshot.ledger.length).toBeGreaterThan(0);
      expect(snapshot.loans.length).toBeGreaterThan(0);
      expect(snapshot.notes.length).toBeGreaterThan(0);
      expect(snapshot.agents.length).toBeGreaterThan(0);
      // Each journal entry shown balances.
      const byEntry = new Map<string, number>();
      for (const line of snapshot.ledger) {
        byEntry.set(line.entry, (byEntry.get(line.entry) ?? 0) + (line.debitCents ?? 0) - (line.creditCents ?? 0));
      }
      expect([...byEntry.values()].every((sum) => sum === 0)).toBe(true);

      // --- no PII ---
      const json = JSON.stringify(snapshot);
      expect(json).not.toContain("@");
      expect(json).not.toMatch(PAYER_ID_RE);
      expect(json).not.toContain(OWNER_PAYER_ID);
      expect(json).not.toContain(RECEIVER);
      expect(json).not.toContain("corp.example");
      for (const key of ['"email"', '"payoutReceiver"', '"payout_receiver"', '"request"', '"response"', '"payerId"', '"principalId"', '"memo":"']) {
        expect(json).not.toContain(key);
      }
      expect(snapshot.agents.find((a) => a.name.startsWith("Leaky"))?.name).toBe("Leaky [redacted]");
      // PayPal ids are truncated.
      for (const op of snapshot.paypalLog) {
        if (op.paypalId) {
          expect(op.paypalId).toContain("…");
          expect(op.paypalId.length).toBeLessThanOrEqual(7);
        }
      }
    });

    it("an empty main world renders with zeroed KPIs", async () => {
      const world = await resolveConsoleWorld(db, null, null);
      const snapshot = await consoleSnapshot(db, world!);
      expect(snapshot.world.kind).toBe("main");
      expect(snapshot.paypalLog).toEqual([]);
      expect(snapshot.loans).toEqual([]);
      expect(snapshot.kpis.defaults).toBe(0);
      expect(JSON.stringify(snapshot)).not.toContain("@");
    });
  });

  describe("cache and bounded aggregates (P6 review)", () => {
    it("single-flight per world+view, fresh for the TTL, invalidated by owner actions", async () => {
      const worldId = await busyWorld(1);
      const priv = (await resolveConsoleWorld(db, owner, worldId))!;
      const main = (await resolveConsoleWorld(db, null, null))!;
      let now = 1_000_000;
      const clock = () => now;

      const a = cachedConsoleSnapshot(db, priv, clock);
      const b = cachedConsoleSnapshot(db, priv, clock);
      expect(a).toBe(b); // concurrent callers share one computation
      await a;
      now += SNAPSHOT_CACHE_TTL_MS - 1;
      expect(cachedConsoleSnapshot(db, priv, clock)).toBe(a);
      now += 2;
      const c = cachedConsoleSnapshot(db, priv, clock);
      expect(c).not.toBe(a);
      await c;

      // The owner-only view is never served under the public key.
      const asPublic = cachedConsoleSnapshot(db, { ...priv, kind: "main" }, clock);
      expect(asPublic).not.toBe(c);
      await asPublic;
      const pub = cachedConsoleSnapshot(db, main, clock);
      expect(pub).not.toBe(c);
      await pub;

      invalidateConsoleSnapshot(worldId);
      const d = cachedConsoleSnapshot(db, priv, clock);
      expect(d).not.toBe(c);
      expect((await d).world.id).toBe(worldId);
    });

    it("daily movements collapse history before the window into one opening bucket", async () => {
      const worldId = await busyWorld(7);
      const { anchorSim } = await getSimDay(db, worldId);
      const full = await dailyMovements(db, worldId, anchorSim, 0);
      const bounded = await dailyMovements(db, worldId, anchorSim, 5);
      expect(Math.min(...bounded.map((m) => m.day))).toBeGreaterThanOrEqual(4);
      const through = (rows: typeof full, code: string, day: number) =>
        rows.filter((m) => m.code === code && m.day <= day).reduce((s, m) => s + m.total, 0n);
      for (const code of ["cash_paypal", "loans_receivable", "notes_payable", "allowance_for_losses"]) {
        for (const day of [5, 6, 7]) {
          expect(through(bounded, code, day)).toBe(through(full, code, day));
        }
      }
    });
  });

  describe("world switching (ownership)", () => {
    it("main for everyone; a private world only for its owner", async () => {
      const worldId = await busyWorld(1);
      const { worldId: mainId } = await ensureMainWorld(db);
      expect((await resolveConsoleWorld(db, null, undefined))?.id).toBe(mainId);
      expect((await resolveConsoleWorld(db, null, "main"))?.id).toBe(mainId);
      expect((await resolveConsoleWorld(db, other, "main"))?.id).toBe(mainId);
      expect((await resolveConsoleWorld(db, owner, worldId))?.id).toBe(worldId);

      expect(await resolveConsoleWorld(db, null, worldId)).toBeNull();
      expect(await resolveConsoleWorld(db, other, worldId)).toBeNull();
      expect(await resolveConsoleWorld(db, owner, "not-a-uuid")).toBeNull();
      expect(await resolveConsoleWorld(db, owner, mainId)).toBeNull();
      const { worldId: testMain } = await createWorld(db, { name: "Other main", ownerPrincipalId: null, railMode: "sim" });
      expect(await resolveConsoleWorld(db, owner, testMain)).toBeNull();

      await db.update(worlds).set({ status: "archived" }).where(eq(worlds.id, worldId));
      expect(await resolveConsoleWorld(db, owner, worldId)).toBeNull();
    });

    it("the switcher lists main plus only the principal's own active private worlds", async () => {
      const worldId = await busyWorld(1);
      expect(await consoleWorldChoices(db, null)).toEqual([
        { id: "demo", name: "Demo world · simulated money", kind: "demo" },
        { id: "main", name: "Main world (real PayPal sandbox)", kind: "main" },
      ]);
      expect((await consoleWorldChoices(db, other)).map((c) => c.id)).toEqual(["demo", "main"]);
      expect((await consoleWorldChoices(db, owner)).map((c) => c.id)).toEqual(["demo", "main", worldId]);
    });
  });

  describe("snapshot route", () => {
    function get(world: string | null, { principalId, ip = "203.0.113.7" }: { principalId?: string; ip?: string } = {}) {
      const headers: Record<string, string> = { "x-forwarded-for": `${ip}, 10.0.0.1` };
      if (principalId) {
        headers.cookie = `${SESSION_COOKIE_NAME}=${encodeURIComponent(createSession(principalId))}`;
      }
      const url = new URL("https://mandate.test/api/console/snapshot");
      if (world) {
        url.searchParams.set("world", world);
      }
      return new Request(url, { headers });
    }

    it("serves main to anyone and a private world to its owner only, never cached", async () => {
      const worldId = await busyWorld(1);
      const handlers = createConsoleHandlers({ getDb: async () => db });

      const main = await handlers.snapshot(get(null));
      expect(main.status).toBe(200);
      expect(main.headers.get("cache-control")).toBe("no-store");
      expect(((await main.json()) as { snapshot: { world: { kind: string } } }).snapshot.world.kind).toBe("main");

      const mine = await handlers.snapshot(get(worldId, { principalId: owner }));
      expect(mine.status).toBe(200);
      const body = await mine.text();
      expect(body).not.toContain("@");
      expect(body).not.toMatch(PAYER_ID_RE);

      for (const response of [
        await handlers.snapshot(get(worldId)),
        await handlers.snapshot(get(worldId, { principalId: other })),
        await handlers.snapshot(get("junk", { principalId: owner })),
      ]) {
        expect(response.status).toBe(404);
        expect(response.headers.get("cache-control")).toBe("no-store");
      }
    });

    it("rate-limits per IP: 429 with retry-after past the burst; other IPs unaffected; refills", async () => {
      await ensureMainWorld(db);
      let clock = Date.parse("2026-11-07T12:00:00Z");
      const handlers = createConsoleHandlers({ getDb: async () => db, now: () => new Date(clock) });
      for (let i = 0; i < SNAPSHOT_BURST; i += 1) {
        expect((await handlers.snapshot(get(null))).status).toBe(200);
      }
      const limited = await handlers.snapshot(get(null));
      expect(limited.status).toBe(429);
      expect(limited.headers.get("retry-after")).toBe("1");
      expect(limited.headers.get("cache-control")).toBe("no-store");
      expect((await handlers.snapshot(get(null, { ip: "198.51.100.9" }))).status).toBe(200);
      clock += 500;
      expect((await handlers.snapshot(get(null))).status).toBe(200);
      expect((await handlers.snapshot(get(null))).status).toBe(429);
    });
  });
});

describe("console helpers (P6)", () => {
  it("token bucket: burst, refill, cap, bounded keys", () => {
    const bucket = createTokenBucket({ capacity: 3, refillPerSecond: 0.5, maxKeys: 2 });
    const t0 = 1_000_000;
    expect([1, 2, 3].map(() => bucket.take("a", t0).allowed)).toEqual([true, true, true]);
    const denied = bucket.take("a", t0);
    expect(denied).toEqual({ allowed: false, remaining: 0, retryAfterSeconds: 2 });
    expect(bucket.take("a", t0 + 2000).allowed).toBe(true);
    // Long idle refills only up to capacity.
    expect([1, 2, 3, 4].map(() => bucket.take("a", t0 + 3_600_000).allowed)).toEqual([true, true, true, false]);
    bucket.take("b", t0);
    bucket.take("c", t0);
    expect(bucket.size()).toBe(2);
  });

  it("client key: first forwarded hop, then x-real-ip", () => {
    expect(clientKey(new Request("https://x.test", { headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8" } }))).toBe("1.2.3.4");
    expect(clientKey(new Request("https://x.test", { headers: { "x-real-ip": "9.9.9.9" } }))).toBe("9.9.9.9");
    expect(clientKey(new Request("https://x.test"))).toBe("unknown");
  });

  describe("client key on Render (behind Cloudflare)", () => {
    beforeEach(() => vi.stubEnv("RENDER", "true"));
    afterEach(() => vi.unstubAllEnvs());

    // Shapes observed live on Render: Cloudflare overwrites cf-connecting-ip /
    // true-client-ip, but a client-supplied x-forwarded-for value is kept as
    // the first hop ("<spoof>,<client>, <cloudflare edge>").
    it("keys on cf-connecting-ip, ignoring a spoofed first x-forwarded-for hop", () => {
      const headers = { "x-forwarded-for": "1.2.3.4,119.73.124.55, 104.22.232.151", "cf-connecting-ip": "119.73.124.55" };
      expect(clientKey(new Request("https://x.test", { headers }))).toBe("119.73.124.55");
      expect(clientIp(new Request("https://x.test", { headers }))).toBe("119.73.124.55");
    });

    it("falls back to true-client-ip, then unknown — never x-forwarded-for", () => {
      expect(clientKey(new Request("https://x.test", { headers: { "true-client-ip": "8.8.8.8" } }))).toBe("8.8.8.8");
      expect(clientKey(new Request("https://x.test", { headers: { "x-forwarded-for": "1.2.3.4" } }))).toBe("unknown");
      expect(clientIp(new Request("https://x.test", { headers: { "x-forwarded-for": "1.2.3.4" } }))).toBeNull();
    });
  });

  it("client key off Render ignores cf-connecting-ip (a client could send it)", () => {
    const headers = { "x-forwarded-for": "1.2.3.4", "cf-connecting-ip": "6.6.6.6" };
    expect(clientKey(new Request("https://x.test", { headers }))).toBe("1.2.3.4");
    expect(clientIp(new Request("https://x.test", { headers }))).toBe("1.2.3.4");
  });

  it("scrubs emails, truncates PayPal ids, reads amounts without leaking bodies", () => {
    expect(scrubText("Bot a.b@c.io and x@y.z")).toBe("Bot [redacted] and [redacted]");
    expect(truncateId("8RD12345AB678901K2")).toBe("8RD1…K2");
    expect(truncateId("ABCDEF")).toBe("AB…");
    expect(truncateId(null)).toBeNull();
    expect(requestAmountCents({ body: { purchase_units: [{ amount: { currency_code: "USD", value: "121.84" } }] } })).toBe(12184);
    expect(requestAmountCents({ items: [{ amount: { currency: "USD", value: "5" } }] })).toBe(500);
    expect(requestAmountCents({ nothing: true })).toBeNull();
  });
});
