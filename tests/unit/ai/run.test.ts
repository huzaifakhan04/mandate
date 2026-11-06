import { eq } from "drizzle-orm";
import { delay, http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { __resetAiTimeoutMsForTests, __setAiTimeoutMsForTests } from "@/server/ai/client";
import { runRole } from "@/server/ai/run";
import type { KyaDeskInput, LoanOfficerInput, RiskOfficerInput } from "@/server/ai/schemas";
import { loanOfficerTemplate } from "@/server/ai/templates";
import type { Db } from "@/server/db/client";
import { aiRuns } from "@/server/db/schema";
import { createTestDb } from "@/server/db/testing";
import { REASON_TEXT } from "@/server/domain/reasons";
import { createSimWorld } from "../../helpers/world";

const URL = "https://api.openai.com/v1/responses";
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function responseBody(text: string, status = "completed") {
  return {
    id: "resp_test",
    object: "response",
    created_at: 0,
    status,
    model: "test-model",
    output: [
      {
        type: "message",
        id: "msg_test",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    ],
    usage: {
      input_tokens: 321,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 87,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 408,
    },
  };
}

function replyWith(output: unknown) {
  const bodies: unknown[] = [];
  server.use(
    http.post(URL, async ({ request }) => {
      bodies.push(await request.json());
      return HttpResponse.json(responseBody(typeof output === "string" ? output : JSON.stringify(output)));
    }),
  );
  return bodies;
}

const declineInput: LoanOfficerInput = {
  decision: "decline",
  reasons: [
    { code: "insufficient_credit_history", text: REASON_TEXT.insufficient_credit_history },
    { code: "declaration_missing", text: REASON_TEXT.declaration_missing },
  ],
  score: 20,
  grade: "E",
  scoreFactors: ["No repayment history yet."],
  amountCents: 10000,
  termDays: 14,
  feeCents: null,
  aprBps: null,
  effectiveCapCents: 0,
};

const goodDeclineOutput = {
  summary: "Your request for $100.00 over 14 days was declined.",
  reasons_explained: [
    { code: "insufficient_credit_history", explanation: "You have no repaid loans with us yet." },
    { code: "declaration_missing", explanation: "The no-other-debt declaration was not provided." },
  ],
  next_steps: ["Take a small invoice-backed loan and repay it on time."],
};

let db: Db;
let worldId: string;

beforeAll(async () => {
  db = await createTestDb();
  worldId = await createSimWorld(db);
});

beforeEach(() => {
  process.env.OPENAI_API_KEY = "sk-test-not-a-real-key";
  process.env.OPENAI_MODEL_UNDERWRITER = "test-underwriter";
  process.env.OPENAI_MODEL_CHECK = "test-check";
  delete process.env.OPENAI_DISABLED;
});

afterEach(() => {
  __resetAiTimeoutMsForTests();
  delete process.env.OPENAI_API_KEY;
});

async function aiRun(id: string) {
  const [row] = await db.select().from(aiRuns).where(eq(aiRuns.id, id));
  return row!;
}

describe("runRole", () => {
  it("returns the parsed LLM output and logs the run (model, tokens, hashes, subject)", async () => {
    const bodies = replyWith(goodDeclineOutput);
    const result = await runRole(db, worldId, "loan_officer", declineInput, { subject: "app-1" });

    expect(result.fallbackUsed).toBe(false);
    expect(result.errorCode).toBeNull();
    expect(result.output).toEqual(goodDeclineOutput);

    const body = bodies[0] as { model: string; text: { format: { type: string; strict: boolean; name: string } }; store: boolean };
    expect(body.model).toBe("test-underwriter");
    expect(body.text.format).toMatchObject({ type: "json_schema", strict: true, name: "loan_officer" });
    expect(body.store).toBe(false);

    const row = await aiRun(result.aiRunId);
    expect(row).toMatchObject({
      worldId,
      role: "loan_officer",
      model: "test-underwriter",
      tokensIn: 321,
      tokensOut: 87,
      fallbackUsed: false,
      errorCode: null,
      subject: "app-1",
      output: goodDeclineOutput,
    });
    expect(row.inputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.promptHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("uses OPENAI_MODEL_CHECK for the KYA desk", async () => {
    const bodies = replyWith({ verdict: "approve", findings: ["Looks consistent."] });
    const input: KyaDeskInput = {
      agent: { name: "Bot", operator: "acme", tier: 1 },
      document: { kind: "id_document", fileName: "id.pdf", contentType: "application/pdf", sizeBytes: 1234, autoReviewStatus: "approved" },
    };
    const result = await runRole(db, worldId, "kya_desk", input);
    expect(result.fallbackUsed).toBe(false);
    expect((bodies[0] as { model: string }).model).toBe("test-check");
  });

  it("times out → template, fallback_used, error 'timeout' (Review Focus 2)", async () => {
    __setAiTimeoutMsForTests(50);
    server.use(
      http.post(URL, async () => {
        await delay(2000);
        return HttpResponse.json(responseBody(JSON.stringify(goodDeclineOutput)));
      }),
    );
    const started = Date.now();
    const result = await runRole(db, worldId, "loan_officer", declineInput);
    expect(Date.now() - started).toBeLessThan(1500);
    expect(result).toMatchObject({ fallbackUsed: true, errorCode: "timeout", output: loanOfficerTemplate(declineInput) });
    expect(await aiRun(result.aiRunId)).toMatchObject({ fallbackUsed: true, errorCode: "timeout" });
  });

  it("a caller abort signal → template", async () => {
    server.use(
      http.post(URL, async () => {
        await delay(2000);
        return HttpResponse.json({});
      }),
    );
    const result = await runRole(db, worldId, "loan_officer", declineInput, { signal: AbortSignal.timeout(30) });
    expect(result.fallbackUsed).toBe(true);
    expect(result.output).toEqual(loanOfficerTemplate(declineInput));
  });

  it("HTTP 500 → template with error 'http_500', one attempt only", async () => {
    let calls = 0;
    server.use(
      http.post(URL, () => {
        calls += 1;
        return HttpResponse.json({ error: { message: "boom" } }, { status: 500 });
      }),
    );
    const result = await runRole(db, worldId, "loan_officer", declineInput);
    expect(calls).toBe(1);
    expect(result).toMatchObject({ fallbackUsed: true, errorCode: "http_500" });
    expect((await aiRun(result.aiRunId)).errorCode).toBe("http_500");
  });

  it("invalid JSON in the output text → template, 'invalid_json'", async () => {
    replyWith("{not json");
    const result = await runRole(db, worldId, "loan_officer", declineInput);
    expect(result).toMatchObject({ fallbackUsed: true, errorCode: "invalid_json", output: loanOfficerTemplate(declineInput) });
    expect(await aiRun(result.aiRunId)).toMatchObject({ fallbackUsed: true, tokensIn: 321 });
  });

  it("a non-JSON HTTP body → template", async () => {
    server.use(http.post(URL, () => new HttpResponse("<html>gateway</html>", { status: 200, headers: { "content-type": "application/json" } })));
    const result = await runRole(db, worldId, "loan_officer", declineInput);
    expect(result.fallbackUsed).toBe(true);
    expect(result.output).toEqual(loanOfficerTemplate(declineInput));
  });

  it("schema-violating output → template, 'schema_violation'", async () => {
    replyWith({ summary: "ok", reasons_explained: [], next_steps: [], extra: "field" });
    const result = await runRole(db, worldId, "loan_officer", declineInput);
    expect(result).toMatchObject({ fallbackUsed: true, errorCode: "schema_violation" });

    replyWith({ memo: 42, concerns: [] });
    const risk = await runRole(db, worldId, "risk_officer", riskInput());
    expect(risk).toMatchObject({ fallbackUsed: true, errorCode: "schema_violation" });
  });

  it("an incomplete response → template", async () => {
    server.use(http.post(URL, () => HttpResponse.json(responseBody(JSON.stringify(goodDeclineOutput), "incomplete"))));
    const result = await runRole(db, worldId, "loan_officer", declineInput);
    expect(result).toMatchObject({ fallbackUsed: true, errorCode: "incomplete" });
  });

  it("policy: a reason not in the input (structured or in text) → template, 'policy_violation'", async () => {
    replyWith({
      ...goodDeclineOutput,
      reasons_explained: [...goodDeclineOutput.reasons_explained, { code: "sanctions_hit", explanation: "You are sanctioned." }],
    });
    const structured = await runRole(db, worldId, "loan_officer", declineInput);
    expect(structured).toMatchObject({ fallbackUsed: true, errorCode: "policy_violation", output: loanOfficerTemplate(declineInput) });

    replyWith({ ...goodDeclineOutput, next_steps: ["Also fix open_loan_exists."] });
    const inText = await runRole(db, worldId, "loan_officer", declineInput);
    expect(inText).toMatchObject({ fallbackUsed: true, errorCode: "policy_violation" });
    expect(await aiRun(inText.aiRunId)).toMatchObject({ fallbackUsed: true, errorCode: "policy_violation" });
  });

  it("policy: claiming approval on a decline → template", async () => {
    replyWith({ ...goodDeclineOutput, summary: "Good news: your loan has been approved for $100.00!" });
    const result = await runRole(db, worldId, "loan_officer", declineInput);
    expect(result).toMatchObject({ fallbackUsed: true, errorCode: "policy_violation" });
  });

  it("OPENAI_DISABLED=1 → template immediately, logged with error 'disabled' and no request", async () => {
    process.env.OPENAI_DISABLED = "1";
    const result = await runRole(db, worldId, "loan_officer", declineInput, { subject: "app-2" });
    expect(result).toMatchObject({ fallbackUsed: true, errorCode: "disabled", output: loanOfficerTemplate(declineInput) });
    expect(await aiRun(result.aiRunId)).toMatchObject({ fallbackUsed: true, errorCode: "disabled", subject: "app-2", tokensIn: null });
  });

  it("a missing OPENAI_API_KEY → template, 'disabled'", async () => {
    delete process.env.OPENAI_API_KEY;
    const result = await runRole(db, worldId, "risk_officer", riskInput());
    expect(result).toMatchObject({ fallbackUsed: true, errorCode: "disabled" });
  });

  it("strips non-allowlisted fields and redacts PII from the request body (Review Focus 5)", async () => {
    const bodies = replyWith({ verdict: "needs_info", findings: ["Check the file name."] });
    const key = "mnd_abcdefgh_abcdefghijklmnopqrstuvwxyz234567";
    const principalId = "0b6c8a52-3f0e-4c64-9b1f-1c2d3e4f5a6b";
    const input = {
      agent: { name: "Bot of owner@example.com", operator: `acme ${key}`, tier: 1, payoutReceiver: "payee@example.com", principalId },
      document: {
        kind: "id_document",
        fileName: `passport-${principalId}-SIMPAYER00001-alice.smith@corp.io.pdf`,
        contentType: "application/pdf",
        sizeBytes: 999,
        autoReviewStatus: "approved",
        sha256: "f".repeat(64),
      },
      apiKey: key,
      payerId: "7WJ8XLGQZ9P2A",
      email: "human@example.com",
    } as unknown as KyaDeskInput;

    await runRole(db, worldId, "kya_desk", input);

    const raw = JSON.stringify(bodies[0]);
    expect(raw).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    expect(raw).not.toContain("mnd_");
    expect(raw).not.toContain("SIMPAYER00001");
    expect(raw).not.toContain("7WJ8XLGQZ9P2A");
    expect(raw).not.toContain(principalId);
    expect(raw).not.toContain("payoutReceiver");
    expect(raw).not.toContain("f".repeat(64));
    expect(raw).not.toContain("sk-test-not-a-real-key");
  });
});

function riskInput(): RiskOfficerInput {
  return {
    decision: "decline",
    approval: "manual_review_declined",
    reasons: [{ code: "manual_review_declined", text: REASON_TEXT.manual_review_declined }],
    score: 40,
    grade: "D",
    components: { identity: 18, history: 0, tenure: 2, collateral: 20, exposure: 10 },
    scoreFactors: ["No repayment history yet."],
    amountCents: 8000,
    termDays: 14,
    invoiceCoverageBps: 15000,
  };
}
