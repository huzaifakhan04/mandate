/**
 * P7 (Bryntum) — the owner Timeline read model + its owner-only endpoint,
 * and the console Calendar read model + endpoint (same world/PII rules as
 * the console snapshot).
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getSimNow } from "@/server/clock/clock";
import { createConsoleHandlers } from "@/server/auth/consoleRoutes";
import { SESSION_COOKIE_NAME, createSession } from "@/server/auth/session";
import { createTimelineHandler } from "@/server/auth/timelineRoutes";
import type { Db } from "@/server/db/client";
import { loans, principals } from "@/server/db/schema";
import { createTestDb } from "@/server/db/testing";
import { addDays, dayStart, simDate } from "@/server/domain/installments";
import { runTick } from "@/server/jobs/tick";
import { simApprove } from "@/server/rail/simHandler";
import { consoleSnapshot } from "@/server/services/console";
import { consoleCalendar, ownerTimeline, type OwnerTimeline } from "@/server/services/timeline";
import { createWorld } from "@/server/services/worlds";

import { call, createTestAgent, fundPool, type Data } from "../../helpers/world";

describe("timeline + calendar (P7)", () => {
  let db: Db;

  beforeEach(async () => {
    process.env.API_KEY_PEPPER = "test-pepper";
    db = await createTestDb();
  });

  afterEach(() => {
    delete process.env.API_KEY_PEPPER;
  });

  async function scenario() {
    const worldId = (await createWorld(db, { name: "Timeline", ownerPrincipalId: null, railMode: "sim" })).worldId;
    const lender = await fundPool(db, worldId, 30000, "lender.secret@example.com");
    const borrower = await createTestAgent(db, worldId, "borrower.secret@example.com");
    const applied = await call(db, "apply_for_loan", borrower.key, { amount_cents: 25000, term_days: 14, purpose: "Working capital" });
    const offer = applied.envelope.data as Data;
    const accepted = await call(db, "accept_offer", borrower.key, { offer_id: offer.offer_id, disclosure_hash: offer.disclosure_hash });
    const loanId = (accepted.envelope.data as Data).loan_id as string;
    const today = dayStart(await getSimNow(db, worldId));
    const planned = await call(db, "plan_repayments", borrower.key, {
      installments: [
        { date: simDate(addDays(today, 3)), amount_cents: 12000 },
        { date: simDate(addDays(today, 9)), amount_cents: 13333 },
      ],
    });
    expect(planned.envelope.status).toBe("PLANNED");
    const started = await call(db, "repay_loan", borrower.key, { loan_id: loanId, amount_cents: 12000 });
    const checkoutId = (started.envelope.data as Data).checkout_id as string;
    await simApprove(db, checkoutId);
    await call(db, "confirm_checkout", borrower.key, { checkout_id: checkoutId });
    await runTick(db);
    return { worldId, lender, borrower, loanId };
  }

  function request(path: string, principalId?: string): Request {
    const headers: Record<string, string> = { "x-forwarded-for": "203.0.113.7" };
    if (principalId) {
      headers.cookie = `${SESSION_COOKIE_NAME}=${encodeURIComponent(createSession(principalId))}`;
    }
    return new Request(new URL(path, "https://mandate.test"), { headers });
  }

  it("ownerTimeline: the owner's agents as rows, the loan bar with its installments (paid/planned) and the repayment", async () => {
    const s = await scenario();
    const timeline = await ownerTimeline(db, s.borrower.principalId);
    expect(timeline.resources.map((r) => r.id)).toEqual([s.borrower.agentId]);
    const kinds = timeline.events.map((e) => `${e.kind}:${e.state}`).sort();
    expect(kinds).toEqual(["installment:paid", "installment:planned", "loan:active", "repayment:repayment"]);
    const loan = timeline.events.find((e) => e.kind === "loan")!;
    expect(new Date(loan.endDate).getTime()).toBeGreaterThan(new Date(loan.startDate).getTime());
    expect(timeline.events.every((e) => e.resourceId === s.borrower.agentId)).toBe(true);
    expect(JSON.stringify(timeline)).not.toContain("@");
  });

  it("timeline endpoint: 401 without a session; only the caller's own agents; a foreign or junk world → 404", async () => {
    const s = await scenario();
    const handler = createTimelineHandler({ getDb: async () => db });

    expect((await handler(request("/api/dashboard/timeline"))).status).toBe(401);

    const mine = await handler(request("/api/dashboard/timeline", s.borrower.principalId));
    expect(mine.status).toBe(200);
    expect(mine.headers.get("cache-control")).toBe("no-store");
    const body = (await mine.json()) as { timeline: OwnerTimeline };
    expect(body.timeline.resources.map((r) => r.id)).toEqual([s.borrower.agentId]);

    // The lender's owner sees only the lender — never the borrower's loan.
    const theirs = (await (await handler(request("/api/dashboard/timeline", s.lender.principalId))).json()) as { timeline: OwnerTimeline };
    expect(theirs.timeline.resources.map((r) => r.id)).toEqual([s.lender.agentId]);
    expect(theirs.timeline.events).toEqual([]);

    const [other] = await db
      .insert(principals)
      .values({ email: "other.owner@example.com", name: "Other", entityType: "individual", verifiedAt: new Date() })
      .returning();
    const privateWorld = (
      await createWorld(db, { name: "Theirs", ownerPrincipalId: other!.id, railMode: "sim", kind: "private" })
    ).worldId;
    expect((await handler(request(`/api/dashboard/timeline?world=${privateWorld}`, s.borrower.principalId))).status).toBe(404);
    expect((await handler(request("/api/dashboard/timeline?world=junk", s.borrower.principalId))).status).toBe(404);
    const owned = await handler(request(`/api/dashboard/timeline?world=${privateWorld}`, other!.id));
    expect(owned.status).toBe(200);
    expect(((await owned.json()) as { timeline: OwnerTimeline }).timeline.world).toEqual({ id: privateWorld, kind: "private" });
  });

  it("consoleCalendar: due dates and installments for the world, with no emails", async () => {
    const s = await scenario();
    const calendar = await consoleCalendar(db, { id: s.worldId, name: "Timeline", kind: "main", rail: "sim" });
    const calendars = new Set(calendar.events.map((e) => e.calendar));
    expect(calendars.has("due")).toBe(true);
    expect(calendar.events.filter((e) => e.calendar === "installment").map((e) => e.state).sort()).toEqual(["paid", "planned"]);
    for (const event of calendar.events) {
      expect(new Date(event.endDate).getTime()).toBeGreaterThanOrEqual(new Date(event.startDate).getTime());
    }
    const text = JSON.stringify(calendar);
    expect(text).not.toContain("@");
    expect(text).not.toContain("secret");
  });

  it("consoleCalendar: a repaid loan has no due event; the console Loans grid shows its priced grade", async () => {
    const s = await scenario();
    const world = { id: s.worldId, name: "Timeline", kind: "main" as const, rail: "sim" as const };
    expect((await consoleCalendar(db, world)).events.some((e) => e.id === `due:${s.loanId}`)).toBe(true);

    const snap = await consoleSnapshot(db, world);
    const row = snap.loans.find((l) => l.id === s.loanId)!;
    expect(row.grade).toMatch(/^[A-E]$/);

    const [loan] = await db.select().from(loans).where(eq(loans.id, s.loanId));
    const owed = Number(loan!.outstandingCents + loan!.lateFeeOutstandingCents);
    const started = await call(db, "repay_loan", s.borrower.key, { loan_id: s.loanId, amount_cents: owed });
    const checkoutId = (started.envelope.data as Data).checkout_id as string;
    await simApprove(db, checkoutId);
    await call(db, "confirm_checkout", s.borrower.key, { checkout_id: checkoutId });
    const [after] = await db.select().from(loans).where(eq(loans.id, s.loanId));
    expect(after!.status).toBe("repaid");

    const calendar = await consoleCalendar(db, world);
    expect(calendar.events.some((e) => e.id === `due:${s.loanId}`)).toBe(false);
    expect(calendar.events.some((e) => e.calendar === "installment")).toBe(true);
  });

  it("calendar endpoint: main for anyone, a private world for its owner only", async () => {
    const [owner] = await db
      .insert(principals)
      .values({ email: "cal.owner@example.com", name: "Owner", entityType: "individual", verifiedAt: new Date() })
      .returning();
    const worldId = (await createWorld(db, { name: "Cal", ownerPrincipalId: owner!.id, railMode: "sim", kind: "private" })).worldId;
    const handlers = createConsoleHandlers({ getDb: async () => db });
    const main = await handlers.calendar(request("/api/console/calendar"));
    expect(main.status).toBe(200);
    expect(((await main.json()) as { calendar: { world: { kind: string } } }).calendar.world.kind).toBe("main");
    expect((await handlers.calendar(request(`/api/console/calendar?world=${worldId}`))).status).toBe(404);
    expect((await handlers.calendar(request(`/api/console/calendar?world=${worldId}`, owner!.id))).status).toBe(200);
  });
});
