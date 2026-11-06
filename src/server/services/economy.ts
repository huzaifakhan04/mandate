import { eq, lte } from "drizzle-orm";

import { getSimDay } from "../clock/clock";
import type { Db } from "../db/client";
import { economyState, events, worlds } from "../db/schema";
import { scoped } from "../db/scoped";
import {
  BASE_RATE_MAX_BPS,
  ECONOMY_DEFAULTS,
  reserveRatioBps,
  stepRates,
  utilizationBps,
  utilizationPremiumBps,
  type EconomyRates,
} from "../domain/economy";
import { availableLiquidity } from "../domain/liquidity";
import { getCodeBalance } from "../ledger/trialBalance";
import { allowanceBalance, bookCecl } from "./cecl";
import { lockPoolSeries } from "./collections";

/**
 * P5 Task 1: the economy engine. `stepEconomy` writes one `economy_state`
 * row per world per simulated day (unique per (world, sim_day); stepping a
 * day again is a no-op), from the previous day's row with the seeded walk
 * (`domain/economy.ts`). The tick steps every active world when its sim
 * day changes; a private world's advance steps each day it passes, before
 * the ladder and the bots.
 *
 * The row's utilization and reserve ratio are the ledger's at the moment
 * the day was stepped (a daily snapshot for the console and the treasury
 * memo). Pricing does NOT use that snapshot for utilization: the premium
 * is computed live at offer time (`liveUtilization`), because the pool can
 * move a lot within a day. The base rate is the latest row's (it only
 * changes once a day).
 *
 * P5 Task 3: the row also snapshots available liquidity
 * (`day_start_liquidity_cents`), the base of that day's lending budget; a
 * catch-up's back-filled days share the value measured at catch-up time.
 *
 * P5 Task 2: each day's row is inserted in a transaction under the note
 * series lock together with that day's CECL allowance booking
 * (`services/cecl.ts`); `cecl_reserve_cents` is the target booked.
 *
 * P5 Task 4 (carried M1/M2): a catch-up books CECL on the LAST day it
 * inserts (the day the loans are actually as measured, so the journal's
 * sim date is right); the back-filled days before it book nothing and
 * record the allowance as it stood. A `rate_spike` stress scenario
 * (`services/stress.ts`) adds its bump to the base rate of the day it
 * names (the next economy step after it was triggered), clamped to the
 * walk's ceiling; the walk's mean reversion then pulls it back. That
 * day's row carries `scenario = 'rate_spike'`.
 */

type EconomyRow = typeof economyState.$inferSelect;

/** At most this many days are stepped per call (a long-idle world catches up over several ticks). */
export const MAX_ECONOMY_CATCH_UP_DAYS = 400;

const DAY_MS = 86_400_000;

export interface EconomyView extends EconomyRates {
  /** `null` when the world has no `economy_state` row yet (the defaults apply). */
  simDay: number | null;
  utilizationBps: number;
  reserveRatioBps: number;
}

export interface LiveUtilization {
  cashCents: bigint;
  loansReceivableCents: bigint;
  utilizationBps: number;
  /** The cost-of-funds premium for that utilization (annual bps). */
  premiumBps: number;
}

/** Utilization from the ledger right now: loans_receivable ÷ (cash_paypal + loans_receivable). */
export async function liveUtilization(db: Db, worldId: string): Promise<LiveUtilization> {
  const cashCents = await getCodeBalance(db, worldId, "cash_paypal");
  const loansReceivableCents = await getCodeBalance(db, worldId, "loans_receivable");
  const utilization = utilizationBps(cashCents, loansReceivableCents);
  return { cashCents, loansReceivableCents, utilizationBps: utilization, premiumBps: utilizationPremiumBps(utilization) };
}

async function measure(
  db: Db,
  worldId: string,
): Promise<{ utilizationBps: number; reserveRatioBps: number; dayStartLiquidityCents: bigint }> {
  const live = await liveUtilization(db, worldId);
  // notes_payable is a credit balance: negate to get what the bank owes holders.
  const notesPayableCents = -(await getCodeBalance(db, worldId, "notes_payable"));
  return {
    utilizationBps: live.utilizationBps,
    reserveRatioBps: reserveRatioBps(live.cashCents, notesPayableCents),
    // P5 Task 3: the base of the day's lending budget.
    dayStartLiquidityCents: await availableLiquidity(db, worldId),
  };
}

/** The world's walk seed: its bot seed, else its id (same rule as the bots). */
async function economySeed(db: Db, worldId: string): Promise<string> {
  const [world] = await db.select({ id: worlds.id, botSeed: worlds.botSeed }).from(worlds).where(eq(worlds.id, worldId)).limit(1);
  if (!world) {
    throw new Error(`stepEconomy: no world ${worldId}`);
  }
  return world.botSeed ?? world.id;
}

function ratesOf(row: EconomyRow): EconomyRates {
  return { baseRateBps: row.baseRateBps, inflationIndexBp: row.inflationIndexBp, inflationRateBps: row.inflationRateBps };
}

async function rowForDay(db: Db, worldId: string, simDay: number): Promise<EconomyRow | undefined> {
  return scoped(db, worldId).findOne(economyState, eq(economyState.simDay, simDay));
}

/**
 * Ensures `economy_state` rows exist for every day up to `simDay` and
 * returns the newest one written or found (the row for `simDay`, unless
 * the catch-up cap stopped short of it). Days are stepped in order from
 * the latest row before `simDay` (or from day 0's defaults); each insert
 * is `ON CONFLICT DO NOTHING`, and the stored row — not the one computed —
 * feeds the next day, so concurrent callers converge on the same series.
 */
export async function stepEconomy(db: Db, worldId: string, simDay: number): Promise<EconomyRow> {
  if (!Number.isInteger(simDay) || simDay < 0) {
    throw new Error(`stepEconomy: sim day must be a non-negative integer, got ${simDay}`);
  }
  const existing = await rowForDay(db, worldId, simDay);
  if (existing) {
    return existing;
  }
  const seed = await economySeed(db, worldId);
  const { anchorSim } = await getSimDay(db, worldId);
  const measured = await measure(db, worldId);
  let previous = await scoped(db, worldId).findLatest(
    economyState,
    lte(economyState.simDay, simDay),
    economyState.simDay,
  );

  let day = previous ? previous.simDay + 1 : 0;
  // Carried M1/M2: the last day this call inserts books the CECL delta.
  const lastDay = Math.min(simDay, day + MAX_ECONOMY_CATCH_UP_DAYS - 1);
  const spikes = await rateSpikesByDay(db, worldId);
  let stepped = 0;
  while (day <= simDay && stepped < MAX_ECONOMY_CATCH_UP_DAYS) {
    const walked = previous ? stepRates(ratesOf(previous), seed, day) : ECONOMY_DEFAULTS;
    const spikeBps = spikes.get(day) ?? 0;
    const rates =
      spikeBps > 0 ? { ...walked, baseRateBps: Math.min(BASE_RATE_MAX_BPS, walked.baseRateBps + spikeBps) } : walked;
    const stepDay = day;
    // P5 Task 2: the day's row and its CECL booking commit together, under
    // the note-series lock (serialised with charge-offs). A day whose row
    // another caller already wrote books nothing here.
    await db.transaction(async (tx) => {
      await lockPoolSeries(tx, worldId);
      const [inserted] = await scoped(tx, worldId).insertOnConflictDoNothing(
        economyState,
        {
          simDay: stepDay,
          baseRateBps: rates.baseRateBps,
          inflationIndexBp: rates.inflationIndexBp,
          inflationRateBps: rates.inflationRateBps,
          utilizationBps: measured.utilizationBps,
          reserveRatioBps: measured.reserveRatioBps,
          dayStartLiquidityCents: measured.dayStartLiquidityCents,
          scenario: spikeBps > 0 ? "rate_spike" : null,
        },
        [economyState.worldId, economyState.simDay],
      );
      if (!inserted) {
        return;
      }
      const ceclReserveCents =
        stepDay === lastDay
          ? (await bookCecl(tx, worldId, stepDay, new Date(anchorSim.getTime() + stepDay * DAY_MS))).targetCents
          : await allowanceBalance(tx, worldId);
      await scoped(tx, worldId).update(economyState, { ceclReserveCents }, eq(economyState.id, inserted.id));
    });
    const stored = await rowForDay(db, worldId, day);
    if (!stored) {
      throw new Error(`stepEconomy: expected an economy_state row for day ${day}`);
    }
    previous = stored;
    day += 1;
    stepped += 1;
  }
  return previous!;
}

/** The event type a `rate_spike` stress scenario is recorded as (`services/stress.ts`). */
export const RATE_SPIKE_EVENT = "stress.rate_spike";

/** The world's rate spikes: Σ bump bps by the sim day they apply to. */
async function rateSpikesByDay(db: Db, worldId: string): Promise<Map<number, number>> {
  const rows = await scoped(db, worldId).select(events, eq(events.type, RATE_SPIKE_EVENT));
  const byDay = new Map<number, number>();
  for (const row of rows) {
    const params = ((row.payload ?? {}) as { params?: { apply_sim_day?: unknown; bump_bps?: unknown } }).params ?? {};
    if (typeof params.apply_sim_day === "number" && typeof params.bump_bps === "number") {
      byDay.set(params.apply_sim_day, (byDay.get(params.apply_sim_day) ?? 0) + params.bump_bps);
    }
  }
  return byDay;
}

/** Steps the world's economy up to its current simulated day. */
export async function stepEconomyToNow(db: Db, worldId: string, now: Date = new Date()): Promise<EconomyRow> {
  const { day } = await getSimDay(db, worldId, now);
  return stepEconomy(db, worldId, Math.max(0, day));
}

/** The latest `economy_state` row as a view, or the defaults (400 bps, index 10000) when there is none. */
export async function currentEconomy(db: Db, worldId: string): Promise<EconomyView> {
  const latest = await scoped(db, worldId).findLatest(
    economyState,
    eq(economyState.worldId, worldId),
    economyState.simDay,
  );
  if (!latest) {
    return { ...ECONOMY_DEFAULTS, simDay: null, utilizationBps: 0, reserveRatioBps: 0 };
  }
  return {
    ...ratesOf(latest),
    simDay: latest.simDay,
    utilizationBps: latest.utilizationBps,
    reserveRatioBps: latest.reserveRatioBps,
  };
}
