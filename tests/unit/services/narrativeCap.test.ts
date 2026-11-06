/**
 * P3 final review I4: AI cost caps. At most `DAILY_LLM_NARRATIVES_PER_AGENT`
 * applications per agent per real UTC day get an LLM narrative; beyond it
 * the templates are used with `error_code: rate_capped` (still logged in
 * `ai_runs`), and OpenAI is never called.
 */
import { and, eq } from "drizzle-orm";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { Db } from "@/server/db/client";
import { aiRuns, applications } from "@/server/db/schema";
import { createTestDb } from "@/server/db/testing";
import { DAILY_LLM_NARRATIVES_PER_AGENT, llmNarrativesToday } from "@/server/services/underwritingNarrative";

import { call, createSimWorld, createTestAgent, type Data } from "../../helpers/world";

const URL = "https://api.openai.com/v1/responses";
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const LLM_OUTPUT = {
  summary: "Your application was declined.",
  reasons_explained: [{ code: "insufficient_credit_history", explanation: "No repaid loans yet." }],
  next_steps: ["Take a small invoice-backed loan and repay it on time."],
};

function mockLlm() {
  const bodies: Array<Record<string, unknown>> = [];
  server.use(
    http.post(URL, async ({ request }) => {
      bodies.push((await request.json()) as Record<string, unknown>);
      return HttpResponse.json({
        id: "resp_test",
        object: "response",
        created_at: 0,
        status: "completed",
        model: "test-model",
        output: [
          {
            type: "message",
            id: "msg_test",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: JSON.stringify(LLM_OUTPUT), annotations: [] }],
          },
        ],
        usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 10, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 20 },
      });
    }),
  );
  return bodies;
}

describe("I4: the daily per-agent LLM narrative cap", () => {
  let db: Db;
  let worldId: string;
  let agent: { agentId: string; key: string };

  beforeEach(async () => {
    vi.stubEnv("API_KEY_PEPPER", "test-pepper");
    vi.stubEnv("OPENAI_API_KEY", "sk-test-not-a-real-key");
    vi.stubEnv("OPENAI_DISABLED", "");
    vi.stubEnv("OPENAI_MODEL_UNDERWRITER", "test-underwriter");
    vi.stubEnv("OPENAI_MODEL_CHECK", "test-check");
    db = await createTestDb();
    worldId = await createSimWorld(db);
    agent = await createTestAgent(db, worldId, "capped@example.com", { credit: "real" });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /** `n` past applications of `agentId`, each with a loan officer `ai_runs` row (`errorCode`, `createdAt`). */
  async function seedNarrated(agentId: string, n: number, errorCode: string | null = null, createdAt = new Date()) {
    for (let i = 0; i < n; i++) {
      const [application] = await db
        .insert(applications)
        .values({ worldId, agentId, amountCents: 1000n, termDays: 7, purpose: "Seeded application" })
        .returning();
      await db.insert(aiRuns).values({
        worldId,
        role: "loan_officer",
        model: "test-underwriter",
        promptHash: "seed",
        subject: application!.id,
        fallbackUsed: errorCode !== null,
        errorCode,
        createdAt,
      });
    }
  }

  const decline = { amount_cents: 2000, term_days: 7, purpose: "Working capital" };

  async function loanOfficerRun(applicationId: string) {
    const [row] = await db
      .select()
      .from(aiRuns)
      .where(and(eq(aiRuns.subject, applicationId), eq(aiRuns.role, "loan_officer")));
    return row!;
  }

  it("counts only today's model calls for this agent's applications", async () => {
    const other = await createTestAgent(db, worldId, "other@example.com", { credit: "real" });
    await seedNarrated(agent.agentId, 3);
    await seedNarrated(agent.agentId, 2, "timeout"); // reached OpenAI: counts
    await seedNarrated(agent.agentId, 4, "disabled"); // never reached OpenAI
    await seedNarrated(agent.agentId, 4, "rate_capped");
    await seedNarrated(agent.agentId, 5, null, new Date(Date.now() - 2 * 86_400_000)); // an earlier UTC day
    await seedNarrated(other.agentId, 6);
    expect(await llmNarrativesToday(db, worldId, agent.agentId)).toBe(5);
    expect(await llmNarrativesToday(db, worldId, other.agentId)).toBe(6);
  });

  it("calls the model (max_output_tokens set) under the cap, and uses the template with rate_capped at it", async () => {
    const bodies = mockLlm();

    await seedNarrated(agent.agentId, DAILY_LLM_NARRATIVES_PER_AGENT - 1);
    const under = await call(db, "apply_for_loan", agent.key, decline);
    const underData = under.envelope.data as Data;
    expect((underData.explanation as Data).source).toBe("ai");
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.max_output_tokens).toBe(600);
    expect((await loanOfficerRun(underData.application_id as string)).errorCode).toBeNull();

    // That was the 20th today: the 21st is capped — no OpenAI call, template, still logged.
    const capped = await call(db, "apply_for_loan", agent.key, decline);
    const cappedData = capped.envelope.data as Data;
    expect(capped.envelope.status).toBe("DECLINED");
    expect((cappedData.explanation as Data).source).toBe("template");
    expect(bodies).toHaveLength(1);
    const row = await loanOfficerRun(cappedData.application_id as string);
    expect(row).toMatchObject({ fallbackUsed: true, errorCode: "rate_capped", tokensIn: null, tokensOut: null });

    // Another agent in the same world is not affected.
    const other = await createTestAgent(db, worldId, "fresh@example.com", { credit: "real" });
    const otherApply = await call(db, "apply_for_loan", other.key, decline);
    expect(((otherApply.envelope.data as Data).explanation as Data).source).toBe("ai");
    expect(bodies).toHaveLength(2);
  });
});
