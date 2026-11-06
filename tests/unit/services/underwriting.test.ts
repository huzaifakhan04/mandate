/**
 * P3 Task 2: `apply_for_loan` / `check_eligibility` run the rules pipeline
 * (domain/rules.ts) with risk-based pricing v2 (domain/pricingV2.ts), and
 * each application records its score (credit_scores + score_history).
 * Agents here use their REAL score facts unless a test overrides them.
 */
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Db } from "@/server/db/client";
import { agents, applications, creditScores, events, offers, scoreHistory } from "@/server/db/schema";
import { createTestDb } from "@/server/db/testing";
import { disclosureHash } from "@/server/domain/disclosure";
import { REASON_TEXT } from "@/server/domain/reasons";
import { __setScoreFactsOverrideForTests } from "@/server/services/credit";
import { APR_FLAG_TEXT, RIGHT_TO_STATEMENT_TEXT } from "@/server/services/loans";

import { ESTABLISHED_CREDIT } from "../../helpers/kya";
import { call, createSimWorld, createTestAgent, type Data, fundPool } from "../../helpers/world";

const REAL = { credit: "real" } as const;
const invoice = (amountCents: number) => ({
  invoice: { client_email: "client@example.com", amount_cents: amountCents, due_in_days: 7, description: "Work" },
});

describe("underwriting: rules pipeline + pricing v2 in apply_for_loan / check_eligibility (P3 Task 2)", () => {
  let db: Db;
  let worldId: string;

  beforeEach(async () => {
    vi.stubEnv("SESSION_SECRET", "unit-test-session-secret-0123456789abcdef");
    vi.stubEnv("API_KEY_PEPPER", "test-pepper");
    db = await createTestDb();
    worldId = await createSimWorld(db);
    await fundPool(db, worldId, 60000);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function apply(key: string, amountCents: number, termDays: number, extra: Data = {}) {
    return call(db, "apply_for_loan", key, { amount_cents: amountCents, term_days: termDays, purpose: "Buy tools", ...extra });
  }

  it("a newcomer's unsecured first loan → DECLINED insufficient_credit_history; the score is recorded on the application", async () => {
    const { agentId, key } = await createTestAgent(db, worldId, "new@example.com", REAL);
    const declined = await apply(key, 1000, 7);
    expect(declined.envelope).toMatchObject({ status: "DECLINED", reason_codes: ["insufficient_credit_history"] });
    const applicationId = (declined.envelope.data as Data).application_id as string;

    const [application] = await db.select().from(applications).where(eq(applications.id, applicationId));
    expect(application).toMatchObject({ decision: "declined", reasonCodes: ["insufficient_credit_history"] });
    // T1 newcomer: identity 10 + exposure 10 = 20 → E.
    const [current] = await db.select().from(creditScores).where(eq(creditScores.subjectId, agentId));
    expect(current).toMatchObject({ score: 20, grade: "E", limitCents: 0n });
    const history = await db.select().from(scoreHistory).where(eq(scoreHistory.subjectId, agentId));
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ applicationId, score: 20, grade: "E", reasonCode: "application" });
    const [declinedEvent] = await db
      .select()
      .from(events)
      .where(and(eq(events.aggregateId, applicationId), eq(events.type, "loan.declined")));
    expect(declinedEvent?.payload).toMatchObject({ primary: "insufficient_credit_history", grade: "E", score: 20 });
    expect(await db.select().from(offers).where(eq(offers.applicationId, applicationId))).toHaveLength(0);
  });

  it("Ruling P3-A: a newcomer with a 1.5× invoice is grade D → OFFERED at the v2 price, disclosure v2 hashed", async () => {
    const { agentId, key } = await createTestAgent(db, worldId, "new@example.com", REAL);
    const offered = await apply(key, 1000, 7, invoice(1500));
    expect(offered.envelope.status).toBe("OFFERED");
    const data = offered.envelope.data as Data;
    const disclosure = data.disclosure as Data;
    // 20 + collateral 20 = 40 → D. 8 + 420 + 50 + 96 = 574 bps → fee 58; APR 30243 (> 3600 → flagged).
    expect(disclosure).toMatchObject({
      funding_provided_cents: 1000,
      fee_cents: 58,
      total_cost_cents: 58,
      total_repayment_cents: 1058,
      estimated_apr_bps: 30243,
      credit_score: 40,
      credit_grade: "D",
      rate_components: { cost_of_funds_bps: 8, expected_loss_bps: 420, ops_bps: 50, capital_bps: 96, total_bps: 574 },
      apr_flag: APR_FLAG_TEXT,
      right_to_statement: RIGHT_TO_STATEMENT_TEXT,
    });
    expect(data.disclosure_hash).toBe(disclosureHash(disclosure));
    expect(disclosureHash({ ...disclosure, credit_score: 41 })).not.toBe(data.disclosure_hash);
    expect(disclosureHash({ ...disclosure, apr_flag: "edited" })).not.toBe(data.disclosure_hash);

    const [offer] = await db.select().from(offers).where(eq(offers.id, data.offer_id as string));
    expect(offer).toMatchObject({ feeCents: 58n, aprBps: 30243 });
    const [history] = await db.select().from(scoreHistory).where(eq(scoreHistory.subjectId, agentId));
    expect(history).toMatchObject({
      applicationId: data.application_id,
      score: 40,
      grade: "D",
      components: { identity: 10, history: 0, tenure: 0, collateral: 20, exposure: 10 },
    });
  });

  it("grade D above 5000 → DECLINED manual_review_declined (deterministic; no manual approval in P3)", async () => {
    const { key } = await createTestAgent(db, worldId, "new@example.com", REAL);
    const declined = await apply(key, 6000, 7, invoice(9000));
    expect(declined.envelope).toMatchObject({ status: "DECLINED", reason_codes: ["manual_review_declined"] });
    // At the D limit's edge 5000 it is offered.
    const ok = await apply(key, 5000, 7, invoice(7500));
    expect(ok.envelope.status).toBe("OFFERED");
  });

  it("a newcomer's invoice below 1.1× → insufficient_collateral (and still grade E)", async () => {
    const { key } = await createTestAgent(db, worldId, "new@example.com", REAL);
    const declined = await apply(key, 1000, 7, invoice(1090));
    expect(declined.envelope).toMatchObject({
      status: "DECLINED",
      reason_codes: ["insufficient_credit_history", "insufficient_collateral"],
    });
  });

  it("the mandate's max_fee_bps caps the risk-based fee → mandate_fee (Review Focus 4, wired)", async () => {
    // Grade D without collateral (identity 25 + tenure 10 + exposure 10 = 45): 5000 for 30 days →
    // 33 + 720 + 50 + 96 = 899 bps → fee ceil(449.5) = 450 = 900 bps of the principal.
    const { agentId, key } = await createTestAgent(db, worldId, "d@example.com", { limits: { maxFeeBps: 899 } });
    __setScoreFactsOverrideForTests(agentId, { ...ESTABLISHED_CREDIT, onTimeRepaidLoans: 0 });
    const declined = await apply(key, 5000, 30);
    expect(declined.envelope).toMatchObject({ status: "DECLINED", reason_codes: ["mandate_fee"] });

    const quote = (await call(db, "check_eligibility", key, { amount_cents: 5000, term_days: 30 })).envelope.data as Data;
    expect(quote).toMatchObject({
      eligible: false,
      reasons: ["mandate_fee"],
      effective_cap_cents: 10000,
      quote: { fee_cents: 450, grade: "D", score: 45, apr_flag: APR_FLAG_TEXT },
    });
  });

  it("sanctions stub: the agent's name or operator matching SANCTIONS_STUB → sanctions_hit", async () => {
    const { agentId, key } = await createTestAgent(db, worldId, "s@example.com");
    await db.update(agents).set({ name: "Totally Sanctioned Agent" }).where(eq(agents.id, agentId));
    expect((await apply(key, 1000, 7)).envelope).toMatchObject({ status: "DECLINED", reason_codes: ["sanctions_hit"] });

    // A custom list replaces the default (case-insensitive, operator matched too).
    vi.stubEnv("SANCTIONS_STUB", "Test-Operator");
    const other = await createTestAgent(db, worldId, "o@example.com");
    expect((await apply(other.key, 1000, 7)).envelope).toMatchObject({ reason_codes: ["sanctions_hit"] });
    expect(REASON_TEXT.sanctions_hit).toMatch(/sanctions/);
  });

  it("check_eligibility: the quote carries grade, score and rate components; grade E has no quote", async () => {
    const { key } = await createTestAgent(db, worldId, "new@example.com", REAL);
    const unsecured = (await call(db, "check_eligibility", key, { amount_cents: 1000, term_days: 7 })).envelope;
    expect(unsecured.data).toMatchObject({
      eligible: false,
      reasons: ["insufficient_credit_history"],
      effective_cap_cents: 0,
      quote: null,
      credit: { score: 20, grade: "E" },
    });

    const backed = (
      await call(db, "check_eligibility", key, { amount_cents: 1000, term_days: 7, invoice_amount_cents: 1500 })
    ).envelope;
    expect(backed.data).toMatchObject({
      eligible: true,
      reasons: [],
      effective_cap_cents: 10000, // min(D 10000, T1 25000, mandate 50000)
      quote: {
        fee_cents: 58,
        apr_bps: 30243,
        total_cents: 1058,
        grade: "D",
        score: 40,
        rate_components: { cost_of_funds_bps: 8, expected_loss_bps: 420, ops_bps: 50, capital_bps: 96, total_bps: 574 },
        apr_flag: APR_FLAG_TEXT,
      },
      credit: { score: 40, grade: "D" },
    });
    expect(backed.summary).toContain("grade D");
    // Read-only: nothing persisted.
    expect(await db.select().from(scoreHistory)).toHaveLength(0);
  });

  it("offer terms are fixed at offer time: accept_offer doesn't re-check the grade", async () => {
    const { agentId, key } = await createTestAgent(db, worldId, "a@example.com");
    const offer = (await apply(key, 10000, 7)).envelope.data as Data;
    // The agent's credit collapses to grade E before it accepts.
    __setScoreFactsOverrideForTests(agentId, null);
    const accepted = await call(db, "accept_offer", key, { offer_id: offer.offer_id, disclosure_hash: offer.disclosure_hash });
    expect(accepted.envelope.status).toBe("ACTIVE");
  });
});
