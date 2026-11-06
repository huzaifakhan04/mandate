/**
 * P4 Task 4 — collections on the owner dashboard: delinquency on the loan
 * summary, the owner's notices (read state separate from the agent's
 * ack), the guarantee owed, "limit increased" events from score_history,
 * and the private world page's ladder view.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Db } from "@/server/db/client";
import { principals } from "@/server/db/schema";
import { createTestDb } from "@/server/db/testing";
import { ackNotices, unreadNotices } from "@/server/services/collections";
import {
  agentDetail,
  guaranteesOwed,
  limitIncreaseEvents,
  markOwnerNoticesRead,
  ownerDashboard,
  ownerNotices,
} from "@/server/services/dashboard";
import { advancePrivateWorld, nextLadderStep, privateWorldView } from "@/server/services/privateWorlds";
import { createWorld } from "@/server/services/worlds";

import { call, createTestAgent, fundPool, type Data } from "../../helpers/world";

async function principal(db: Db, email: string) {
  const [row] = await db
    .insert(principals)
    .values({ email, name: email.split("@")[0]!, entityType: "individual", verifiedAt: new Date() })
    .returning();
  return row!.id;
}

/** A private world owned by `ownerId`, a funded pool, and the owner's agent with a 25000 / 14-day loan. */
async function lateLoanWorld(db: Db) {
  const ownerId = await principal(db, "owner@example.com");
  const { worldId } = await createWorld(db, { name: "Sandbox", ownerPrincipalId: ownerId, railMode: "sim", kind: "private" });
  await fundPool(db, worldId, 30000, "l1@example.com");
  const borrower = await createTestAgent(db, worldId, "borrower@example.com", { principalId: ownerId });
  const applied = await call(db, "apply_for_loan", borrower.key, { amount_cents: 25000, term_days: 14, purpose: "Working capital" });
  expect(applied.envelope.status).toBe("OFFERED");
  const offer = applied.envelope.data as Data;
  const accepted = await call(db, "accept_offer", borrower.key, { offer_id: offer.offer_id, disclosure_hash: offer.disclosure_hash });
  expect(accepted.envelope.status).toBe("ACTIVE");
  return { ownerId, worldId, ...borrower, loanId: (accepted.envelope.data as Data).loan_id as string };
}

describe("collections on the owner dashboard (P4 Task 4)", () => {
  let db: Db;

  beforeEach(async () => {
    process.env.API_KEY_PEPPER = "test-pepper";
    db = await createTestDb();
  });

  afterEach(() => {
    delete process.env.API_KEY_PEPPER;
  });

  it("late: the card shows days late, late fee and what settles it; the world page shows the due day and ladder step", async () => {
    const w = await lateLoanWorld(db);
    const before = await privateWorldView(db, w.ownerId, w.worldId);
    expect(before!.ownerLoans).toHaveLength(1);
    expect(before!.ownerLoans[0]).toMatchObject({ dueDay: 14, step: null, daysLate: 0, next: { step: "late", day: 15 } });

    for (const days of [7, 7, 2]) {
      await advancePrivateWorld(db, w.ownerId, w.worldId, days);
    }
    const dash = await ownerDashboard(db, w.ownerId, new Date(), { worldId: w.worldId });
    const loan = dash.agents[0]!.openLoan!;
    expect(loan.status).toBe("late");
    expect(loan.daysLate).toBe(2);
    expect(loan.delinquencyStep).toBe("late");
    expect(loan.lateFeesCents).toBe(500n);
    expect(loan.lateFeeOutstandingCents).toBe(500n);
    expect(loan.dueNowCents).toBe(loan.outstandingCents + 500n);

    const view = await privateWorldView(db, w.ownerId, w.worldId);
    expect(view!.ownerLoans[0]).toMatchObject({ status: "late", dueDay: 14, daysLate: 2, step: "late", next: { step: "penalty", day: 17 } });

    const detail = await agentDetail(db, w.ownerId, w.agentId);
    expect(detail!.events.map((e) => e.type)).toContain("loan.late");
  });

  it("owner notices: unread count, mark one / all read — separate from the agent's ack; scoped to the owner and the view", async () => {
    const w = await lateLoanWorld(db);
    for (const days of [7, 7, 2]) {
      await advancePrivateWorld(db, w.ownerId, w.worldId, days);
    }
    let notices = await ownerNotices(db, w.ownerId, { worldId: w.worldId });
    expect(notices.unread).toBe(1);
    expect(notices.notices[0]).toMatchObject({ kind: "late", agentId: w.agentId, loanId: w.loanId, ownerReadAt: null });
    // The main view doesn't show a private world's notices.
    expect((await ownerNotices(db, w.ownerId)).notices).toHaveLength(0);

    // The agent acks: the owner's state is untouched.
    expect(await ackNotices(db, w.worldId, w.agentId, null, new Date())).toBe(1);
    expect((await ownerNotices(db, w.ownerId, { worldId: w.worldId })).unread).toBe(1);

    // Another principal can't read or mark them.
    const stranger = await principal(db, "stranger@example.com");
    expect((await ownerNotices(db, stranger, { worldId: w.worldId })).notices).toHaveLength(0);
    expect(await markOwnerNoticesRead(db, stranger, { worldId: w.worldId })).toBe(0);

    await advancePrivateWorld(db, w.ownerId, w.worldId, 2); // +4: penalty notice
    notices = await ownerNotices(db, w.ownerId, { worldId: w.worldId });
    expect(notices.unread).toBe(2);
    const penalty = notices.notices.find((n) => n.kind === "penalty")!;
    expect(await markOwnerNoticesRead(db, w.ownerId, { worldId: w.worldId, noticeId: penalty.id })).toBe(1);
    expect((await ownerNotices(db, w.ownerId, { worldId: w.worldId })).unread).toBe(1);
    // The owner reading it doesn't ack it for the agent.
    expect((await unreadNotices(db, w.worldId, w.agentId)).map((n) => n.kind)).toEqual(["penalty"]);

    expect(await markOwnerNoticesRead(db, w.ownerId, { worldId: w.worldId })).toBe(1);
    expect((await ownerNotices(db, w.ownerId, { worldId: w.worldId })).unread).toBe(0);
    expect(await markOwnerNoticesRead(db, w.ownerId, { worldId: w.worldId })).toBe(0);
  });

  it("charged off: the guarantee owed (sim approve page in a private world), recoverable on the card, ladder events in the drawer", async () => {
    const w = await lateLoanWorld(db);
    for (const days of [7, 7, 7, 7]) {
      await advancePrivateWorld(db, w.ownerId, w.worldId, days);
    }
    const dash = await ownerDashboard(db, w.ownerId, new Date(), { worldId: w.worldId });
    const loan = dash.agents[0]!.openLoan!;
    expect(loan.status).toBe("charged_off");
    expect(loan.chargeOff!.recoverableCents).toBe(loan.chargeOff!.writtenOffCents);
    expect(loan.dueNowCents).toBe(loan.chargeOff!.recoverableCents);
    const owed = guaranteesOwed(dash.agents);
    expect(owed).toHaveLength(1);
    expect(owed[0]).toMatchObject({ agentId: w.agentId, loanId: w.loanId, owedCents: loan.chargeOff!.writtenOffCents });
    expect(owed[0]!.link!.status).toBe("open");
    expect(owed[0]!.link!.approveUrl).toContain(`/dashboard/worlds/${w.worldId}/checkouts/`);

    const kinds = (await ownerNotices(db, w.ownerId, { worldId: w.worldId })).notices.map((n) => n.kind);
    expect(kinds).toEqual(["charged_off", "substandard", "penalty", "late"]);
    const types = (await agentDetail(db, w.ownerId, w.agentId))!.events.map((e) => e.type);
    for (const type of ["loan.late", "loan.penalty_started", "loan.substandard", "agent.restricted", "loan.charged_off"]) {
      expect(types).toContain(type);
    }
    const view = await privateWorldView(db, w.ownerId, w.worldId);
    expect(view!.ownerLoans[0]).toMatchObject({ status: "charged_off", step: "charged_off", next: null });
  });

  it("limitIncreaseEvents: an event each time the grade improves (ordered by sim time), none for the same or a worse grade", () => {
    const t = (d: number) => new Date(Date.UTC(2026, 0, 1 + d));
    const events = limitIncreaseEvents([
      { id: "r3", grade: "C", simAt: t(3), createdAt: t(3) },
      { id: "r1", grade: "D", simAt: t(1), createdAt: t(1) },
      { id: "r2", grade: "D", simAt: t(2), createdAt: t(2) },
      { id: "r4", grade: null, simAt: t(4), createdAt: t(4) },
      { id: "r5", grade: "D", simAt: t(5), createdAt: t(5) },
      { id: "r6", grade: "B", simAt: null, createdAt: t(6) },
    ]);
    expect(events).toEqual([
      {
        id: "limit-r3",
        type: "credit.limit_increased",
        occurredSimAt: t(3),
        payload: { from_grade: "D", to_grade: "C", from_limit_cents: 10000, limit_cents: 20000 },
      },
      {
        id: "limit-r6",
        type: "credit.limit_increased",
        occurredSimAt: t(6),
        payload: { from_grade: "D", to_grade: "B", from_limit_cents: 10000, limit_cents: 30000 },
      },
    ]);
  });

  it("nextLadderStep: the next step after the applied one, none once charged off or settled", () => {
    expect(nextLadderStep("active", null, 7)).toEqual({ step: "late", day: 8 });
    expect(nextLadderStep("late", "late", 7)).toEqual({ step: "penalty", day: 10 });
    expect(nextLadderStep("late", "penalty", 7)).toEqual({ step: "substandard", day: 14 });
    expect(nextLadderStep("substandard", "substandard", 7)).toEqual({ step: "charged_off", day: 17 });
    expect(nextLadderStep("charged_off", "charged_off", 7)).toBeNull();
    expect(nextLadderStep("repaid", "late", 7)).toBeNull();
  });
});
