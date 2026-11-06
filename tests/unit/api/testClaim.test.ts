import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createTestClaimHandler } from "@/app/api/test/claim/route";
import { mandates } from "@/server/db/schema";
import { createTestDb } from "@/server/db/testing";

import { call, type Data } from "../../helpers/world";

function post(body: unknown): Request {
  return new Request("http://localhost/api/test/claim", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("test-only POST /api/test/claim", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("404s unless MANDATE_TEST_ENDPOINTS=1, without touching the db", async () => {
    vi.stubEnv("MANDATE_TEST_ENDPOINTS", "");
    const getDb = vi.fn(createTestDb);
    const res = await createTestClaimHandler({ getDb }).POST(post({ agent_id: crypto.randomUUID() }));
    expect(res.status).toBe(404);
    expect(getDb).not.toHaveBeenCalled();
  });

  it("404s in production even when enabled", async () => {
    vi.stubEnv("MANDATE_TEST_ENDPOINTS", "1");
    vi.stubEnv("NODE_ENV", "production");
    const getDb = vi.fn(createTestDb);
    const res = await createTestClaimHandler({ getDb }).POST(post({ agent_id: crypto.randomUUID() }));
    expect(res.status).toBe(404);
    expect(getDb).not.toHaveBeenCalled();
  });

  it("claims and mandates a main-world agent so it reaches tier 1", async () => {
    vi.stubEnv("MANDATE_TEST_ENDPOINTS", "1");
    vi.stubEnv("API_KEY_PEPPER", "test-pepper");
    const db = await createTestDb();
    const registered = (await call(db, "register_agent", "", { name: "Harness", payout_email: "h@example.com" }))
      .envelope.data as Data;
    const handler = createTestClaimHandler({ getDb: async () => db });

    expect((await handler.POST(post({ agent_id: "nope" }))).status).toBe(400);
    expect((await handler.POST(post({ agent_id: crypto.randomUUID() }))).status).toBe(404);

    const res = await handler.POST(post({ agent_id: registered.agent_id }));
    expect(res.status).toBe(200);
    const status = await call(db, "get_status", registered.api_key as string, {});
    expect(status.envelope.data).toMatchObject({ kya: { tier: 1, can_borrow: true, claim_url: null } });

    // P2 Task 4: the mandate is signed through the real service (version 1, terms hash).
    const [mandate] = await db.select().from(mandates).where(eq(mandates.agentId, registered.agent_id as string));
    expect(mandate).toMatchObject({ version: 1, status: "signed", maxPerLoanCents: 50000n });
    expect(mandate!.termsHash).toMatch(/^[0-9a-f]{64}$/);
  });
});
