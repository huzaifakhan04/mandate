/**
 * P3 Task 1: `scoreAgent` gathers the score facts from the database and
 * `recordScore` persists them (credit_scores + score_history). Golden
 * vectors per journey, plus Review Focus 3 (sub-1000 loans never build
 * history; on-time history caps at 35).
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getSimNow } from "@/server/clock/clock";
import type { Db } from "@/server/db/client";
import { agents, applications, creditScores, events, loans, offers, scoreHistory } from "@/server/db/schema";
import { createTestDb } from "@/server/db/testing";
import { recordScore, scoreAgent } from "@/server/services/credit";

import { upgradeToTier2 } from "../../helpers/signing";
import { call, createSimWorld, createTestAgent, type Data } from "../../helpers/world";

const DAY_MS = 86_400_000;

describe("scoreAgent / recordScore (P3 Task 1)", () => {
  let db: Db;
  let worldId: string;
  let simNow: Date;

  beforeEach(async () => {
    vi.stubEnv("SESSION_SECRET", "unit-test-session-secret-0123456789abcdef");
    vi.stubEnv("API_KEY_PEPPER", "test-pepper");
    db = await createTestDb();
    worldId = await createSimWorld(db);
    simNow = await getSimNow(db, worldId);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function unclaimedAgent(registeredSimAt: Date | null = simNow): Promise<string> {
    const [agent] = await db
      .insert(agents)
      .values({
        worldId,
        name: "Fresh",
        operator: "op",
        model: "m",
        codeManifestHash: "x",
        status: "active",
        payoutReceiver: "fresh@example.com",
        payoutReceiverType: "email",
        registeredSimAt,
      })
      .returning();
    return agent!.id;
  }

  /** Inserts an application → offer → loan; `repaidSimAt` adds the `loan.repaid` event. */
  async function insertLoan(
    agentId: string,
    loan: {
      principalCents: bigint;
      status: string;
      dueSimAt: Date;
      repaidSimAt?: Date;
      outstandingCents?: bigint;
      chargedOffAt?: Date;
    },
  ): Promise<string> {
    const [app] = await db
      .insert(applications)
      .values({ worldId, agentId, amountCents: loan.principalCents, termDays: 7, purpose: "test" })
      .returning();
    const [offer] = await db
      .insert(offers)
      .values({
        worldId,
        applicationId: app!.id,
        principalCents: loan.principalCents,
        feeCents: 10n,
        aprBps: 100,
        termDays: 7,
        dueSimAt: loan.dueSimAt,
        disclosureHash: "h",
        expiresSimAt: loan.dueSimAt,
        status: "accepted",
      })
      .returning();
    const [row] = await db
      .insert(loans)
      .values({
        worldId,
        offerId: offer!.id,
        agentId,
        principalCents: loan.principalCents,
        feeCents: 10n,
        outstandingCents: loan.outstandingCents ?? 0n,
        dueSimAt: loan.dueSimAt,
        status: loan.status,
        chargedOffAt: loan.chargedOffAt ?? null,
      })
      .returning();
    if (loan.repaidSimAt) {
      await db.insert(events).values({
        worldId,
        type: "loan.repaid",
        aggregateType: "loan",
        aggregateId: row!.id,
        occurredSimAt: loan.repaidSimAt,
      });
    }
    return row!.id;
  }

  async function onTime(agentId: string, count: number, principalCents = 1000n): Promise<void> {
    for (let i = 0; i < count; i += 1) {
      const due = new Date(simNow.getTime() - (i + 1) * DAY_MS);
      await insertLoan(agentId, {
        principalCents,
        status: "repaid",
        dueSimAt: due,
        repaidSimAt: new Date(due.getTime() - DAY_MS),
      });
    }
  }

  it("a fresh unclaimed agent scores 0 / E", async () => {
    const agentId = await unclaimedAgent();
    const result = await scoreAgent(db, worldId, agentId, simNow);
    expect(result.components).toEqual({ identity: 0, history: 0, tenure: 0, collateral: 0, exposure: 0 });
    expect(result).toMatchObject({ score: 0, grade: "E", limitCents: 0 });
    expect(result.factors).toHaveLength(3);
  });

  it("T1 (claimed + mandate) scores 20; T2 (doc + key) scores 35 / D", async () => {
    const { agentId, key } = await createTestAgent(db, worldId);
    expect((await scoreAgent(db, worldId, agentId, simNow)).components).toEqual({
      identity: 10,
      history: 0,
      tenure: 0,
      collateral: 0,
      exposure: 10,
    });
    await upgradeToTier2(db, agentId, key);
    const t2 = await scoreAgent(db, worldId, agentId, simNow);
    expect(t2.components.identity).toBe(25);
    expect(t2).toMatchObject({ score: 35, grade: "D", limitCents: 10000 });
  });

  it("tenure counts sim days since registration (falls back to created_at)", async () => {
    const agentId = await unclaimedAgent(new Date(simNow.getTime() - 9 * DAY_MS));
    expect((await scoreAgent(db, worldId, agentId, simNow)).components.tenure).toBe(3);
    const legacy = await unclaimedAgent(null);
    const later = new Date(Date.now() + 31 * DAY_MS);
    expect((await scoreAgent(db, worldId, legacy, later)).components.tenure).toBe(10);
  });

  it("3 on-time repaid loans ≥ 1000 cents give 21 history points", async () => {
    const { agentId } = await createTestAgent(db, worldId);
    await onTime(agentId, 3);
    const result = await scoreAgent(db, worldId, agentId, simNow);
    expect(result.components.history).toBe(21);
    expect(result.score).toBe(41);
    expect(result.factors.join(" | ")).toContain("3 on-time repaid loans (21/35)");
  });

  it("a loan repaid after its due date is late (−15), not on time", async () => {
    const { agentId } = await createTestAgent(db, worldId);
    await onTime(agentId, 3);
    const due = new Date(simNow.getTime() - 10 * DAY_MS);
    await insertLoan(agentId, { principalCents: 5000n, status: "repaid", dueSimAt: due, repaidSimAt: simNow });
    expect((await scoreAgent(db, worldId, agentId, simNow)).components.history).toBe(21 - 15);
  });

  it("a charged-off loan wipes history", async () => {
    const { agentId } = await createTestAgent(db, worldId);
    await onTime(agentId, 4);
    await insertLoan(agentId, { principalCents: 5000n, status: "charged_off", dueSimAt: simNow, chargedOffAt: simNow });
    expect((await scoreAgent(db, worldId, agentId, simNow)).components.history).toBe(0);
  });

  describe("Review Focus 3 — score gaming", () => {
    it("sub-1000-cent loans never count, however many are repaid on time", async () => {
      const { agentId } = await createTestAgent(db, worldId);
      await onTime(agentId, 8, 999n);
      expect((await scoreAgent(db, worldId, agentId, simNow)).components.history).toBe(0);
    });

    it("on-time history caps at 35", async () => {
      const { agentId } = await createTestAgent(db, worldId);
      await onTime(agentId, 8);
      expect((await scoreAgent(db, worldId, agentId, simNow)).components.history).toBe(35);
    });
  });

  it("exposure: 0 → 10, 50% of max_total_owed → 5, 100% → 0", async () => {
    const { agentId } = await createTestAgent(db, worldId, "e@example.com", { limits: { maxTotalOwedCents: 20000n } });
    expect((await scoreAgent(db, worldId, agentId, simNow)).components.exposure).toBe(10);
    const loanId = await insertLoan(agentId, {
      principalCents: 10000n,
      status: "active",
      dueSimAt: new Date(simNow.getTime() + 7 * DAY_MS),
      outstandingCents: 10000n,
    });
    expect((await scoreAgent(db, worldId, agentId, simNow)).components.exposure).toBe(5);
    await db.update(loans).set({ outstandingCents: 20000n }).where(eq(loans.id, loanId));
    expect((await scoreAgent(db, worldId, agentId, simNow)).components.exposure).toBe(0);
  });

  it("collateral only with an application's invoice coverage: 1.5 → 20, 1.1 → 12, none → 0", async () => {
    const { agentId } = await createTestAgent(db, worldId);
    expect((await scoreAgent(db, worldId, agentId, simNow)).components.collateral).toBe(0);
    expect((await scoreAgent(db, worldId, agentId, simNow, { invoiceCoverageBps: 15000 })).components.collateral).toBe(20);
    expect((await scoreAgent(db, worldId, agentId, simNow, { invoiceCoverageBps: 11000 })).components.collateral).toBe(12);
  });

  it("an agent of another world is not found", async () => {
    const otherWorld = await createSimWorld(db);
    const { agentId } = await createTestAgent(db, otherWorld);
    await expect(scoreAgent(db, worldId, agentId, simNow)).rejects.toThrow();
  });

  it("recordScore keeps one current row per agent and appends history with the delta", async () => {
    const { agentId, principalId } = await createTestAgent(db, worldId);
    const first = await scoreAgent(db, worldId, agentId, simNow);
    await recordScore(db, worldId, agentId, first, { simNow });
    await onTime(agentId, 2);
    const second = await scoreAgent(db, worldId, agentId, simNow);
    const [app] = await db
      .insert(applications)
      .values({ worldId, agentId, amountCents: 5000n, termDays: 7, purpose: "x" })
      .returning();
    await recordScore(db, worldId, agentId, second, { simNow, applicationId: app!.id });

    const current = await db.select().from(creditScores).where(eq(creditScores.subjectId, agentId));
    expect(current).toHaveLength(1);
    expect(current[0]).toMatchObject({ subjectType: "agent", score: 34, grade: "E", limitCents: 0n });
    expect(current[0]!.components).toEqual(second.components);
    expect(current[0]!.factors).toEqual(second.factors);

    const history = await db.select().from(scoreHistory).where(eq(scoreHistory.subjectId, agentId));
    const sorted = history.sort((a, b) => (a.score ?? 0) - (b.score ?? 0));
    expect(sorted.map((row) => [row.score, row.delta, row.reasonCode])).toEqual([
      [20, 20, "application"],
      [34, 14, "application"],
    ]);
    expect(sorted[1]).toMatchObject({ grade: "E", applicationId: app!.id });
    expect(sorted[1]!.components).toEqual(second.components);
    expect(principalId).toBeTruthy();
  });

  describe("surfaced in get_status and check_eligibility", () => {
    it("get_status shows score, grade, limit, components and the top 3 factors (no collateral)", async () => {
      const { key } = await createTestAgent(db, worldId);
      const result = await call(db, "get_status", key, {});
      expect(result.envelope.status).toBe("OK");
      const credit = (result.envelope.data as Data).credit as Data;
      expect(credit).toMatchObject({
        score: 20,
        grade: "E",
        limit_cents: 0,
        components: { identity: 10, history: 0, tenure: 0, collateral: 0, exposure: 10 },
      });
      expect(credit.factors).toHaveLength(3);
      expect(result.envelope.summary).toContain("Credit Score 20 (grade E)");
    });

    it("check_eligibility scores collateral only from amount + invoice_amount_cents, and never persists", async () => {
      const { key, agentId } = await createTestAgent(db, worldId);
      const plain = await call(db, "check_eligibility", key, { amount_cents: 10000, term_days: 7 });
      expect(((plain.envelope.data as Data).credit as Data).components).toMatchObject({ collateral: 0 });

      const covered = await call(db, "check_eligibility", key, {
        amount_cents: 10000,
        term_days: 7,
        invoice_amount_cents: 15000,
      });
      const credit = (covered.envelope.data as Data).credit as Data;
      expect(credit).toMatchObject({ score: 40, grade: "D", limit_cents: 10000 });
      expect(credit.components).toMatchObject({ collateral: 20 });

      const thin = await call(db, "check_eligibility", key, {
        amount_cents: 10000,
        term_days: 7,
        invoice_amount_cents: 11000,
      });
      expect(((thin.envelope.data as Data).credit as Data).components).toMatchObject({ collateral: 12 });

      expect(await db.select().from(creditScores).where(eq(creditScores.subjectId, agentId))).toHaveLength(0);
      expect(await db.select().from(scoreHistory).where(eq(scoreHistory.subjectId, agentId))).toHaveLength(0);
    });

    it("an unclaimed agent still sees its score in check_eligibility", async () => {
      const { key, agentId } = await createTestAgent(db, worldId);
      await db.update(agents).set({ principalId: null, claimedAt: null }).where(eq(agents.id, agentId));
      const result = await call(db, "check_eligibility", key, { amount_cents: 5000, term_days: 7 });
      expect(((result.envelope.data as Data).credit as Data).score).toBe(0);
    });
  });
});
