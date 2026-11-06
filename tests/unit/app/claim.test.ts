import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createClaimHandler } from "@/server/auth/claimRoutes";
import { SESSION_COOKIE_NAME, createSession } from "@/server/auth/session";
import type { Db } from "@/server/db/client";
import { agents, principals } from "@/server/db/schema";
import { createTestDb } from "@/server/db/testing";
import { CLAIM_TTL_MS } from "@/server/services/claims";

import { call, type Data } from "../../helpers/world";

const ORIGIN = "https://mandate.test";

async function principal(db: Db, payerId: string): Promise<string> {
  const [row] = await db
    .insert(principals)
    .values({ paypalPayerId: payerId, email: `${payerId}@example.com`, name: payerId, entityType: "individual", verifiedAt: new Date() })
    .returning();
  return row!.id;
}

function claimRequest(token: string, options: { principalId?: string; origin?: string } = {}): Request {
  const headers: Record<string, string> = { origin: options.origin ?? ORIGIN };
  if (options.principalId) {
    headers.cookie = `${SESSION_COOKIE_NAME}=${encodeURIComponent(createSession(options.principalId))}`;
  }
  return new Request(`${ORIGIN}/claim/${token}/accept`, { method: "POST", headers });
}

describe("POST /claim/[token]/accept", () => {
  let db: Db;
  let post: (request: Request, token: string) => Promise<Response>;
  let token: string;
  let agentId: string;

  beforeEach(async () => {
    vi.stubEnv("SESSION_SECRET", "unit-test-session-secret-0123456789abcdef");
    vi.stubEnv("API_KEY_PEPPER", "test-pepper");
    vi.stubEnv("PUBLIC_BASE_URL", ORIGIN);
    db = await createTestDb();
    post = createClaimHandler({ getDb: async () => db });
    const registered = await call(db, "register_agent", "", { name: "Route Agent", payout_email: "r@example.com" });
    const data = registered.envelope.data as Data;
    agentId = data.agent_id as string;
    token = (data.claim_url as string).split("/claim/")[1]!;
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("rejects a cross-origin POST with 403 and claims nothing", async () => {
    const owner = await principal(db, "OWNERA");
    const response = await post(claimRequest(token, { principalId: owner, origin: "https://evil.example" }), token);
    expect(response.status).toBe(403);
    const [row] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(row!.principalId).toBeNull();
  });

  it("without a session, sends the human to Verify with PayPal returning to the claim page", async () => {
    const response = await post(claimRequest(token), token);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${ORIGIN}/verify?return_to=${encodeURIComponent(`/claim/${token}`)}`);
  });

  it("claims for the signed-in principal and returns to the claim page (claimed-by-you)", async () => {
    const owner = await principal(db, "OWNERA");
    const response = await post(claimRequest(token, { principalId: owner }), token);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${ORIGIN}/claim/${token}`);
    const [row] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(row!.principalId).toBe(owner);
  });

  it("an agent already claimed by another principal → 409 page", async () => {
    const owner = await principal(db, "OWNERA");
    const other = await principal(db, "OWNERB");
    await post(claimRequest(token, { principalId: owner }), token);
    const response = await post(claimRequest(token, { principalId: other }), token);
    expect(response.status).toBe(409);
    expect(response.headers.get("content-type")).toContain("text/html");
    const html = await response.text();
    expect(html).toContain("already been claimed");
    expect(html).not.toContain(token);
    const [row] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(row!.principalId).toBe(owner);
  });

  it("an expired token returns to the claim page (which explains it) without claiming", async () => {
    const owner = await principal(db, "OWNERA");
    await db.update(agents).set({ claimExpiresAt: new Date(Date.now() - CLAIM_TTL_MS) }).where(eq(agents.id, agentId));
    const response = await post(claimRequest(token, { principalId: owner }), token);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${ORIGIN}/claim/${token}`);
    const [row] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(row!.principalId).toBeNull();
  });

  it("a malformed token never builds a redirect from attacker input", async () => {
    const owner = await principal(db, "OWNERA");
    const response = await post(claimRequest("x", { principalId: owner }), "//evil.example");
    expect(response.status).toBe(404);
  });
});
