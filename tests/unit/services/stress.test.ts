/**
 * P5 Task 4 — stress scenarios (default wave, note run, rate spike) and
 * bots v2 (4 lenders that react to the real return, 6 borrowers with
 * seeded good / late / defaulter archetypes). The owner-only route checks
 * are in tests/unit/app/worlds.test.ts; the 60-day invariants run in
 * tests/unit/services/economyInvariants.test.ts.
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { borrowerArchetype } from "@/server/bots/borrowerBot";
import { lenderDayV2, lenderRealReturnBps, redeemableUnits } from "@/server/bots/lenderBot";
import { worldBots } from "@/server/bots/runner";
import { getSimDay } from "@/server/clock/clock";
import type { Db } from "@/server/db/client";
import { agents, economyState, events, loans, noteTransactions, principals, worlds } from "@/server/db/schema";
import { createTestDb } from "@/server/db/testing";
import { stepRates } from "@/server/domain/economy";
import { TREASURY_DEFAULTS } from "@/server/domain/treasury";
import { trialBalance } from "@/server/ledger/trialBalance";
import { advancePrivateWorld, createPrivateWorld, privateWorldView } from "@/server/services/privateWorlds";
import { DEFAULT_WAVE_LOAN_EVENT, recentStressEvents, triggerStressScenario } from "@/server/services/stress";
import { setTreasuryPolicy } from "@/server/services/treasury";
import { createWorld, ensureMainWorld } from "@/server/services/worlds";

describe("stress scenarios and bots v2 (P5 Task 4)", () => {
  let db: Db;
  let owner: string;

  beforeEach(async () => {
    vi.stubEnv("SESSION_SECRET", "unit-test-session-secret-0123456789abcdef");
    vi.stubEnv("API_KEY_PEPPER", "test-pepper");
    db = await createTestDb();
    const [row] = await db
      .insert(principals)
      .values({ paypalPayerId: "OWNER", email: "owner@example.com", name: "OWNER", entityType: "individual", verifiedAt: new Date() })
      .returning();
    owner = row!.id;
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function create(seed: string): Promise<string> {
    const created = await createPrivateWorld(db, owner, { name: "Stress", seed });
    if (created.outcome !== "created") throw new Error(created.outcome);
    await setTreasuryPolicy(db, created.worldId, { ...TREASURY_DEFAULTS });
    return created.worldId;
  }

  async function advance(worldId: string, days: number) {
    while (days > 0) {
      const step = Math.min(7, days);
      expect((await advancePrivateWorld(db, owner, worldId, step)).outcome).toBe("advanced");
      days -= step;
    }
  }

  async function economyRows(worldId: string) {
    return db.select().from(economyState).where(eq(economyState.worldId, worldId)).orderBy(asc(economyState.simDay));
  }

  /** The first seed (prefix-0, prefix-1, …) whose borrower bot `index` has `archetype`. */
  function seedWith(prefix: string, index: number, archetype: string): string {
    for (let i = 0; i < 500; i += 1) {
      if (borrowerArchetype(`${prefix}-${i}`, index) === archetype) return `${prefix}-${i}`;
    }
    throw new Error("no seed");
  }

  // ------------------------------------------------------------ scenarios

  it("Review Focus 5: not in the main world, not in another owner's world; an unknown scenario is refused; nothing recorded", async () => {
    const worldId = await create("rf5");
    const { worldId: mainId } = await ensureMainWorld(db);
    const plainMain = (await createWorld(db, { name: "Test main", ownerPrincipalId: owner, railMode: "sim" })).worldId;
    const [intruder] = await db
      .insert(principals)
      .values({ paypalPayerId: "X", email: "x@example.com", name: "X", entityType: "individual", verifiedAt: new Date() })
      .returning();
    expect(await triggerStressScenario(db, owner, mainId, "rate_spike")).toEqual({ outcome: "not_found" });
    expect(await triggerStressScenario(db, owner, plainMain, "default_wave")).toEqual({ outcome: "not_found" });
    expect(await triggerStressScenario(db, intruder!.id, worldId, "note_run")).toEqual({ outcome: "not_found" });
    expect(await triggerStressScenario(db, owner, worldId, "meteor")).toEqual({ outcome: "invalid" });
    expect((await db.select().from(events)).filter((event) => event.type.startsWith("stress."))).toEqual([]);
  });

  it("rate_spike: +500 bps on the next economy step (stored on that day's row), then the walk mean-reverts", async () => {
    const worldId = await create("spike-seed");
    await advance(worldId, 2);
    const triggered = await triggerStressScenario(db, owner, worldId, "rate_spike");
    expect(triggered).toMatchObject({ outcome: "triggered", simDay: 2, params: { bump_bps: 500, apply_sim_day: 3 } });
    const [event] = await db.select().from(events).where(and(eq(events.worldId, worldId), eq(events.type, "stress.rate_spike"))!);
    expect(event!.payload).toMatchObject({ scenario: "rate_spike", sim_day: 2, seed: "spike-seed", params: { bump_bps: 500, apply_sim_day: 3 } });

    await advance(worldId, 3);
    const rows = await economyRows(worldId);
    const rates = (row: (typeof rows)[number]) => ({
      baseRateBps: row.baseRateBps,
      inflationIndexBp: row.inflationIndexBp,
      inflationRateBps: row.inflationRateBps,
    });
    const day2 = rows.find((row) => row.simDay === 2)!;
    const day3 = rows.find((row) => row.simDay === 3)!;
    const day4 = rows.find((row) => row.simDay === 4)!;
    const walked = stepRates(rates(day2), "spike-seed", 3);
    expect(day3.baseRateBps).toBe(walked.baseRateBps + 500);
    expect(day3.inflationIndexBp).toBe(walked.inflationIndexBp);
    expect(day3.scenario).toBe("rate_spike");
    expect(day2.scenario).toBeNull();
    // Day 4 steps from day 3's spiked rate: mean reversion pulls it back down.
    expect(day4).toMatchObject({ baseRateBps: stepRates(rates(day3), "spike-seed", 4).baseRateBps, scenario: null });
    expect(day4.baseRateBps).toBeLessThan(day3.baseRateBps);

    // The spiked rate is the pool's cost of funds: lender bots see a real return above 2%.
    expect(await lenderRealReturnBps(db, worldId)).toBeGreaterThan(200);
    const view = await privateWorldView(db, owner, worldId);
    expect(view!.stressEvents).toEqual([expect.objectContaining({ scenario: "rate_spike", simDay: 2 })]);
  }, 60_000);

  it("default_wave: the next 3 borrower-bot loans are marked and never repaid — they reach charge-off; the 4th is unmarked", async () => {
    const worldId = await create("wave-seed");
    const triggered = await triggerStressScenario(db, owner, worldId, "default_wave");
    expect(triggered).toMatchObject({ outcome: "triggered", simDay: 0, params: { loans: 3 } });
    await advance(worldId, 42);

    const marks = await db.select().from(events).where(and(eq(events.worldId, worldId), eq(events.type, DEFAULT_WAVE_LOAN_EVENT))!);
    expect(marks).toHaveLength(3);
    const marked = await db.select().from(loans).where(inArray(loans.id, marks.map((mark) => mark.aggregateId)));
    expect(marked).toHaveLength(3);
    for (const loan of marked) {
      expect(loan.status).toBe("charged_off");
    }
    // They were the first three bot loans accepted after the trigger; later loans were repaid normally.
    const all = await db.select().from(loans).where(eq(loans.worldId, worldId)).orderBy(asc(loans.createdAt));
    expect(all.slice(0, 3).map((loan) => loan.id).sort()).toEqual(marked.map((loan) => loan.id).sort());
    expect(all.filter((loan) => loan.status === "repaid").length).toBeGreaterThan(0);
    const [view] = await recentStressEvents(db, worldId);
    expect(view).toMatchObject({ scenario: "default_wave", loansTaken: 3 });
    expect((await trialBalance(db, worldId)).totalCents).toBe(0n);
  }, 120_000);

  it("note_run: every lender bot asks to redeem all its notes (seeded order); what cash can't cover waits in the FIFO queue", async () => {
    const worldId = await create("run-seed");
    await advance(worldId, 4);
    const { lenders } = await worldBots(db, worldId);
    expect(lenders).toHaveLength(4);
    const triggered = await triggerStressScenario(db, owner, worldId, "note_run");
    if (triggered.outcome !== "triggered") throw new Error(triggered.outcome);
    const params = triggered.params as { order: string[]; requests: Array<{ bot: string; amount_cents: number; status: string; queue_position?: number }> };
    expect([...params.order].sort()).toEqual(lenders.map((lender) => lender.name).sort());
    expect(params.requests.length).toBe(4);
    for (const lender of lenders) {
      expect(await redeemableUnits(db, worldId, lender.id)).toBe(0n);
    }
    const queued = params.requests.filter((request) => request.status === "QUEUED");
    expect(queued.length).toBeGreaterThan(0);
    // Queue positions follow the request order.
    expect(queued.map((request) => request.queue_position)).toEqual(queued.map((_, i) => i + 1));
    // Paid ones came first (FIFO: nothing was paid once something queued).
    const firstQueued = params.requests.findIndex((request) => request.status === "QUEUED");
    expect(params.requests.slice(firstQueued).every((request) => request.status === "QUEUED")).toBe(true);

    // Same seed, same day → same order (seeded).
    const again = await create("run-seed");
    await advance(again, 4);
    const second = await triggerStressScenario(db, owner, again, "note_run");
    expect((second as unknown as { params: { order: string[] } }).params.order).toEqual(params.order);
    expect((await trialBalance(db, worldId)).totalCents).toBe(0n);
  }, 120_000);

  // ---------------------------------------------------------------- bots v2

  it("archetypes are seeded per world and bot: about 10% defaulters, 30% late payers, 60% good", () => {
    const counts = { good: 0, late: 0, defaulter: 0 };
    for (let i = 0; i < 2000; i += 1) {
      counts[borrowerArchetype(`seed-${i}`, i % 6)] += 1;
    }
    expect(counts.defaulter / 2000).toBeGreaterThan(0.07);
    expect(counts.defaulter / 2000).toBeLessThan(0.13);
    expect(counts.late / 2000).toBeGreaterThan(0.26);
    expect(counts.late / 2000).toBeLessThan(0.34);
    expect(borrowerArchetype("same", 3)).toBe(borrowerArchetype("same", 3));
  });

  it("a late payer repays everything owed (late fee included) 3 days after the due day with repay_loan", async () => {
    const seed = seedWith("late", 0, "late");
    const worldId = await create(seed);
    await advance(worldId, 35);
    const { borrowers } = await worldBots(db, worldId);
    const atlas = borrowers[0]!;
    const { anchorSim } = await getSimDay(db, worldId);
    const repaid = await db
      .select()
      .from(loans)
      .where(and(eq(loans.agentId, atlas.id), eq(loans.status, "repaid"))!);
    expect(repaid.length).toBeGreaterThan(0);
    const botDays = await db.select().from(events).where(and(eq(events.worldId, worldId), eq(events.type, "bot.day"))!);
    const repayDays = botDays
      .map((event) => event.payload as { day: number; actions: Array<{ bot: string; action: string; status: string }> })
      .filter((payload) => payload.actions.some((a) => a.bot === atlas.name && a.action === "repay_loan" && a.status === "COMPLETED"))
      .map((payload) => payload.day)
      .sort((a, b) => a - b);
    expect(repayDays).toHaveLength(repaid.length);
    const dueDays = repaid
      .map((loan) => Math.round((loan.dueSimAt.getTime() - anchorSim.getTime()) / 86_400_000))
      .sort((a, b) => a - b);
    expect(repayDays).toEqual(dueDays.map((day) => day + 3));
    for (const loan of repaid) {
      expect(loan.lateFeesCents).toBeGreaterThan(0n);
      expect(loan.outstandingCents).toBe(0n);
    }
  }, 120_000);

  it("a defaulter never repays: its loan is charged off", async () => {
    const seed = seedWith("defaulter", 0, "defaulter");
    const worldId = await create(seed);
    await advance(worldId, 42);
    const { borrowers } = await worldBots(db, worldId);
    const bot = borrowers[0]!;
    const own = await db.select().from(loans).where(eq(loans.agentId, bot.id));
    expect(own.length).toBeGreaterThan(0);
    expect(own.some((loan) => loan.status === "charged_off")).toBe(true);
    expect(own.some((loan) => loan.status === "repaid")).toBe(false);
  }, 120_000);

  it("v2 lenders: buy only when the real return is above 2%, redeem only when it is below 0", async () => {
    const worldId = await create("lender-seed");
    const { lenders } = await worldBots(db, worldId);
    const lender = lenders[0]!;
    const day = (await getSimDay(db, worldId)).day;
    const setEconomy = async (baseRateBps: number, inflationRateBps: number) => {
      await db.delete(economyState).where(eq(economyState.worldId, worldId));
      await db.insert(economyState).values({
        worldId,
        simDay: day,
        baseRateBps,
        inflationIndexBp: 10000,
        inflationRateBps,
        utilizationBps: 0,
        reserveRatioBps: 0,
      });
    };

    await setEconomy(900, 300); // real +6%
    expect(await lenderRealReturnBps(db, worldId)).toBeGreaterThanOrEqual(600);
    const high: string[] = [];
    for (let d = 1; d <= 20; d += 1) {
      high.push(...(await lenderDayV2(db, worldId, "lender-seed", d, 0, lender)).map((action) => action.action));
    }
    expect(high.length).toBeGreaterThan(0);
    expect(new Set(high)).toEqual(new Set(["buy_notes"]));

    await setEconomy(100, 500); // real −4% (and the pool is barely lent)
    expect(await lenderRealReturnBps(db, worldId)).toBeLessThan(0);
    const low: string[] = [];
    for (let d = 21; d <= 40; d += 1) {
      low.push(...(await lenderDayV2(db, worldId, "lender-seed", d, 0, lender)).map((action) => action.action));
    }
    expect(low.length).toBeGreaterThan(0);
    expect(new Set(low)).toEqual(new Set(["redeem_notes"]));
    const redemptions = await db
      .select()
      .from(noteTransactions)
      .where(and(eq(noteTransactions.worldId, worldId), eq(noteTransactions.kind, "redeem"))!);
    expect(redemptions.length).toBeGreaterThan(0);
  }, 60_000);

  it("existing (v1) worlds keep their 2 + 2 bots and P2 behaviour; new worlds get v2", async () => {
    const worldId = await create("v1-seed");
    // Simulate a world created before bots v2: drop the extra bots' rows from the view by version only.
    await db.update(worlds).set({ botVersion: 1 }).where(eq(worlds.id, worldId));
    const view = await privateWorldView(db, owner, worldId);
    expect(view!.bots.every((bot) => bot.archetype === null)).toBe(true);
    const fresh = await create("v2-seed");
    const [row] = await db.select().from(worlds).where(eq(worlds.id, fresh));
    expect(row!.botVersion).toBe(2);
    expect((await db.select().from(agents).where(and(eq(agents.worldId, fresh), eq(agents.isBot, true))!)).length).toBe(10);
  }, 60_000);
});
