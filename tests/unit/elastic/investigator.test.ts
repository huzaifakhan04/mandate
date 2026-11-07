/**
 * P7 Task 3 — the risk investigator (`ai/investigator.ts` +
 * `services/riskInvestigation.ts`): a bounded tool-calling loop on the
 * Responses API (OpenAI mocked with msw), with tools bound to one world
 * and flag (ES|QL templates and semantic search on a fake Elastic).
 *
 * - private world: template only — no model call, no ai_runs row;
 * - public world: function calls are executed and fed back; the model sees
 *   aliases, never ids; the structured case file is stored with an ai_runs row;
 * - non-allowlisted templates are refused; at most 6 model calls;
 * - OpenAI down → template (fallback); Elastic down → template from the DB.
 */
import { eq } from "drizzle-orm";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { MAX_INVESTIGATOR_STEPS } from "@/server/ai/investigator";
import { getSimNow } from "@/server/clock/clock";
import type { Db } from "@/server/db/client";
import { agents, aiRuns, principals, riskFlags } from "@/server/db/schema";
import { createTestDb } from "@/server/db/testing";
import { createPrivateWorld } from "@/server/services/privateWorlds";
import { recordRiskHit } from "@/server/services/riskFlags";
import { AgentAliases, investigateFlag, investigatePendingFlags } from "@/server/services/riskInvestigation";

import { ELASTIC_TEST_URL, fakeEsql, fakeSearch, stubElastic, unstubElastic } from "../../helpers/elastic";
import { createSimWorld } from "../../helpers/world";

const OPENAI = "https://api.openai.com/v1/responses";
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function usage() {
  return { input_tokens: 50, input_tokens_details: { cached_tokens: 0 }, output_tokens: 20, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 70 };
}

function functionCall(name: string, args: unknown, id: string) {
  return {
    id: `resp_${id}`,
    object: "response",
    created_at: 0,
    status: "completed",
    model: "test-model",
    output: [{ type: "function_call", id: `fc_${id}`, call_id: `call_${id}`, name, arguments: JSON.stringify(args), status: "completed" }],
    usage: usage(),
  };
}

function finalAnswer(output: unknown) {
  return {
    id: "resp_final",
    object: "response",
    created_at: 0,
    status: "completed",
    model: "test-model",
    output: [
      { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: JSON.stringify(output), annotations: [] }] },
    ],
    usage: usage(),
  };
}

const CASE = {
  summary: "agent_1 repaid three loans within hours of disbursement, consistent with score farming.",
  evidence: ["3 cycles under 24 hours (agent_loan_cycles).", "No invoice collateral on recent applications."],
  recommendation: "keep",
};

describe("risk investigator (P7 Task 3)", () => {
  let db: Db;

  beforeEach(async () => {
    vi.stubEnv("API_KEY_PEPPER", "test-pepper");
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    vi.stubEnv("OPENAI_MODEL_UNDERWRITER", "test-model");
    db = await createTestDb();
    stubElastic();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    unstubElastic();
  });

  async function flagIn(worldId: string, principalId: string | null = null) {
    const [agent] = await db
      .insert(agents)
      .values({ worldId, principalId, name: "Farmer bob@example.com", operator: "o", model: "m", codeManifestHash: "x" })
      .returning();
    const simNow = await getSimNow(db, worldId);
    const flagId = await recordRiskHit(
      db,
      worldId,
      { agentId: agent!.id, kind: "score_farming", evidence: { cycles_under_one_day: 3, loans: ["4f1c9a52-1111-4222-8333-944455556666"] }, evidenceSimAt: simNow },
      simNow,
    );
    return { agentId: agent!.id, flagId: flagId! };
  }

  it("AgentAliases replaces known ids with aliases and other ids with 'other'", () => {
    const a = "11111111-1111-4111-8111-111111111111";
    const b = "22222222-2222-4222-8222-222222222222";
    const aliases = new AgentAliases(a, [b, a]);
    expect(aliases.apply({ x: a, y: [b, "33333333-3333-4333-8333-333333333333"] })).toEqual({ x: "agent_1", y: ["agent_2", "other"] });
    expect(aliases.idOf("agent_2")).toBe(b);
    expect(aliases.idOf("agent_9")).toBeNull();
  });

  it("private world: template case file from the same tools, no model call, no ai_runs row", async () => {
    const [owner] = await db
      .insert(principals)
      .values({ email: "o@example.com", name: "O", entityType: "individual", verifiedAt: new Date(), kycStatus: "verified" })
      .returning();
    const created = await createPrivateWorld(db, owner!.id, { name: "Sandbox" });
    const worldId = (created as { worldId: string }).worldId;
    const esql = fakeEsql(server, [{ includes: "cycle_hours", rows: [{ disbursed_at: "2026-01-01T00:00:00Z", repaid_at: "2026-01-01T03:00:00Z", cycle_hours: 3 }] }]);
    const { flagId } = await flagIn(worldId);
    // onUnhandledFrame: 'error' — an OpenAI call would fail the test.
    const outcome = await investigateFlag(db, worldId, flagId);
    expect(outcome).toMatchObject({ investigated: true, source: "template", recommendation: "keep" });
    expect(esql.map((c) => c.params.world_id)).toEqual([worldId]);
    const [flag] = await db.select().from(riskFlags).where(eq(riskFlags.id, flagId));
    const caseFile = flag!.caseFile as { summary: string; evidence: string[]; tool_calls: Array<{ tool: string; template_id?: string }> };
    expect(caseFile.evidence.join(" ")).toContain("3 borrow-and-repay cycles");
    expect(caseFile.tool_calls).toEqual([
      { tool: "agent_profile", ok: true },
      { tool: "esql", template_id: "agent_loan_cycles", ok: true },
    ]);
    expect(await db.select().from(aiRuns).where(eq(aiRuns.worldId, worldId))).toHaveLength(0);
    // Claimed once: a second investigation of the same flag does nothing.
    expect((await investigateFlag(db, worldId, flagId)).investigated).toBe(false);
  });

  it("public world: runs the tool-calling loop, feeds results back as aliases, stores the AI case file + ai_runs", async () => {
    const worldId = await createSimWorld(db);
    const { agentId, flagId } = await flagIn(worldId);
    fakeEsql(server, [
      { includes: "cycle_hours", rows: [{ disbursed_at: "2026-01-01T00:00:00Z", repaid_at: "2026-01-01T03:00:00Z", cycle_hours: 3 }] },
      { includes: "purpose_text", rows: [{ decision: "approved", amount_cents: 2000, purpose_text: "GPU credits", agent_id: agentId }] },
    ]);
    const searches = fakeSearch(server, "mandate-applications", [
      { application_id: "a1", agent_id: agentId, decision: "approved", amount_cents: 2000, term_days: 7, reasons: [], purpose_text: "GPU credits", sim_at: "2026-01-01T00:00:00Z" },
    ]);
    const bodies: Array<Record<string, unknown>> = [];
    const replies = [
      functionCall("esql", { template_id: "agent_loan_cycles", params: { agent_ref: "agent_1" } }, "1"),
      functionCall("esql", { template_id: "score_farming", params: { agent_ref: "agent_1" } }, "2"),
      functionCall("semantic_search", { query: "GPU credits" }, "3"),
      functionCall("agent_profile", { agent_ref: "agent_1" }, "4"),
      finalAnswer(CASE),
    ];
    server.use(
      http.post(OPENAI, async ({ request }) => {
        bodies.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json(replies[bodies.length - 1]);
      }),
    );
    const outcome = await investigateFlag(db, worldId, flagId);
    expect(outcome).toMatchObject({ investigated: true, source: "ai", recommendation: "keep" });
    expect(bodies).toHaveLength(5);
    expect(searches).toHaveLength(1);

    // The model never sees a raw id: only aliases.
    const wire = JSON.stringify(bodies);
    expect(wire).not.toMatch(UUID_RE);
    expect(wire).not.toContain("bob@example.com");
    expect(wire).toContain("agent_1");
    // Tool definitions: the three tools, esql restricted to investigator templates.
    const tools = bodies[0]!.tools as Array<{ name: string; parameters: { properties: Record<string, { enum?: string[] }> } }>;
    expect(tools.map((t) => t.name)).toEqual(["esql", "semantic_search", "agent_profile"]);
    expect(tools[0]!.parameters.properties.template_id!.enum).not.toContain("score_farming");
    // Results come back as function_call_output; the detector template was refused.
    const lastInput = bodies[4]!.input as Array<{ type?: string; output?: string }>;
    const outputs = lastInput.filter((i) => i.type === "function_call_output").map((i) => i.output!);
    expect(outputs).toHaveLength(4);
    expect(outputs[0]).toContain("cycle_hours");
    expect(outputs[1]).toContain("not allowlisted");

    const [flag] = await db.select().from(riskFlags).where(eq(riskFlags.id, flagId));
    expect(flag!.caseFile).toMatchObject({ ...CASE, source: "ai", steps: 5 });
    expect(flag!.aiRunId).not.toBeNull();
    const [run] = await db.select().from(aiRuns).where(eq(aiRuns.id, flag!.aiRunId!));
    expect(run).toMatchObject({ role: "risk_investigator", fallbackUsed: false, errorCode: null, subject: `risk_flag:${flagId}`, tokensIn: 250 });
  });

  it("stops after MAX_INVESTIGATOR_STEPS model calls (last call forbids tools) and falls back if still no answer", async () => {
    const worldId = await createSimWorld(db);
    const { flagId } = await flagIn(worldId);
    fakeEsql(server, []);
    const bodies: Array<Record<string, unknown>> = [];
    server.use(
      http.post(OPENAI, async ({ request }) => {
        bodies.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json(functionCall("agent_profile", { agent_ref: "agent_1" }, String(bodies.length)));
      }),
    );
    const outcome = await investigateFlag(db, worldId, flagId);
    expect(bodies).toHaveLength(MAX_INVESTIGATOR_STEPS);
    expect(bodies[MAX_INVESTIGATOR_STEPS - 1]!.tool_choice).toBe("none");
    expect(outcome.source).toBe("fallback");
    const [run] = await db.select().from(aiRuns).where(eq(aiRuns.worldId, worldId));
    expect(run).toMatchObject({ fallbackUsed: true });
  });

  it("OpenAI down → the template case file (fallback) with an ai_runs row", async () => {
    const worldId = await createSimWorld(db);
    const { flagId } = await flagIn(worldId);
    fakeEsql(server, []);
    server.use(http.post(OPENAI, () => HttpResponse.json({ error: { message: "boom" } }, { status: 500 })));
    const outcome = await investigateFlag(db, worldId, flagId);
    expect(outcome.source).toBe("fallback");
    const [run] = await db.select().from(aiRuns).where(eq(aiRuns.worldId, worldId));
    expect(run).toMatchObject({ role: "risk_investigator", fallbackUsed: true, errorCode: "http_500" });
    const [flag] = await db.select().from(riskFlags).where(eq(riskFlags.id, flagId));
    expect((flag!.caseFile as { summary: string }).summary).toContain("score farming");
  });

  it("an answer claiming the flag was cleared breaks policy → template", async () => {
    const worldId = await createSimWorld(db);
    const { flagId } = await flagIn(worldId);
    fakeEsql(server, []);
    server.use(http.post(OPENAI, () => HttpResponse.json(finalAnswer({ ...CASE, summary: "The flag has been cleared.", recommendation: "clear" }))));
    const outcome = await investigateFlag(db, worldId, flagId);
    expect(outcome.source).toBe("fallback");
    const [run] = await db.select().from(aiRuns).where(eq(aiRuns.worldId, worldId));
    expect(run!.errorCode).toBe("policy_violation");
  });

  it("Elastic down → the template still writes a case file from the database profile", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const worldId = await createSimWorld(db);
    server.use(http.post(`${ELASTIC_TEST_URL}/_query`, () => HttpResponse.json({ error: {} }, { status: 503, headers: { "x-elastic-product": "Elasticsearch" } })));
    await flagIn(worldId);
    const outcomes = await investigatePendingFlags(db, worldId);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ investigated: true, source: "fallback" });
    const [flag] = await db.select().from(riskFlags).where(eq(riskFlags.worldId, worldId));
    const caseFile = flag!.caseFile as { evidence: string[]; tool_calls: Array<{ tool: string; ok: boolean }> };
    expect(caseFile.evidence[0]).toMatch(/^Profile: tier T0/);
    expect(caseFile.tool_calls).toContainEqual({ tool: "esql", template_id: "agent_loan_cycles", ok: false });
    const [run] = await db.select().from(aiRuns).where(eq(aiRuns.worldId, worldId));
    expect(run!.errorCode).toBe("disabled");
  });
});
