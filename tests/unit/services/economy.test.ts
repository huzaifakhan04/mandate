/**
 * P5 Task 1: the economy engine — one `economy_state` row per world per
 * sim day (idempotent, catching up in order, seeded per world), stepped by
 * the tick and by a private world's advance; pricing v2 takes the base
 * rate from it and the utilization premium live from the ledger (> 90% →
 * `pool_utilization_high`); disclosure v2 carries both.
 */
import { randomUUID } from "crypto";

import { asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { advanceClock } from "@/server/clock/clock";
import type { Db } from "@/server/db/client";
import { economyState, principals } from "@/server/db/schema";
import { createTestDb } from "@/server/db/testing";
import { disclosureHash } from "@/server/domain/disclosure";
import { ratesSeries } from "@/server/domain/economy";
import { runTick } from "@/server/jobs/tick";
import { postJournal } from "@/server/ledger/postJournal";
import { currentEconomy, liveUtilization, stepEconomy } from "@/server/services/economy";
import { advancePrivateWorld, createPrivateWorld } from "@/server/services/privateWorlds";

import { call, createSimWorld, createTestAgent, type Data, fundPool } from "../../helpers/world";

describe("economy engine (P5 Task 1)", () => {
  let db: Db;
  let worldId: string;

  beforeEach(async () => {
    vi.stubEnv("SESSION_SECRET", "unit-test-session-secret-0123456789abcdef");
    vi.stubEnv("API_KEY_PEPPER", "test-pepper");
    db = await createTestDb();
    worldId = await createSimWorld(db);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function rows(world = worldId) {
    return db.select().from(economyState).where(eq(economyState.worldId, world)).orderBy(asc(economyState.simDay));
  }

  /** Moves `cents` of pool cash into loans_receivable (as if lent), so utilization changes. */
  async function lendOut(cents: number, key: string) {
    await postJournal(db, {
      worldId,
      memo: "test: lent out",
      sourceType: "test",
      sourceId: randomUUID(),
      simAt: new Date(),
      idempotencyKey: `test-lend:${key}`,
      postings: [
        { accountCode: "loans_receivable", amountCents: BigInt(cents) },
        { accountCode: "cash_paypal", amountCents: -BigInt(cents) },
      ],
    });
  }

  /** Lends out exactly `bps` of the pool (cash + loans; the bank's seed capital and fees included). */
  async function lendToUtilization(bps: number, key: string) {
    const live = await liveUtilization(db, worldId);
    const pool = live.cashCents + live.loansReceivableCents;
    const target = (pool * BigInt(bps) + 9999n) / 10000n - live.loansReceivableCents;
    await lendOut(Number(target), key);
    expect((await liveUtilization(db, worldId)).utilizationBps).toBe(bps);
    return pool;
  }

  it("currentEconomy without any row → the defaults (400 bps, index 10000)", async () => {
    expect(await currentEconomy(db, worldId)).toMatchObject({
      simDay: null,
      baseRateBps: 400,
      inflationIndexBp: 10000,
      inflationRateBps: 300,
    });
  });

  it("stepEconomy catches up day by day from day 0, seeded by the world id; the series matches the pure walk", async () => {
    const day5 = await stepEconomy(db, worldId, 5);
    expect(day5.simDay).toBe(5);
    const stored = await rows();
    expect(stored.map((row) => row.simDay)).toEqual([0, 1, 2, 3, 4, 5]);
    const expected = ratesSeries(worldId, 5);
    expect(
      stored.map((row) => ({
        baseRateBps: row.baseRateBps,
        inflationIndexBp: row.inflationIndexBp,
        inflationRateBps: row.inflationRateBps,
      })),
    ).toEqual(expected);
    expect(await currentEconomy(db, worldId)).toMatchObject({ simDay: 5, baseRateBps: expected[5]!.baseRateBps });
  });

  it("is idempotent per (world, sim_day): stepping again writes nothing and returns the stored row", async () => {
    const first = await stepEconomy(db, worldId, 3);
    await lendOut(1, "after-step"); // a later ledger change must not rewrite a stepped day
    const again = await stepEconomy(db, worldId, 3);
    expect(again).toEqual(first);
    const earlier = await stepEconomy(db, worldId, 1);
    expect(earlier.simDay).toBe(1);
    expect(await rows()).toHaveLength(4);
    // Then the catch-up continues from the latest row.
    await stepEconomy(db, worldId, 6);
    expect((await rows()).map((row) => row.simDay)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect((await rows()).map((row) => row.baseRateBps)).toEqual(ratesSeries(worldId, 6).map((r) => r.baseRateBps));
  });

  it("concurrent steps of the same days converge on one row per day", async () => {
    await Promise.all([stepEconomy(db, worldId, 4), stepEconomy(db, worldId, 4), stepEconomy(db, worldId, 2)]);
    expect((await rows()).map((row) => row.simDay)).toEqual([0, 1, 2, 3, 4]);
  });

  it("snapshots utilization and the reserve ratio from the ledger at the moment the day is stepped", async () => {
    await fundPool(db, worldId, 10000);
    await lendToUtilization(7000, "u70");
    const live = await liveUtilization(db, worldId);
    expect(live).toMatchObject({ utilizationBps: 7000, premiumBps: 300 });
    const row = await stepEconomy(db, worldId, 0);
    // cash ÷ notes payable (10000).
    expect(row).toMatchObject({
      utilizationBps: 7000,
      reserveRatioBps: Number((live.cashCents * 10000n) / 10000n),
      ceclReserveCents: 0n,
    });
  });

  it("the tick steps every active world to its current sim day", async () => {
    await advanceClock(db, worldId, 3);
    await runTick(db);
    expect((await rows()).map((row) => row.simDay)).toEqual([0, 1, 2, 3]);
    // Same day again → nothing new.
    await runTick(db);
    expect(await rows()).toHaveLength(4);
  });

  it("a private world's advance steps each day it passes (seeded by the world's bot seed)", async () => {
    const [owner] = await db
      .insert(principals)
      .values({ paypalPayerId: "ECON", email: "econ@example.com", name: "Econ", entityType: "individual", verifiedAt: new Date() })
      .returning();
    const created = await createPrivateWorld(db, owner!.id, { name: "Econ", seed: "econ-seed" });
    if (created.outcome !== "created") {
      throw new Error(`expected created, got ${created.outcome}`);
    }
    const advanced = await advancePrivateWorld(db, owner!.id, created.worldId, 3);
    expect(advanced).toMatchObject({ outcome: "advanced", simDay: 3 });
    const stored = await rows(created.worldId);
    expect(stored.map((row) => row.simDay)).toEqual([0, 1, 2, 3]);
    expect(stored.map((row) => row.baseRateBps)).toEqual(ratesSeries("econ-seed", 3).map((r) => r.baseRateBps));
  });

  describe("pricing v2 with the economy", () => {
    async function setBaseRate(baseRateBps: number) {
      await db.insert(economyState).values({
        worldId,
        simDay: 0,
        baseRateBps,
        inflationIndexBp: 10000,
        inflationRateBps: 300,
        utilizationBps: 0,
        reserveRatioBps: 0,
      });
    }

    it("check_eligibility quotes the base rate and the live utilization premium", async () => {
      await fundPool(db, worldId, 40000);
      await setBaseRate(800);
      const { key } = await createTestAgent(db, worldId, "b@example.com");
      const low = await call(db, "check_eligibility", key, { amount_cents: 10000, term_days: 14 });
      const lowQuote = (low.envelope.data as Data).quote as Data;
      expect(lowQuote).toMatchObject({ base_rate_bps: 800, utilization_premium_bps: 0 });
      // 70% lent out → +300.
      await lendToUtilization(7000, "u70");
      const mid = await call(db, "check_eligibility", key, { amount_cents: 10000, term_days: 14 });
      const midQuote = (mid.envelope.data as Data).quote as Data;
      expect(midQuote).toMatchObject({ base_rate_bps: 800, utilization_premium_bps: 300 });
      // round((800 + 300) × 14 / 365 = 42.19) = 42.
      expect((midQuote.rate_components as Data).cost_of_funds_bps).toBe(42);
    });

    it("apply_for_loan's disclosure v2 carries base_rate_bps and utilization_premium_bps, covered by the hash", async () => {
      await fundPool(db, worldId, 40000);
      await lendToUtilization(6000, "u60"); // 60% → +150
      const { key } = await createTestAgent(db, worldId, "b@example.com");
      const applied = await call(db, "apply_for_loan", key, { amount_cents: 5000, term_days: 14, purpose: "Buy tools" });
      expect(applied.envelope.status).toBe("OFFERED");
      const data = applied.envelope.data as Data;
      const disclosure = data.disclosure as Data;
      expect(disclosure).toMatchObject({ base_rate_bps: 400, utilization_premium_bps: 150 });
      expect(data.disclosure_hash).toBe(disclosureHash(disclosure));
    });

    it("above 90% utilization apply_for_loan declines with pool_utilization_high (with its fixed text)", async () => {
      await fundPool(db, worldId, 40000);
      await lendToUtilization(9100, "u91");
      const { key } = await createTestAgent(db, worldId, "b@example.com");
      const applied = await call(db, "apply_for_loan", key, { amount_cents: 1000, term_days: 14, purpose: "Buy tools" });
      expect(applied.envelope.status).toBe("DECLINED");
      expect(applied.envelope.reason_codes).toContain("pool_utilization_high");
      const adverse = (applied.envelope.data as Data).adverse_action as Data;
      expect(adverse.reasons).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: "pool_utilization_high", text: expect.stringMatching(/90%/) })]),
      );
    });
  });

  it("get_statement: nominal return over the holding period, real = nominal − the economy's inflation rate", async () => {
    const lender = await fundPool(db, worldId, 10000);
    await advanceClock(db, worldId, 30);
    const day30 = await stepEconomy(db, worldId, 30);
    const statement = await call(db, "get_statement", lender.key, {});
    // Nothing earned yet over 30 days: nominal 0, real = −inflation.
    expect((statement.envelope.data as Data).notes).toMatchObject({
      nominal_annual_return_bps: 0,
      real_annual_return_bps: -day30.inflationRateBps,
      inflation_rate_bps: day30.inflationRateBps,
      holding_days: 30,
    });
  });

  it("an economy row belongs to its world only", async () => {
    const other = await createSimWorld(db);
    await stepEconomy(db, worldId, 2);
    expect(await db.select().from(economyState).where(eq(economyState.worldId, other))).toHaveLength(0);
    expect((await currentEconomy(db, other)).simDay).toBeNull();
  });
});
