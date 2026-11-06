/**
 * P3 Task 4: the ALA application (sections A–H) in `apply_for_loan`, the
 * adverse-action payload on a decline, the loan officer / risk officer
 * narrative written after commit (`finalize`), and `get_application`.
 * OpenAI is disabled here (no key): every narrative is the template. The
 * mocked-LLM cases are in reviewFocus1.test.ts.
 */
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loanOfficerTemplate } from "@/server/ai/templates";
import type { Db } from "@/server/db/client";
import { agents, aiRuns, applications, mandates, offers } from "@/server/db/schema";
import { createTestDb } from "@/server/db/testing";
import { REASON_PRIORITY, REASON_TEXT, type ReasonCode } from "@/server/domain/reasons";
import { computeScore } from "@/server/domain/scorecard";
import {
  ADVERSE_ACTION_NOTICE,
  buildAdverseAction,
  loanOfficerInputFor,
  templateExplanation,
} from "@/server/services/adverseAction";
import { __setScoreFactsOverrideForTests } from "@/server/services/credit";
import { agentDetail } from "@/server/services/dashboard";
import { evaluateApplication } from "@/server/domain/rules";

import { ESTABLISHED_CREDIT } from "../../helpers/kya";
import { call, callRaw, createSimWorld, createTestAgent, type Data, fundPool } from "../../helpers/world";

const REAL = { credit: "real" } as const;
const invoice = (amountCents: number) => ({
  invoice: { client_email: "client@example.com", amount_cents: amountCents, due_in_days: 7, description: "Work" },
});

describe("ALA sections A–H, adverse action and the narrative (P3 Task 4)", () => {
  let db: Db;
  let worldId: string;

  beforeEach(async () => {
    vi.stubEnv("SESSION_SECRET", "unit-test-session-secret-0123456789abcdef");
    vi.stubEnv("API_KEY_PEPPER", "test-pepper");
    vi.stubEnv("OPENAI_API_KEY", "");
    db = await createTestDb();
    worldId = await createSimWorld(db);
    await fundPool(db, worldId, 60000);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function applicationRow(id: string) {
    const [row] = await db.select().from(applications).where(eq(applications.id, id));
    return row!;
  }

  it("without the declarations (E) and attestation (H) → DECLINED declaration_missing with an adverse-action notice", async () => {
    const { key } = await createTestAgent(db, worldId, "a@example.com");
    const declined = await callRaw(db, "apply_for_loan", key, { amount_cents: 1000, term_days: 7, purpose: "Buy tools" });
    expect(declined.httpStatus).toBe(200);
    expect(declined.envelope).toMatchObject({ status: "DECLINED", reason_codes: ["declaration_missing"] });
    const data = declined.envelope.data as Data;
    const adverse = data.adverse_action as Data;
    expect(adverse).toMatchObject({
      reasons: [{ code: "declaration_missing", text: REASON_TEXT.declaration_missing }],
      score: 80,
      grade: "A",
      notice: ADVERSE_ACTION_NOTICE,
    });
    expect(adverse.score_factors).toEqual(expect.any(Array));
    expect(ADVERSE_ACTION_NOTICE).toMatch(/right to a statement of specific reasons/i);
    // The explanation (template: OpenAI is off) is on the notice and at the top level.
    const explanation = data.explanation as Data;
    expect(explanation).toMatchObject({ source: "template" });
    expect(explanation.reasons_explained).toEqual([
      { code: "declaration_missing", explanation: REASON_TEXT.declaration_missing },
    ]);
    expect(adverse.explanation).toEqual(explanation);

    // A copy is stored on the application.
    const row = await applicationRow(data.application_id as string);
    expect(row.adverseAction).toEqual(adverse);
    expect(row.sections).toMatchObject({ declarations: { no_other_debt: false }, attest: false });
  });

  it("attest: false alone, or no_other_debt: false alone → declaration_missing", async () => {
    const { key } = await createTestAgent(db, worldId, "a@example.com");
    for (const ala of [
      { declarations: { no_other_debt: true }, attest: false },
      { declarations: { no_other_debt: false }, attest: true },
    ]) {
      const declined = await callRaw(db, "apply_for_loan", key, { amount_cents: 1000, term_days: 7, purpose: "Buy tools", ...ala });
      expect(declined.envelope).toMatchObject({ status: "DECLINED", reason_codes: ["declaration_missing"] });
    }
  });

  it("stores the full ALA (A–H) on the application; the mandate reference (G) is filled by the server", async () => {
    const { key, mandateId } = await createTestAgent(db, worldId, "a@example.com");
    const offered = await call(db, "apply_for_loan", key, {
      amount_cents: 1000,
      term_days: 7,
      purpose: "Buy tools",
      identity: { operator: "Acme Ops", model: "gpt-x", code_manifest_hash: "abc123" },
      consent_bank_records: true,
      ...invoice(1500),
    });
    expect(offered.envelope.status).toBe("OFFERED");
    const data = offered.envelope.data as Data;
    // Approvals get an explanation too (the loan officer always runs).
    expect(data.explanation).toMatchObject({ source: "template", reasons_explained: [] });

    const [mandate] = await db.select().from(mandates).where(eq(mandates.id, mandateId!));
    const row = await applicationRow(data.application_id as string);
    expect(row.sections).toEqual({
      ala_version: 1,
      identity: { operator: "Acme Ops", model: "gpt-x", code_manifest_hash: "abc123" },
      purpose: "Buy tools",
      amount_term: { amount_cents: 1000, term_days: 7 },
      collateral: { invoice: { client_email: "client@example.com", amount_cents: 1500, due_in_days: 7, description: "Work" } },
      declarations: { no_other_debt: true },
      consent_bank_records: true,
      mandate: { mandate_id: mandateId, mandate_version: mandate!.version, expected_version: null },
      attest: true,
    });
    expect(row.adverseAction).toBeNull();
  });

  it("G: an expected mandate_version that is not current → 409 MANDATE_CHANGED, nothing written; a match proceeds", async () => {
    const { key, mandateId } = await createTestAgent(db, worldId, "a@example.com");
    const [mandate] = await db.select().from(mandates).where(eq(mandates.id, mandateId!));
    const stale = await call(db, "apply_for_loan", key, {
      amount_cents: 1000,
      term_days: 7,
      purpose: "Buy tools",
      mandate_version: mandate!.version + 1,
    });
    expect(stale.httpStatus).toBe(409);
    expect(stale.envelope).toMatchObject({
      status: "MANDATE_CHANGED",
      reason_codes: ["mandate_changed"],
      data: { current_mandate_version: mandate!.version },
    });
    expect(await db.select().from(applications)).toHaveLength(0);

    const current = await call(db, "apply_for_loan", key, {
      amount_cents: 1000,
      term_days: 7,
      purpose: "Buy tools",
      mandate_version: mandate!.version,
    });
    expect(current.envelope.status).toBe("OFFERED");
    const row = await applicationRow((current.envelope.data as Data).application_id as string);
    expect(row.sections).toMatchObject({ mandate: { expected_version: mandate!.version } });
  });

  it("finalize stores the narrative on the application and logs the loan officer run (template when OpenAI is off)", async () => {
    const { key } = await createTestAgent(db, worldId, "new@example.com", REAL);
    const declined = await call(db, "apply_for_loan", key, { amount_cents: 1000, term_days: 7, purpose: "Buy tools" });
    const data = declined.envelope.data as Data;
    const applicationId = data.application_id as string;
    const row = await applicationRow(applicationId);
    expect(row.narrative).toMatchObject({ explanation: data.explanation, memo: null, ai_run_ids: { risk_officer: null } });
    const runs = await db.select().from(aiRuns).where(eq(aiRuns.subject, applicationId));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ role: "loan_officer", fallbackUsed: true, errorCode: "disabled" });
    expect(row.aiRunId).toBe(runs[0]!.id);
    expect((row.narrative as Data).ai_run_ids).toMatchObject({ loan_officer: runs[0]!.id });
  });

  it("grade D: the risk officer writes a memo, stored on the application (never sent to the agent)", async () => {
    const { key } = await createTestAgent(db, worldId, "new@example.com", REAL);
    const declined = await call(db, "apply_for_loan", key, { amount_cents: 6000, term_days: 7, purpose: "Buy tools", ...invoice(9000) });
    expect(declined.envelope.reason_codes).toEqual(["manual_review_declined"]);
    const data = declined.envelope.data as Data;
    expect(JSON.stringify(declined.envelope)).not.toContain("memo");

    const applicationId = data.application_id as string;
    const runs = await db.select().from(aiRuns).where(eq(aiRuns.subject, applicationId));
    expect(runs.map((r) => r.role).sort()).toEqual(["loan_officer", "risk_officer"]);
    const narrative = (await applicationRow(applicationId)).narrative as Data;
    expect(narrative.memo).toMatchObject({ source: "template", concerns: expect.any(Array) });
    expect((narrative.memo as Data).memo).toContain("Grade D");
  });

  it("an idempotent replay returns the finalized envelope (explanation included) without re-running the narrative", async () => {
    const { key } = await createTestAgent(db, worldId, "new@example.com", REAL);
    const input = { amount_cents: 1000, term_days: 7, purpose: "Buy tools" };
    const first = await call(db, "apply_for_loan", key, input, "idem-ala-1");
    const replay = await call(db, "apply_for_loan", key, input, "idem-ala-1");
    expect(replay.envelope).toEqual(first.envelope);
    expect((replay.envelope.data as Data).explanation).toBeDefined();
    expect(await db.select().from(aiRuns)).toHaveLength(1);
  });

  it("the owner's dashboard drawer shows the latest declines with their adverse-action reasons", async () => {
    const { agentId, principalId, key } = await createTestAgent(db, worldId, "new@example.com", REAL);
    await call(db, "apply_for_loan", key, { amount_cents: 1000, term_days: 7, purpose: "Buy tools" });
    const detail = await agentDetail(db, principalId!, agentId);
    expect(detail!.declines).toHaveLength(1);
    expect(detail!.declines[0]).toMatchObject({
      amountCents: 1000n,
      termDays: 7,
      reasons: [{ code: "insufficient_credit_history", text: REASON_TEXT.insufficient_credit_history }],
      grade: "E",
      explanation: expect.stringContaining("declined"),
    });
  });

  describe("get_application", () => {
    it("returns the decision, reasons, adverse action, latest explanation and the ALA echo — owner only", async () => {
      const { key } = await createTestAgent(db, worldId, "new@example.com", REAL);
      const declined = await call(db, "apply_for_loan", key, { amount_cents: 1000, term_days: 7, purpose: "Buy tools" });
      const data = declined.envelope.data as Data;
      const applicationId = data.application_id as string;

      const got = await call(db, "get_application", key, { application_id: applicationId });
      expect(got.envelope.status).toBe("OK");
      expect(got.envelope.data).toMatchObject({
        application_id: applicationId,
        status: "DECLINED",
        decision: "declined",
        reasons: [{ code: "insufficient_credit_history", text: REASON_TEXT.insufficient_credit_history }],
        adverse_action: data.adverse_action,
        explanation: data.explanation,
        offer_id: null,
        ala: { purpose: "Buy tools", attest: true, declarations: { no_other_debt: true } },
      });

      // The latest explanation is what's stored on the application.
      const updated = { ...(data.explanation as Data), summary: "A newer explanation." };
      await db.update(applications).set({ narrative: { explanation: updated } }).where(eq(applications.id, applicationId));
      const again = await call(db, "get_application", key, { application_id: applicationId });
      expect((again.envelope.data as Data).explanation).toEqual(updated);

      // Someone else's application, or no such id → NOT_FOUND.
      const other = await createTestAgent(db, worldId, "other@example.com");
      expect((await call(db, "get_application", other.key, { application_id: applicationId })).envelope).toMatchObject({
        status: "NOT_FOUND",
        reason_codes: ["application_not_found"],
      });
      expect(
        (await call(db, "get_application", key, { application_id: "00000000-0000-4000-8000-000000000000" })).envelope.status,
      ).toBe("NOT_FOUND");
    });

    it("an offered application returns its offer id and no adverse action", async () => {
      const { key } = await createTestAgent(db, worldId, "a@example.com");
      const offered = (await call(db, "apply_for_loan", key, { amount_cents: 1000, term_days: 7, purpose: "Buy tools" })).envelope
        .data as Data;
      const got = (await call(db, "get_application", key, { application_id: offered.application_id })).envelope.data as Data;
      expect(got).toMatchObject({
        status: "OFFERED",
        decision: "approved",
        reasons: [],
        adverse_action: null,
        offer_id: offered.offer_id,
        explanation: offered.explanation,
      });
      const [offer] = await db.select().from(offers).where(eq(offers.id, offered.offer_id as string));
      expect(offer).toBeDefined();
    });
  });

  describe("adverse action for each reason", () => {
    const credit = computeScore({
      claimed: true,
      hasSigningKey: false,
      hasApprovedDocument: false,
      onTimeRepaidLoans: 0,
      lateRepayments: 0,
      everChargedOff: false,
      tenureDays: 0,
      invoiceCoverageBps: null,
      exposureCents: 0n,
      maxTotalOwedCents: 50000n,
    });

    it.each(REASON_PRIORITY.map((code) => [code]))("%s: fixed text, notice and a template explanation", (code) => {
      const reasons = [code as ReasonCode];
      const input = loanOfficerInputFor(
        { decision: "decline", reasons, effectiveCapCents: 0n, price: null },
        credit,
        1000n,
        7,
      );
      const explanation = templateExplanation(input);
      const adverse = buildAdverseAction(reasons, credit, explanation);
      expect(adverse).toEqual({
        reasons: [{ code, text: REASON_TEXT[code as ReasonCode] }],
        score: credit.score,
        grade: credit.grade,
        score_factors: credit.factors,
        notice: ADVERSE_ACTION_NOTICE,
        explanation: { source: "template", ...loanOfficerTemplate(input) },
      });
      expect(explanation.reasons_explained).toEqual([{ code, explanation: REASON_TEXT[code as ReasonCode] }]);
      expect(explanation.next_steps.length).toBeGreaterThan(0);
    });

    it("shows at most 4 principal reasons, in pipeline order", () => {
      const decision = evaluateApplication({
        amountCents: 60000n,
        termDays: 40,
        purpose: "",
        credit,
        hasHistory: false,
        tierCapCents: 25000n,
        mandate: null,
        exposureCents: 0n,
        collateral: null,
        invoiceCoverageBps: 10000,
        sanctions: { name: "a", operator: "b", list: [] },
        declarations: { noOtherDebt: false, attested: false },
        openLoanExists: true,
        availableLiquidityCents: 0n,
      });
      expect(decision.reasons.length).toBeGreaterThan(4);
      const input = loanOfficerInputFor(decision, credit, 60000n, 40);
      const adverse = buildAdverseAction(decision.reasons, credit, templateExplanation(input));
      expect(adverse.reasons.map((r) => r.code)).toEqual(decision.reasons.slice(0, 4));
    });

    it("end to end: each reachable decline carries its reasons on the notice", async () => {
      const cases: Array<[string, () => Promise<{ key: string }>, Data, ReasonCode[]]> = [
        ["newcomer", () => createTestAgent(db, worldId, "n1@example.com", REAL), {}, ["insufficient_credit_history"]],
        ["manual review", () => createTestAgent(db, worldId, "n2@example.com", REAL), { amount_cents: 6000, ...invoice(9000) }, ["manual_review_declined"]],
        [
          "thin collateral",
          () => createTestAgent(db, worldId, "n3@example.com", REAL),
          invoice(1090),
          ["insufficient_credit_history", "insufficient_collateral"],
        ],
        [
          "over the grade limit",
          async () => {
            const agent = await createTestAgent(db, worldId, "d@example.com");
            __setScoreFactsOverrideForTests(agent.agentId, { ...ESTABLISHED_CREDIT, onTimeRepaidLoans: 0 });
            return agent;
          },
          { amount_cents: 20000 },
          ["amount_exceeds_limit"],
        ],
      ];
      for (const [label, make, extra, expected] of cases) {
        const { key } = await make();
        const declined = await call(db, "apply_for_loan", key, { amount_cents: 1000, term_days: 7, purpose: "Buy tools", ...extra });
        expect(declined.envelope.reason_codes, label).toEqual(expected);
        const adverse = (declined.envelope.data as Data).adverse_action as Data;
        expect(adverse.reasons, label).toEqual(expected.map((code) => ({ code, text: REASON_TEXT[code] })));
        expect(adverse.notice, label).toBe(ADVERSE_ACTION_NOTICE);
      }
      // sanctions_hit
      const { agentId, key } = await createTestAgent(db, worldId, "s@example.com");
      await db.update(agents).set({ name: "Sanctioned Bot" }).where(eq(agents.id, agentId));
      const hit = await call(db, "apply_for_loan", key, { amount_cents: 1000, term_days: 7, purpose: "Buy tools" });
      expect(((hit.envelope.data as Data).adverse_action as Data).reasons).toEqual([
        { code: "sanctions_hit", text: REASON_TEXT.sanctions_hit },
      ]);
      const stored = await db
        .select()
        .from(applications)
        .where(and(eq(applications.agentId, agentId), eq(applications.decision, "declined")));
      expect(stored[0]!.adverseAction).toMatchObject({ reasons: [{ code: "sanctions_hit" }] });
    });
  });
});
