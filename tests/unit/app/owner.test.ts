/**
 * P2 Task 5: the owner dashboard's mutations — path B registration,
 * freeze / unfreeze, signing-key revoke, API key rotation, "paste claim
 * link", the one-time key reveal, and the mandate form in dollars.
 *
 * Review Focus 3: every agent route is session + ownership + same origin —
 * another principal's agent (or a malformed / unknown id) → 404 with
 * nothing changed; a cross-origin POST → 403 before anything else.
 */
import { and, eq, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTestSessionHandler } from "@/app/api/test/session/route";
import { verifyApiKey } from "@/server/auth/apiKeys";
import { createMandateHandlers } from "@/server/auth/mandateRoutes";
import { claimTokenFromPaste, createOwnerHandlers } from "@/server/auth/ownerRoutes";
import { REVEAL_COOKIE_NAME, openReveal, sealReveal } from "@/server/auth/reveal";
import { SESSION_COOKIE_NAME, createSession, readSession } from "@/server/auth/session";
import type { Db } from "@/server/db/client";
import { agentKeys, agents, apiKeys, events, mandates, principals } from "@/server/db/schema";
import { createTestDb } from "@/server/db/testing";
import { parseOwnerRegisterInput } from "@/server/services/owner";
import { loadAgentKya } from "@/server/services/kya";

import { upgradeToTier2 } from "../../helpers/signing";
import { call, createSimWorld, createTestAgent } from "../../helpers/world";

const ORIGIN = "https://mandate.test";
const EVIL = "https://evil.example.com";

describe("owner dashboard routes (P2 Task 5)", () => {
  let db: Db;
  let handlers: ReturnType<typeof createOwnerHandlers>;
  let worldId: string;
  let agent: Awaited<ReturnType<typeof createTestAgent>>;
  let otherId: string;

  beforeEach(async () => {
    vi.stubEnv("SESSION_SECRET", "unit-test-session-secret-0123456789abcdef");
    vi.stubEnv("API_KEY_PEPPER", "test-pepper");
    vi.stubEnv("PUBLIC_BASE_URL", ORIGIN);
    db = await createTestDb();
    handlers = createOwnerHandlers({ getDb: async () => db });
    worldId = await createSimWorld(db);
    agent = await createTestAgent(db, worldId);
    const [other] = await db
      .insert(principals)
      .values({ paypalPayerId: "OTHER", email: "o@example.com", name: "Other", entityType: "individual", verifiedAt: new Date() })
      .returning();
    otherId = other!.id;
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function headers(principalId: string | null, extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { origin: ORIGIN, accept: "application/json", ...extra };
    if (principalId) {
      h.cookie = `${SESSION_COOKIE_NAME}=${encodeURIComponent(createSession(principalId))}`;
    }
    return h;
  }

  function post(path: string, principalId: string | null, extra: Record<string, string> = {}, body?: BodyInit): Request {
    return new Request(`${ORIGIN}${path}`, { method: "POST", headers: headers(principalId, extra), body });
  }

  function form(fields: Record<string, string>): { body: URLSearchParams; type: Record<string, string> } {
    return { body: new URLSearchParams(fields), type: { "content-type": "application/x-www-form-urlencoded" } };
  }

  async function agentRow(id = agent.agentId) {
    const [row] = await db.select().from(agents).where(eq(agents.id, id));
    return row!;
  }

  type AgentAction = "freeze" | "unfreeze" | "revokeKey" | "rotate";
  const ACTION_PATH: Record<AgentAction, string> = {
    freeze: "freeze",
    unfreeze: "unfreeze",
    revokeKey: "key/revoke",
    rotate: "api-key/rotate",
  };

  function act(action: AgentAction, principalId: string | null, id = agent.agentId, extra: Record<string, string> = {}) {
    return handlers[action](post(`/dashboard/agents/${id}/${ACTION_PATH[action]}`, principalId, extra), id);
  }

  describe("Review Focus 3: ownership, session and origin on every agent action", () => {
    it.each(["freeze", "unfreeze", "revokeKey", "rotate"] as const)(
      "%s: another principal's agent, an unknown id and a malformed id → 404; nothing changes",
      async (action) => {
        await upgradeToTier2(db, agent.agentId, agent.key);
        const before = { agent: await agentRow(), keys: await db.select().from(apiKeys), signing: await db.select().from(agentKeys) };

        expect((await act(action, otherId)).status).toBe(404);
        expect((await act(action, agent.principalId, crypto.randomUUID())).status).toBe(404);
        expect((await act(action, agent.principalId, "not-a-uuid")).status).toBe(404);
        // A browser gets a plain 404 too (not a redirect that would reveal the agent).
        const html = await act(action, otherId, agent.agentId, { accept: "text/html" });
        expect(html.status).toBe(404);

        expect(await agentRow()).toEqual(before.agent);
        expect(await db.select().from(apiKeys)).toEqual(before.keys);
        expect(await db.select().from(agentKeys)).toEqual(before.signing);
      },
    );

    it.each(["freeze", "unfreeze", "revokeKey", "rotate"] as const)("%s: cross-origin → 403 and no session → 401", async (action) => {
      await upgradeToTier2(db, agent.agentId, agent.key);
      const before = await agentRow();
      expect((await act(action, agent.principalId, agent.agentId, { origin: EVIL })).status).toBe(403);
      expect((await act(action, null)).status).toBe(401);
      const signIn = await act(action, null, agent.agentId, { accept: "text/html" });
      expect(signIn.status).toBe(303);
      expect(signIn.headers.get("location")).toBe(
        `${ORIGIN}/verify?return_to=${encodeURIComponent(`/dashboard?agent=${agent.agentId}`)}`,
      );
      expect(await agentRow()).toEqual(before);
      // A forged session cookie is no session.
      const forged = await handlers[action](
        new Request(`${ORIGIN}/dashboard/agents/${agent.agentId}/x`, {
          method: "POST",
          headers: { origin: ORIGIN, accept: "application/json", cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(`${createSession(otherId).split(".")[0]}.AAAA`)}` },
        }),
        agent.agentId,
      );
      expect(forged.status).toBe(401);
    });

    it("register and paste-claim: cross-origin → 403, no session → 401", async () => {
      const reg = form({ name: "X", operator: "o", model: "m", payout: "x@example.com" });
      expect((await handlers.register(post("/dashboard/agents", agent.principalId, { origin: EVIL, ...reg.type }, reg.body))).status).toBe(403);
      expect((await handlers.register(post("/dashboard/agents", null, reg.type, form({ name: "Xy" }).body))).status).toBe(401);
      const paste = form({ claim_link: `${ORIGIN}/claim/${"A".repeat(43)}` });
      expect((await handlers.pasteClaim(post("/dashboard/claim", agent.principalId, { origin: EVIL, ...paste.type }, paste.body))).status).toBe(403);
      expect((await handlers.pasteClaim(post("/dashboard/claim", null, paste.type, paste.body))).status).toBe(401);
    });

    it("the mandate routes: another principal → 404 (dollar form fields too)", async () => {
      const mandateHandlers = createMandateHandlers({ getDb: async () => db });
      const fields = form({
        max_per_loan_usd: "250",
        max_total_owed_usd: "500",
        max_fee_pct: "5",
        max_term_days: "30",
        eligible_collateral: "none",
        typed_name: "Mallory",
        agree: "on",
      });
      const res = await mandateHandlers.sign(
        post(`/dashboard/agents/${agent.agentId}/mandate`, otherId, fields.type, fields.body),
        agent.agentId,
      );
      expect(res.status).toBe(404);
      expect(await db.select().from(mandates).where(eq(mandates.principalId, otherId))).toEqual([]);
    });
  });

  describe("path B: register an agent", () => {
    it("parses the form: payout is an email or a 13-char PayPal id", () => {
      expect(parseOwnerRegisterInput({ name: "Nova", operator: "Studio", model: "Claude", payout: "n@example.com" })).toEqual({
        ok: true,
        input: { name: "Nova", operator: "Studio", model: "Claude", payoutEmail: "n@example.com" },
      });
      expect(parseOwnerRegisterInput({ name: "Nova", operator: "S", model: "C", payout: "abcdefghj2345" })).toMatchObject({
        ok: true,
        input: { payoutPaypalId: "ABCDEFGHJ2345" },
      });
      expect(parseOwnerRegisterInput({ name: "N", operator: "", model: "C", payout: "nope" })).toEqual({
        ok: false,
        errors: ["name", "operator", "payout"],
      });
    });

    it("creates an active agent already claimed by the principal, at T0 until a mandate; its key works", async () => {
      const res = await handlers.register(
        post("/dashboard/agents", otherId, { "content-type": "application/json" }, JSON.stringify({
          name: "Nova",
          operator: "Studio LLC",
          model: "Claude",
          payout: "nova@example.com",
        })),
      );
      expect(res.status).toBe(201);
      const body = (await res.json()) as { agent_id: string; api_key: string };
      const row = await agentRow(body.agent_id);
      expect(row).toMatchObject({
        principalId: otherId,
        status: "active",
        claimTokenHash: null,
        claimTokenSeed: null,
        payoutReceiver: "nova@example.com",
      });
      expect(row.claimedAt).not.toBeNull();
      const { tier } = await loadAgentKya(db, row.worldId, row.id);
      expect(tier).toMatchObject({ tier: 0, claimed: true, borrowBlockers: ["mandate_missing"] });
      expect(await verifyApiKey(db, body.api_key)).toMatchObject({ agentId: row.id, status: "active" });
      const [event] = await db.select().from(events).where(eq(events.aggregateId, row.id));
      expect(event).toMatchObject({ type: "agent.registered_by_owner", aggregateType: "agent" });
    });

    it("a browser form 303s to the one-time key page carrying the key only in a sealed cookie", async () => {
      const reg = form({ name: "Nova", operator: "Studio", model: "Claude", payout: "nova@example.com" });
      const res = await handlers.register(post("/dashboard/agents", otherId, { accept: "text/html", ...reg.type }, reg.body));
      expect(res.status).toBe(303);
      const location = new URL(res.headers.get("location")!);
      const agentId = location.pathname.split("/")[3]!;
      expect(location.pathname).toBe(`/dashboard/agents/${agentId}/api-key`);
      expect(location.search).toBe("");
      const cookie = res.headers.getSetCookie().find((c) => c.startsWith(`${REVEAL_COOKIE_NAME}=`))!;
      expect(cookie).toMatch(/HttpOnly/);
      expect(cookie).toMatch(/SameSite=Strict/);
      expect(cookie).toMatch(/Path=\/dashboard\/agents/);
      expect(cookie).not.toMatch(/mnd_/);
      const sealed = cookie.slice(REVEAL_COOKIE_NAME.length + 1).split(";")[0]!;
      const reveal = openReveal(sealed, { principalId: otherId, agentId });
      expect(reveal).toMatchObject({ kind: "registered", agentId });
      expect(await verifyApiKey(db, reveal!.apiKey)).toMatchObject({ agentId });
    });

    it("an invalid form 303s back with the bad fields (and never the payout)", async () => {
      const reg = form({ name: "N", operator: "Ops", model: "M", payout: "secret-but-bad" });
      const res = await handlers.register(post("/dashboard/agents", otherId, { accept: "text/html", ...reg.type }, reg.body));
      expect(res.status).toBe(303);
      const location = new URL(res.headers.get("location")!);
      expect(location.pathname).toBe("/dashboard/agents/new");
      expect(location.searchParams.get("fields")).toBe("name,payout");
      expect(location.searchParams.get("operator")).toBe("Ops");
      expect(location.search).not.toContain("secret");
    });
  });

  describe("the sealed reveal cookie", () => {
    it("opens only for its principal and agent, untampered and unexpired", () => {
      const now = new Date("2026-11-06T12:00:00Z");
      const sealed = sealReveal({ principalId: otherId, agentId: agent.agentId, apiKey: "mnd_x", kind: "rotated" }, now);
      expect(openReveal(sealed, { principalId: otherId, agentId: agent.agentId }, now)).toMatchObject({ apiKey: "mnd_x" });
      expect(openReveal(sealed, { principalId: agent.principalId, agentId: agent.agentId }, now)).toBeNull();
      expect(openReveal(sealed, { principalId: otherId, agentId: crypto.randomUUID() }, now)).toBeNull();
      expect(openReveal(sealed, { principalId: otherId, agentId: agent.agentId }, new Date(now.getTime() + 11 * 60_000))).toBeNull();
      const flipped = sealed[20] === "A" ? "B" : "A";
      expect(openReveal(sealed.slice(0, 20) + flipped + sealed.slice(21), { principalId: otherId, agentId: agent.agentId }, now)).toBeNull();
      expect(openReveal("garbage", { principalId: otherId, agentId: agent.agentId }, now)).toBeNull();
    });
  });

  describe("freeze / unfreeze", () => {
    it("frozen → the agent's mutating tools get AGENT_NOT_ACTIVE; unfreeze restores it", async () => {
      const frozen = await act("freeze", agent.principalId, agent.agentId, { accept: "text/html" });
      expect(frozen.status).toBe(303);
      expect(frozen.headers.get("location")).toBe(`${ORIGIN}/dashboard?agent=${agent.agentId}&agent_status=frozen#agent-drawer`);
      expect((await agentRow()).status).toBe("frozen");
      const refused = await call(db, "apply_for_loan", agent.key, { amount_cents: 10000, term_days: 7, purpose: "Working capital" });
      expect(refused.envelope.status).toBe("AGENT_NOT_ACTIVE");
      // Reads still work.
      expect((await call(db, "get_status", agent.key, {})).envelope.status).not.toBe("AGENT_NOT_ACTIVE");

      expect((await act("freeze", agent.principalId)).status).toBe(409);
      expect((await act("unfreeze", agent.principalId)).status).toBe(200);
      expect((await agentRow()).status).toBe("active");
      expect((await act("unfreeze", agent.principalId)).status).toBe(409);
      const types = (await db.select().from(events).where(eq(events.aggregateId, agent.agentId))).map((e) => e.type);
      expect(types).toEqual(expect.arrayContaining(["agent.frozen", "agent.unfrozen"]));
    });
  });

  describe("revoke signing key", () => {
    it("drops a T2 agent to T1; unsigned calls are accepted again; a second revoke → 409", async () => {
      await upgradeToTier2(db, agent.agentId, agent.key);
      expect((await loadAgentKya(db, worldId, agent.agentId)).tier.tier).toBe(2);
      expect((await act("revokeKey", agent.principalId)).status).toBe(200);
      expect((await loadAgentKya(db, worldId, agent.agentId)).tier.tier).toBe(1);
      expect(await db.select().from(agentKeys).where(and(eq(agentKeys.agentId, agent.agentId), isNull(agentKeys.revokedAt)))).toEqual([]);
      expect((await act("revokeKey", agent.principalId)).status).toBe(409);
      // The old key's signature no longer matters; the agent may register a new one.
      const unsigned = await call(db, "redeem_notes", agent.key, { amount_cents: 1000 });
      expect(unsigned.envelope.status).not.toMatch(/^SIGNATURE_/);
    });
  });

  describe("rotate API key", () => {
    it("issues a new key (shown once via the reveal) and revokes the old one", async () => {
      const res = await act("rotate", agent.principalId);
      expect(res.status).toBe(200);
      const { api_key: fresh } = (await res.json()) as { api_key: string };
      expect(await verifyApiKey(db, agent.key)).toBeNull();
      expect(await verifyApiKey(db, fresh)).toMatchObject({ agentId: agent.agentId });
      const active = await db.select().from(apiKeys).where(and(eq(apiKeys.agentId, agent.agentId), isNull(apiKeys.revokedAt)));
      expect(active).toHaveLength(1);

      const html = await act("rotate", agent.principalId, agent.agentId, { accept: "text/html" });
      expect(html.status).toBe(303);
      expect(html.headers.get("location")).toBe(`${ORIGIN}/dashboard/agents/${agent.agentId}/api-key`);
      expect(html.headers.getSetCookie().some((c) => c.startsWith(`${REVEAL_COOKIE_NAME}=`))).toBe(true);
    });
  });

  describe("paste claim link", () => {
    const token = "abcDEF0123456789_-abcDEF0123456789_-abcDEF0";

    it("accepts the full link, a bare token or a link with a trailing query; rejects anything else", () => {
      expect(token).toHaveLength(43);
      expect(claimTokenFromPaste(`https://mandate.bank/claim/${token}`)).toBe(token);
      expect(claimTokenFromPaste(`  ${token} `)).toBe(token);
      expect(claimTokenFromPaste(`http://localhost:3000/claim/${token}/?x=1`)).toBe(token);
      expect(claimTokenFromPaste("https://mandate.bank/claim/short")).toBeNull();
      expect(claimTokenFromPaste(`https://mandate.bank/claim/${token}x`)).toBeNull();
      expect(claimTokenFromPaste(42)).toBeNull();
    });

    it("303s to /claim/<token>, or back to the dashboard with an error", async () => {
      const good = form({ claim_link: `${ORIGIN}/claim/${token}` });
      const ok = await handlers.pasteClaim(post("/dashboard/claim", otherId, { accept: "text/html", ...good.type }, good.body));
      expect(ok.status).toBe(303);
      expect(ok.headers.get("location")).toBe(`${ORIGIN}/claim/${token}`);
      const bad = form({ claim_link: "https://elsewhere.example/x" });
      const no = await handlers.pasteClaim(post("/dashboard/claim", otherId, { accept: "text/html", ...bad.type }, bad.body));
      expect(no.headers.get("location")).toBe(`${ORIGIN}/dashboard?claim_error=invalid`);
    });
  });

  describe("mandate form in dollars and percent", () => {
    it("signs with max_per_loan_usd / max_total_owed_usd / max_fee_pct converted to cents and bps", async () => {
      const mandateHandlers = createMandateHandlers({ getDb: async () => db });
      const fields = form({
        max_per_loan_usd: "$250.50",
        max_total_owed_usd: "1,000",
        max_fee_pct: "2.5",
        max_term_days: "30",
        typed_name: "Ada Owner",
        agree: "on",
      });
      fields.body.append("eligible_collateral", "invoice_link");
      const res = await mandateHandlers.sign(
        post(`/dashboard/agents/${agent.agentId}/mandate`, agent.principalId, { accept: "text/html", ...fields.type }, fields.body),
        agent.agentId,
      );
      expect(res.status).toBe(303);
      const [current] = await db
        .select()
        .from(mandates)
        .where(and(eq(mandates.agentId, agent.agentId), eq(mandates.status, "signed")));
      expect(current).toMatchObject({ maxPerLoanCents: 25050n, maxTotalOwedCents: 100000n, maxFeeBps: 250 });
    });

    it("a malformed dollar amount fails that field", async () => {
      const mandateHandlers = createMandateHandlers({ getDb: async () => db });
      const fields = form({
        max_per_loan_usd: "12.345",
        max_total_owed_usd: "500",
        max_fee_pct: "five",
        max_term_days: "30",
        eligible_collateral: "none",
        typed_name: "Ada Owner",
        agree: "on",
      });
      const res = await mandateHandlers.sign(
        post(`/dashboard/agents/${agent.agentId}/mandate`, agent.principalId, { accept: "text/html", ...fields.type }, fields.body),
        agent.agentId,
      );
      const location = new URL(res.headers.get("location")!);
      expect(location.searchParams.get("mandate_error")).toBe("invalid_mandate");
      expect(location.searchParams.get("fields")).toBe("max_per_loan_cents,max_fee_bps");
    });
  });
});

describe("test-only POST /api/test/session", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("404s unless MANDATE_TEST_ENDPOINTS=1 outside production", async () => {
    const getDb = vi.fn(createTestDb);
    vi.stubEnv("MANDATE_TEST_ENDPOINTS", "");
    expect((await createTestSessionHandler({ getDb }).POST(new Request("http://localhost/api/test/session", { method: "POST" }))).status).toBe(404);
    vi.stubEnv("MANDATE_TEST_ENDPOINTS", "1");
    vi.stubEnv("NODE_ENV", "production");
    expect((await createTestSessionHandler({ getDb }).POST(new Request("http://localhost/api/test/session", { method: "POST" }))).status).toBe(404);
    expect(getDb).not.toHaveBeenCalled();
  });

  it("signs in a fresh verified principal and redirects to a sanitized return_to", async () => {
    vi.stubEnv("MANDATE_TEST_ENDPOINTS", "1");
    vi.stubEnv("SESSION_SECRET", "unit-test-session-secret-0123456789abcdef");
    const db = await createTestDb();
    const res = await createTestSessionHandler({ getDb: async () => db }).POST(
      new Request("http://localhost/api/test/session", {
        method: "POST",
        body: new URLSearchParams({ name: "Ada", return_to: "//evil.example.com" }),
        headers: { "content-type": "application/x-www-form-urlencoded" },
      }),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("http://localhost/dashboard");
    const cookie = res.headers.get("set-cookie")!;
    const session = readSession(decodeURIComponent(cookie.split(";")[0]!.split("=").slice(1).join("=")));
    const [principal] = await db.select().from(principals).where(eq(principals.id, session!.principalId));
    expect(principal).toMatchObject({ name: "Ada" });
    expect(principal!.verifiedAt).not.toBeNull();
  });
});
