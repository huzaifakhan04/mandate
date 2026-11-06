/**
 * P2 Task 4: owner mandate routes — sign (JSON or form) and revoke.
 * Session + ownership (another principal's agent → 404) + same origin.
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMandateHandlers } from "@/server/auth/mandateRoutes";
import { SESSION_COOKIE_NAME, createSession } from "@/server/auth/session";
import type { Db } from "@/server/db/client";
import { mandates, principals } from "@/server/db/schema";
import { createTestDb } from "@/server/db/testing";
import { hashIp } from "@/server/services/mandates";

import { createSimWorld, createTestAgent } from "../../helpers/world";

const ORIGIN = "https://mandate.test";

const FIELDS = {
  max_per_loan_cents: 20000,
  max_total_owed_cents: 40000,
  max_fee_bps: 800,
  max_term_days: 30,
  eligible_collateral: ["none"],
  typed_name: "Grace Hopper",
  agree: true,
};

describe("/dashboard/agents/[id]/mandate", () => {
  let db: Db;
  let handlers: ReturnType<typeof createMandateHandlers>;
  let agentId: string;
  let ownerId: string;
  let otherId: string;

  beforeEach(async () => {
    vi.stubEnv("SESSION_SECRET", "unit-test-session-secret-0123456789abcdef");
    vi.stubEnv("API_KEY_PEPPER", "test-pepper");
    vi.stubEnv("PUBLIC_BASE_URL", ORIGIN);
    db = await createTestDb();
    handlers = createMandateHandlers({ getDb: async () => db });
    const worldId = await createSimWorld(db);
    const agent = await createTestAgent(db, worldId);
    agentId = agent.agentId;
    ownerId = agent.principalId;
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
    const h: Record<string, string> = { origin: ORIGIN, accept: "application/json", "x-forwarded-for": "198.51.100.7, 10.0.0.1", ...extra };
    if (principalId) {
      h.cookie = `${SESSION_COOKIE_NAME}=${encodeURIComponent(createSession(principalId))}`;
    }
    return h;
  }

  function signJson(body: unknown, principalId: string | null = ownerId, extra: Record<string, string> = {}, id = agentId) {
    return handlers.sign(
      new Request(`${ORIGIN}/dashboard/agents/${id}/mandate`, {
        method: "POST",
        body: JSON.stringify(body),
        headers: headers(principalId, { "content-type": "application/json", ...extra }),
      }),
      id,
    );
  }

  function revoke(principalId: string | null = ownerId, extra: Record<string, string> = {}) {
    return handlers.revoke(
      new Request(`${ORIGIN}/dashboard/agents/${agentId}/mandate/revoke`, { method: "POST", headers: headers(principalId, extra) }),
      agentId,
    );
  }

  async function rows() {
    return (await db.select().from(mandates).where(eq(mandates.agentId, agentId))).sort((a, b) => a.version - b.version);
  }

  it("signs a new version from JSON (201), superseding the previous one", async () => {
    const response = await signJson(FIELDS);
    expect(response.status).toBe(201);
    const body = (await response.json()) as { mandate: Record<string, unknown>; superseded: Record<string, unknown> };
    expect(body.mandate).toMatchObject({
      version: 2,
      status: "signed",
      max_per_loan_cents: 20000,
      max_fee_bps: 800,
      eligible_collateral: ["none"],
      signer_name: "Grace Hopper",
    });
    expect(body.superseded).toMatchObject({ version: 1 });
    const [v1, v2] = await rows();
    expect(v1!.status).toBe("superseded");
    expect(v2!.ipHash).toBe(hashIp("198.51.100.7"));
  });

  it("signs from a browser form (repeated collateral checkboxes) and redirects back to the agent page", async () => {
    const form = new URLSearchParams({
      max_per_loan_cents: "15000",
      max_total_owed_cents: "30000",
      max_fee_bps: "500",
      max_term_days: "14",
      typed_name: "Grace Hopper",
      agree: "on",
    });
    form.append("eligible_collateral", "none");
    form.append("eligible_collateral", "invoice_link");
    const response = await handlers.sign(
      new Request(`${ORIGIN}/dashboard/agents/${agentId}/mandate`, {
        method: "POST",
        body: form,
        headers: headers(ownerId, { accept: "text/html", "content-type": "application/x-www-form-urlencoded" }),
      }),
      agentId,
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${ORIGIN}/dashboard?agent=${agentId}&mandate=signed#agent-drawer`);
    expect((await rows())[1]).toMatchObject({ maxPerLoanCents: 15000n, eligibleCollateral: ["invoice_link", "none"] });
  });

  it("without the checkbox or typed name → 400 with the fields; nothing signed", async () => {
    const response = await signJson({ ...FIELDS, agree: false, typed_name: " " });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_mandate", fields: ["typed_name", "agree"] });
    expect(await rows()).toHaveLength(1);
  });

  it("another principal's agent → 404; no session → 401; cross-origin → 403; malformed id → 404", async () => {
    expect((await signJson(FIELDS, otherId)).status).toBe(404);
    expect((await revoke(otherId)).status).toBe(404);
    expect((await signJson(FIELDS, null)).status).toBe(401);
    expect((await signJson(FIELDS, ownerId, { origin: "https://evil.example" })).status).toBe(403);
    expect((await revoke(ownerId, { origin: "https://evil.example" })).status).toBe(403);
    expect((await signJson(FIELDS, ownerId, {}, "not-a-uuid")).status).toBe(404);
    expect(await rows()).toHaveLength(1);
    expect((await rows())[0]!.status).toBe("signed");
  });

  it("revokes the current mandate; a second revoke → 409 no_mandate", async () => {
    const response = await revoke();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ mandate: { version: 1, status: "revoked" } });
    expect((await revoke()).status).toBe(409);
  });
});
