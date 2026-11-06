/**
 * P5 Task 4 — the economy's invariants over 60 simulated days × 3 seeds
 * of a bots-v2 private world, with each stress scenario injected once
 * (default wave on day 10, note run on day 25, rate spike on day 40) and
 * the treasury policy ON (a `treasury_policy` row: the vitest env switch
 * only disables the gates for worlds without one). After EVERY day:
 *
 * - trial balance 0;
 * - Ruling T: each holder's notes_payable = its units;
 * - allowance ≥ 0, cash ≥ 0, utilization ≤ 100%;
 * - the redemption queue is FIFO: no redemption still queued was queued
 *   before one that has already been promoted to a payout;
 * - no PayPal-rail operation (private worlds are sim-only).
 *
 * Review Focus 1 (determinism): the same seed and the same actions twice
 * give an identical economy_state history and ledger fingerprint.
 */
import { and, asc, eq, isNotNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getSimDay } from "@/server/clock/clock";
import type { Db } from "@/server/db/client";
import {
  economyState,
  events,
  journalEntries,
  ledgerAccounts,
  loans,
  notePositions,
  noteTransactions,
  paypalOperations,
  postings,
  principals,
} from "@/server/db/schema";
import { createTestDb } from "@/server/db/testing";
import { TREASURY_DEFAULTS } from "@/server/domain/treasury";
import { getAccountBalance, getCodeBalance, trialBalance } from "@/server/ledger/trialBalance";
import { allowanceBalance } from "@/server/services/cecl";
import { liveUtilization } from "@/server/services/economy";
import { advancePrivateWorld, createPrivateWorld } from "@/server/services/privateWorlds";
import { DEFAULT_WAVE_LOAN_EVENT, triggerStressScenario, type StressScenario } from "@/server/services/stress";
import { setTreasuryPolicy } from "@/server/services/treasury";

const DAYS = 60;
const DAY_MS = 86_400_000;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const SCENARIO_DAYS: Record<number, StressScenario> = { 10: "default_wave", 25: "note_run", 40: "rate_spike" };

interface RunResult {
  worldId: string;
  economy: string[];
  ledger: string[];
}

describe("economy invariants: 60 simulated days × 3 seeds with stress (P5 Task 4)", () => {
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

  async function expectInvariants(worldId: string, day: number): Promise<void> {
    const where = `day ${day}`;
    expect((await trialBalance(db, worldId)).totalCents, `${where}: trial balance`).toBe(0n);
    for (const position of await db.select().from(notePositions).where(eq(notePositions.worldId, worldId))) {
      expect(-(await getAccountBalance(db, worldId, "notes_payable", position.agentId)), `${where}: Ruling T`).toBe(position.units);
    }
    expect(await allowanceBalance(db, worldId), `${where}: allowance`).toBeGreaterThanOrEqual(0n);
    expect(await getCodeBalance(db, worldId, "cash_paypal"), `${where}: cash`).toBeGreaterThanOrEqual(0n);
    const live = await liveUtilization(db, worldId);
    expect(live.utilizationBps, `${where}: utilization`).toBeLessThanOrEqual(10000);
    const [today] = await db
      .select()
      .from(economyState)
      .where(and(eq(economyState.worldId, worldId), eq(economyState.simDay, day))!);
    expect(today, `${where}: economy row`).toBeDefined();
    expect(today!.utilizationBps).toBeLessThanOrEqual(10000);

    // FIFO: every redemption that went through the queue and has left it was queued no later than any still waiting.
    const queuedThrough = await db
      .select()
      .from(noteTransactions)
      .where(and(eq(noteTransactions.worldId, worldId), eq(noteTransactions.kind, "redeem"), isNotNull(noteTransactions.queuedAt))!);
    const key = (row: (typeof queuedThrough)[number]) => `${row.queuedAt!.toISOString()}|${row.id}`;
    const waiting = queuedThrough.filter((row) => row.status === "queued").map(key).sort();
    const promoted = queuedThrough.filter((row) => row.status === "pending" || row.status === "completed").map(key).sort();
    if (waiting.length > 0 && promoted.length > 0) {
      expect(promoted[promoted.length - 1]! < waiting[0]!, `${where}: FIFO`).toBe(true);
    }

    const paypalOps = await db
      .select({ id: paypalOperations.id })
      .from(paypalOperations)
      .where(and(eq(paypalOperations.worldId, worldId), eq(paypalOperations.rail, "paypal"))!);
    expect(paypalOps, `${where}: PayPal-rail ops`).toEqual([]);
  }

  /** The economy history, one line per day (ids and real timestamps left out). */
  async function economyHistory(worldId: string): Promise<string[]> {
    const rows = await db.select().from(economyState).where(eq(economyState.worldId, worldId)).orderBy(asc(economyState.simDay));
    return rows.map((row) =>
      [
        row.simDay,
        row.baseRateBps,
        row.inflationIndexBp,
        row.inflationRateBps,
        row.utilizationBps,
        row.reserveRatioBps,
        row.ceclReserveCents,
        row.dayStartLiquidityCents,
        row.scenario,
        JSON.stringify(row.treasuryMemo),
      ].join("|"),
    );
  }

  /** Every journal entry as "day|memo|account:amount,…" (ids stripped), sorted. */
  async function ledgerFingerprint(worldId: string): Promise<string[]> {
    const { anchorSim } = await getSimDay(db, worldId);
    const entries = await db.select().from(journalEntries).where(eq(journalEntries.worldId, worldId));
    const lines = await db
      .select({ entryId: postings.entryId, amount: postings.amountCents, code: ledgerAccounts.code })
      .from(postings)
      .innerJoin(ledgerAccounts, eq(ledgerAccounts.id, postings.accountId))
      .where(eq(postings.worldId, worldId));
    const byEntry = new Map<string, string[]>();
    for (const line of lines) {
      byEntry.set(line.entryId, [...(byEntry.get(line.entryId) ?? []), `${line.code}:${line.amount.toString()}`]);
    }
    return entries
      .map((entry) => {
        const day = Math.floor((entry.simAt.getTime() - anchorSim.getTime()) / DAY_MS);
        return `${day}|${(entry.memo ?? "").replace(UUID_RE, "<id>")}|${(byEntry.get(entry.id) ?? []).sort().join(",")}`;
      })
      .sort();
  }

  async function run(seed: string): Promise<RunResult> {
    const created = await createPrivateWorld(db, owner, { name: `Invariants ${seed}`, seed });
    if (created.outcome !== "created") throw new Error(created.outcome);
    const worldId = created.worldId;
    await setTreasuryPolicy(db, worldId, { ...TREASURY_DEFAULTS });
    for (let day = 1; day <= DAYS; day += 1) {
      const scenario = SCENARIO_DAYS[day - 1];
      if (scenario) {
        expect((await triggerStressScenario(db, owner, worldId, scenario)).outcome).toBe("triggered");
      }
      expect(await advancePrivateWorld(db, owner, worldId, 1)).toMatchObject({ outcome: "advanced", simDay: day });
      await expectInvariants(worldId, day);
    }
    return { worldId, economy: await economyHistory(worldId), ledger: await ledgerFingerprint(worldId) };
  }

  async function expectScenariosPlayedOut(result: RunResult): Promise<void> {
    const { worldId, economy } = result;
    expect(economy).toHaveLength(DAYS + 1);
    // The rate spike (triggered on day 40) landed on day 41.
    const spiked = await db
      .select()
      .from(economyState)
      .where(and(eq(economyState.worldId, worldId), eq(economyState.scenario, "rate_spike"))!);
    expect(spiked.map((row) => row.simDay)).toEqual([41]);
    // The default wave took loans, and they went bad.
    const marks = await db.select().from(events).where(and(eq(events.worldId, worldId), eq(events.type, DEFAULT_WAVE_LOAN_EVENT))!);
    expect(marks).toHaveLength(3);
    for (const mark of marks) {
      const [loan] = await db.select().from(loans).where(eq(loans.id, mark.aggregateId));
      expect(loan!.status).toBe("charged_off");
    }
    // The note run asked for every lender's notes: some were paid, the rest queued — and the queue has drained since.
    const [noteRun] = await db.select().from(events).where(and(eq(events.worldId, worldId), eq(events.type, "stress.note_run"))!);
    const requests = (noteRun!.payload as { params: { requests: Array<{ status: string }> } }).params.requests;
    expect(requests).toHaveLength(4);
    expect(requests.some((request) => request.status === "QUEUED")).toBe(true);
    const stillQueued = await db
      .select()
      .from(noteTransactions)
      .where(and(eq(noteTransactions.worldId, worldId), eq(noteTransactions.status, "queued"))!);
    expect(stillQueued).toEqual([]);
  }

  for (const seed of ["invariants-alpha", "invariants-beta", "invariants-gamma"]) {
    it(`seed ${seed}: every invariant holds after each of 60 days with a default wave, a note run and a rate spike`, async () => {
      const result = await run(seed);
      await expectScenariosPlayedOut(result);
    }, 60_000);
  }

  it("Review Focus 1: the same seed and the same actions twice → identical economy history and ledger fingerprint", async () => {
    const first = await run("invariants-determinism");
    const second = await run("invariants-determinism");
    expect(second.worldId).not.toBe(first.worldId);
    expect(second.economy).toEqual(first.economy);
    expect(second.ledger).toEqual(first.ledger);
    expect(first.ledger.length).toBeGreaterThan(50);
    // A different seed gives a different history.
    expect((await economyHistory(first.worldId)).join()).not.toBe((await run("invariants-other")).economy.join());
  }, 120_000);
});
