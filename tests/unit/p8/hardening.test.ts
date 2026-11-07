/**
 * P8 hardening: Postgres-backed rate limits (tools, verify/start, console,
 * dashboard), the streaming body-size cap (chunked bodies with no
 * Content-Length), and read-only API keys (FORBIDDEN_SCOPE).
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createRestHandler } from "@/app/api/v1/[tool]/route";
import { verifyApiKey } from "@/server/auth/apiKeys";
import { createConsoleHandlers, CONSOLE_DB_CAP_PER_HOUR } from "@/server/auth/consoleRoutes";
import { createDocumentHandlers } from "@/server/auth/documentRoutes";
import { createMandateHandlers } from "@/server/auth/mandateRoutes";
import { createOwnerHandlers, DASHBOARD_MUTATIONS_PER_HOUR, MAX_BODY_BYTES } from "@/server/auth/ownerRoutes";
import { createVerifyStartHandler, VERIFY_START_PER_IP_PER_HOUR } from "@/server/auth/routes";
import { SESSION_COOKIE_NAME, createSession } from "@/server/auth/session";
import { TOOL_RATE_LIMITS } from "@/server/contracts/rateLimits";
import { findTool, registry } from "@/server/contracts/registry";
import { runTool } from "@/server/contracts/runTool";
import { knownStatusTable } from "@/server/contracts/envelope";
import { renderAgentsMd } from "@/server/contracts/docs";
import type { Db } from "@/server/db/client";
import { agents, apiKeys, rateLimits } from "@/server/db/schema";
import { createTestDb } from "@/server/db/testing";
import { bufferRequestCapped, readBodyCapped } from "@/server/http/body";
import { HOUR_MS, pruneRateLimits, takeDbRateLimits, windowStart } from "@/server/http/dbRateLimit";
import { bumpRateLimit } from "@/server/http/dbRateLimit";
import { createTokenBucket } from "@/server/http/rateLimit";

import { call, createSimWorld, createTestAgent, type Data } from "../../helpers/world";

const ORIGIN = "https://mandate.test";

/** A chunked body: a stream with no Content-Length header. */
function chunkedStream(totalBytes: number, chunk = 4096): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= totalBytes) {
        controller.close();
        return;
      }
      const size = Math.min(chunk, totalBytes - sent);
      controller.enqueue(new Uint8Array(size).fill(97));
      sent += size;
    },
  });
}

function chunkedRequest(url: string, totalBytes: number, headers: Record<string, string>): Request {
  return new Request(url, {
    method: "POST",
    headers,
    body: chunkedStream(totalBytes),
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

describe("P8 hardening", () => {
  let db: Db;

  beforeEach(async () => {
    vi.stubEnv("SESSION_SECRET", "unit-test-session-secret-0123456789abcdef");
    vi.stubEnv("API_KEY_PEPPER", "test-pepper");
    vi.stubEnv("PUBLIC_BASE_URL", ORIGIN);
    vi.stubEnv("RATE_LIMITS_DISABLED", "");
    db = await createTestDb();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  describe("Postgres-backed fixed windows", () => {
    it("counts hits per bucket and window, refuses over the limit with the time to the window's end", async () => {
      const now = new Date("2026-11-08T10:15:00Z");
      const limits = [{ key: "t:a", limit: 2, windowMs: HOUR_MS }];
      expect((await takeDbRateLimits(db, limits, now)).allowed).toBe(true);
      expect((await takeDbRateLimits(db, limits, now)).allowed).toBe(true);
      const third = await takeDbRateLimits(db, limits, now);
      expect(third).toMatchObject({ allowed: false, key: "t:a", retryAfterSeconds: 45 * 60 });
      // Another bucket and the next window are untouched.
      expect((await takeDbRateLimits(db, [{ key: "t:b", limit: 2, windowMs: HOUR_MS }], now)).allowed).toBe(true);
      expect((await takeDbRateLimits(db, limits, new Date("2026-11-08T11:00:00Z"))).allowed).toBe(true);
      const [row] = await db.select().from(rateLimits).where(eq(rateLimits.bucketKey, "t:a")).orderBy(rateLimits.windowStart);
      expect(row).toMatchObject({ count: 3, windowStart: windowStart(now, HOUR_MS) });
    });

    it("every limit in a call is counted; the longest wait wins", async () => {
      const now = new Date("2026-11-08T10:59:00Z");
      const result = await takeDbRateLimits(
        db,
        [
          { key: "t:hour", limit: 0, windowMs: HOUR_MS },
          { key: "t:day", limit: 0, windowMs: 24 * HOUR_MS },
        ],
        now,
      );
      expect(result.allowed).toBe(false);
      expect(result.retryAfterSeconds).toBe(13 * 3600 + 60);
      expect(await db.select().from(rateLimits)).toHaveLength(2);
    });

    it("fails open (logged) on a database error, and RATE_LIMITS_DISABLED turns it off", async () => {
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      const broken = { insert: () => { throw new Error("db down"); } } as unknown as Db;
      expect((await takeDbRateLimits(broken, [{ key: "x", limit: 0, windowMs: HOUR_MS }])).allowed).toBe(true);
      expect(errors).toHaveBeenCalledWith(expect.stringContaining("[rate-limit] failing open"));
      vi.stubEnv("RATE_LIMITS_DISABLED", "1");
      expect((await takeDbRateLimits(db, [{ key: "x", limit: 0, windowMs: HOUR_MS }])).allowed).toBe(true);
      expect(await db.select().from(rateLimits)).toHaveLength(0);
    });

    it("prunes old windows", async () => {
      await bumpRateLimit(db, "old", HOUR_MS, new Date("2026-11-01T00:00:00Z"));
      await bumpRateLimit(db, "new", HOUR_MS, new Date("2026-11-08T00:00:00Z"));
      await pruneRateLimits(db, new Date("2026-11-06T00:00:00Z"));
      expect((await db.select().from(rateLimits)).map((r) => r.bucketKey)).toEqual(["new"]);
    });
  });

  describe("tool rate limits", () => {
    const params = (tool: string) => ({ params: Promise.resolve({ tool }) });

    function register(ip: string, name: string) {
      const { POST } = createRestHandler({ getDb: async () => db });
      return POST(
        new Request(`${ORIGIN}/api/v1/register_agent`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-forwarded-for": `${ip}, 10.0.0.1` },
          body: JSON.stringify({ name, payout_email: "agent@example.com" }),
        }),
        params("register_agent"),
      );
    }

    it("register_agent: 3 per IP + name and 10 per IP per hour → 429 RATE_LIMITED with retry_after_seconds and get_status", async () => {
      for (let i = 0; i < TOOL_RATE_LIMITS.register_agent.perIpAndNamePerHour; i += 1) {
        expect((await register("203.0.113.9", "Same Name")).status).toBe(200);
      }
      const limited = await register("203.0.113.9", "same name ");
      expect(limited.status).toBe(429);
      const body = (await limited.json()) as { status: string; data: Data; next_actions: Array<{ tool: string }>; reason_codes: string[] };
      expect(body.status).toBe("RATE_LIMITED");
      expect(body.reason_codes).toEqual(["rate_limited"]);
      expect(body.data.retry_after_seconds).toEqual(expect.any(Number));
      expect(body.data.retry_after_seconds as number).toBeGreaterThan(0);
      expect(body.data.retry_after_seconds as number).toBeLessThanOrEqual(3600);
      expect(body.next_actions).toEqual([{ tool: "get_status", args: {} }]);

      // Other names from the same IP: the per-IP cap (10) — the refused call above counted too.
      let ok = 0;
      for (let i = 0; i < 8; i += 1) {
        if ((await register("203.0.113.9", `Agent ${i}`)).status === 200) {
          ok += 1;
        }
      }
      expect(ok).toBe(TOOL_RATE_LIMITS.register_agent.perIpPerHour - 4);
      // Another IP is unaffected; the refused calls created no agents.
      expect((await register("198.51.100.4", "Same Name")).status).toBe(200);
      expect(await db.select().from(agents)).toHaveLength(3 + ok + 1);
    });

    it("apply_for_loan: 30 per sim day and 60 per hour per agent; buy_notes / repay_loan 30 per hour", async () => {
      const worldId = await createSimWorld(db);
      const agent = await createTestAgent(db, worldId);
      const otherAgent = await createTestAgent(db, worldId, "other@example.com");
      const now = new Date();
      // Pre-fill the windows to their caps, then one more call is refused before the handler runs.
      await db.insert(rateLimits).values({ bucketKey: `checkout:buy_notes:${agent.agentId}`, windowStart: windowStart(now, HOUR_MS), count: 30 });
      const buy = await call(db, "buy_notes", agent.key, { amount_cents: 1000 });
      expect(buy.httpStatus).toBe(429);
      expect(buy.envelope.status).toBe("RATE_LIMITED");
      expect((await call(db, "buy_notes", otherAgent.key, { amount_cents: 1000 })).envelope.status).toBe("AWAITING_APPROVAL");

      await db.insert(rateLimits).values({ bucketKey: `checkout:repay_loan:${agent.agentId}`, windowStart: windowStart(now, HOUR_MS), count: 30 });
      expect((await call(db, "repay_loan", agent.key, { loan_id: "00000000-0000-4000-8000-000000000000" })).envelope.status).toBe(
        "RATE_LIMITED",
      );

      await db.insert(rateLimits).values({ bucketKey: `apply:hour:${agent.agentId}`, windowStart: windowStart(now, HOUR_MS), count: 60 });
      expect((await call(db, "apply_for_loan", agent.key, { amount_cents: 1000, term_days: 7, purpose: "working capital" })).envelope.status).toBe("RATE_LIMITED");
      // The per-sim-day window keys on the world's clock (frozen at creation here).
      const fresh = await createTestAgent(db, worldId, "fresh@example.com");
      const { getSimNow } = await import("@/server/clock/clock");
      const simNow = await getSimNow(db, worldId);
      await db.insert(rateLimits).values({ bucketKey: `apply:simday:${fresh.agentId}`, windowStart: windowStart(simNow, 86_400_000), count: 30 });
      const applied = await call(db, "apply_for_loan", fresh.key, { amount_cents: 1000, term_days: 7, purpose: "working capital" });
      expect(applied.envelope.status).toBe("RATE_LIMITED");
      // A rate-limited call is never stored under its idempotency key.
      const replay = await call(db, "apply_for_loan", fresh.key, { amount_cents: 1000, term_days: 7, purpose: "working capital" }, "idem-1");
      expect(replay.envelope.status).toBe("RATE_LIMITED");
    });

    it("server-internal bot calls skip the limits", async () => {
      const worldId = await createSimWorld(db);
      const agent = await createTestAgent(db, worldId);
      await db.update(agents).set({ isBot: true }).where(eq(agents.id, agent.agentId));
      await db.insert(rateLimits).values({ bucketKey: `checkout:buy_notes:${agent.agentId}`, windowStart: windowStart(new Date(), HOUR_MS), count: 99 });
      const result = await runTool(findTool("buy_notes"), "buy_notes", { amount_cents: 1000 }, { getDb: async () => db, actingBotId: agent.agentId });
      expect(result.envelope.status).toBe("AWAITING_APPROVAL");
    });

    it("RATE_LIMITED, FORBIDDEN_SCOPE and DEMO_WORLD_READ_ONLY are in the agents.md error table", () => {
      expect(knownStatusTable()).toEqual(
        expect.arrayContaining([
          { status: "RATE_LIMITED", http: 429 },
          { status: "FORBIDDEN_SCOPE", http: 403 },
          { status: "DEMO_WORLD_READ_ONLY", http: 403 },
        ]),
      );
      const md = renderAgentsMd(registry, "https://mandate.test", knownStatusTable());
      expect(md).toContain("| `RATE_LIMITED` | 429 |");
      expect(md).toContain("data.retry_after_seconds");
      expect(md).toContain("| `FORBIDDEN_SCOPE` | 403 |");
    });
  });

  describe("verify/start, console and dashboard limits", () => {
    it("POST /verify/start: 10 per IP per hour (each would create a real PayPal order)", async () => {
      const start = createVerifyStartHandler({ getDb: async () => db });
      await db.insert(rateLimits).values({
        bucketKey: "verify_start:ip:192.0.2.1",
        windowStart: windowStart(new Date(), HOUR_MS),
        count: VERIFY_START_PER_IP_PER_HOUR,
      });
      const req = (accept: string) =>
        new Request(`${ORIGIN}/verify/start`, {
          method: "POST",
          headers: { origin: ORIGIN, accept, "x-forwarded-for": "192.0.2.1", "content-type": "application/x-www-form-urlencoded" },
          body: "return_to=%2Fdashboard",
        });
      const browser = await start(req("text/html"));
      expect(browser.status).toBe(303);
      expect(browser.headers.get("location")).toBe(`${ORIGIN}/verify/error?reason=rate_limited`);
      const api = await start(req("application/json"));
      expect(api.status).toBe(429);
      expect(api.headers.get("retry-after")).toMatch(/^\d+$/);
    });

    it("console snapshot: the in-memory bucket stays, plus a DB cap of 2000/hour per IP", async () => {
      const handlers = createConsoleHandlers({
        getDb: async () => db,
        limiter: createTokenBucket({ capacity: 1000, refillPerSecond: 1000 }),
      });
      const get = () => handlers.snapshot(new Request(`${ORIGIN}/api/console/snapshot`, { headers: { "x-forwarded-for": "192.0.2.50" } }));
      expect((await get()).status).toBe(200);
      await db
        .update(rateLimits)
        .set({ count: CONSOLE_DB_CAP_PER_HOUR })
        .where(eq(rateLimits.bucketKey, "console:snapshot:ip:192.0.2.50"));
      const limited = await get();
      expect(limited.status).toBe(429);
      expect(limited.headers.get("retry-after")).toMatch(/^\d+$/);
      expect(((await limited.json()) as { error: string }).error).toBe("rate_limited");
    });

    it("dashboard mutations: 120 per principal per hour", async () => {
      const worldId = await createSimWorld(db);
      const agent = await createTestAgent(db, worldId);
      const owner = createOwnerHandlers({ getDb: async () => db });
      await db.insert(rateLimits).values({
        bucketKey: `dashboard:principal:${agent.principalId}`,
        windowStart: windowStart(new Date(), HOUR_MS),
        count: DASHBOARD_MUTATIONS_PER_HOUR,
      });
      const res = await owner.freeze(
        new Request(`${ORIGIN}/dashboard/agents/${agent.agentId}/freeze`, {
          method: "POST",
          headers: { origin: ORIGIN, accept: "application/json", cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(createSession(agent.principalId))}` },
        }),
        agent.agentId,
      );
      expect(res.status).toBe(429);
      const [row] = await db.select().from(agents).where(eq(agents.id, agent.agentId));
      expect(row!.status).toBe("active");
    });
  });

  describe("streaming body cap (no Content-Length)", () => {
    it("readBodyCapped stops reading at the cap; a body within it is returned whole", async () => {
      const big = chunkedRequest(`${ORIGIN}/x`, 64 * 1024, {});
      expect(big.headers.get("content-length")).toBeNull();
      expect(await readBodyCapped(big, 16 * 1024)).toBeNull();
      const small = await bufferRequestCapped(chunkedRequest(`${ORIGIN}/x`, 1000, { "content-type": "text/plain" }), 16 * 1024);
      expect((await small!.text()).length).toBe(1000);
      expect(small!.headers.get("content-type")).toBe("text/plain");
    });

    it("owner, mandate and upload routes answer 413 to a chunked body over the cap", async () => {
      const worldId = await createSimWorld(db);
      const agent = await createTestAgent(db, worldId);
      const session = { origin: ORIGIN, accept: "application/json", cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(createSession(agent.principalId))}` };
      const form = { ...session, "content-type": "application/x-www-form-urlencoded" };

      const owner = createOwnerHandlers({ getDb: async () => db });
      const rotate = await owner.rotate(chunkedRequest(`${ORIGIN}/dashboard/agents/${agent.agentId}/api-key/rotate`, MAX_BODY_BYTES + 1, form), agent.agentId);
      expect(rotate.status).toBe(413);
      const registered = await owner.register(chunkedRequest(`${ORIGIN}/dashboard/agents`, 1_000_000, form));
      expect(registered.status).toBe(413);

      const mandates = createMandateHandlers({ getDb: async () => db });
      const signed = await mandates.sign(chunkedRequest(`${ORIGIN}/dashboard/agents/${agent.agentId}/mandate`, 100_000, form), agent.agentId);
      expect(signed.status).toBe(413);

      const documents = createDocumentHandlers({ getDb: async () => db });
      const uploaded = await documents.upload(
        chunkedRequest(`${ORIGIN}/dashboard/agents/${agent.agentId}/documents`, 3 * 1024 * 1024, {
          ...session,
          "content-type": "multipart/form-data; boundary=x",
        }),
        agent.agentId,
      );
      expect(uploaded.status).toBe(413);

      // A chunked body within the cap still works end to end.
      const ok = await owner.pasteClaim(
        new Request(`${ORIGIN}/dashboard/claim`, {
          method: "POST",
          headers: form,
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(`claim_link=${"a".repeat(43)}`));
              controller.close();
            },
          }),
          duplex: "half",
        } as RequestInit & { duplex: "half" }),
      );
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ location: `/claim/${"a".repeat(43)}` });
    });
  });

  describe("read-only API keys", () => {
    it("a read-only key calls read-only tools; anything else is 403 FORBIDDEN_SCOPE", async () => {
      const worldId = await createSimWorld(db);
      const agent = await createTestAgent(db, worldId);
      await db.update(apiKeys).set({ scope: "read_only" }).where(eq(apiKeys.agentId, agent.agentId));
      expect((await verifyApiKey(db, agent.key))?.scope).toBe("read_only");
      const status = await call(db, "get_status", agent.key, {});
      expect(status.httpStatus).toBe(200);
      const buy = await call(db, "buy_notes", agent.key, { amount_cents: 1000 });
      expect(buy.httpStatus).toBe(403);
      expect(buy.envelope).toMatchObject({ status: "FORBIDDEN_SCOPE", reason_codes: ["read_only_key"] });
    });

    it("the dashboard rotates to (and registers with) a read-only key", async () => {
      const worldId = await createSimWorld(db);
      const agent = await createTestAgent(db, worldId);
      const owner = createOwnerHandlers({ getDb: async () => db });
      const headers = {
        origin: ORIGIN,
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
        cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(createSession(agent.principalId))}`,
      };
      const rotated = await owner.rotate(
        new Request(`${ORIGIN}/dashboard/agents/${agent.agentId}/api-key/rotate`, { method: "POST", headers, body: "read_only=on" }),
        agent.agentId,
      );
      expect(rotated.status).toBe(200);
      const { api_key: readOnlyKey } = (await rotated.json()) as { api_key: string };
      expect((await verifyApiKey(db, readOnlyKey))?.scope).toBe("read_only");
      expect((await call(db, "buy_notes", readOnlyKey, { amount_cents: 1000 })).envelope.status).toBe("FORBIDDEN_SCOPE");
      // Without the box: a full key again.
      const full = await owner.rotate(
        new Request(`${ORIGIN}/dashboard/agents/${agent.agentId}/api-key/rotate`, { method: "POST", headers, body: "" }),
        agent.agentId,
      );
      const { api_key: fullKey } = (await full.json()) as { api_key: string };
      expect((await verifyApiKey(db, fullKey))?.scope).toBe("full");

      const registered = await owner.register(
        new Request(`${ORIGIN}/dashboard/agents`, {
          method: "POST",
          headers,
          body: new URLSearchParams({ name: "Watcher", operator: "Ops", model: "m", payout: "w@example.com", read_only: "on" }),
        }),
      );
      expect(registered.status).toBe(201);
      const { api_key: watcherKey } = (await registered.json()) as { api_key: string };
      expect((await verifyApiKey(db, watcherKey))?.scope).toBe("read_only");
    });
  });
});
