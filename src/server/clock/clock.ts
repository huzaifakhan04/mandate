import { eq, sql } from "drizzle-orm";

import type { Db } from "../db/client";
import { clock } from "../db/schema";

export interface ClockState {
  anchorReal: Date;
  anchorSim: Date;
  speed: number;
  manualOffsetMs: bigint;
}

/**
 * Pure function mapping a world's clock state to the current simulated
 * time: `anchorSim + (realNow - anchorReal) * speed + manualOffsetMs`.
 */
export function simNow(state: ClockState, realNow: Date): Date {
  const realElapsedMs = realNow.getTime() - state.anchorReal.getTime();
  const simElapsedMs = realElapsedMs * state.speed;
  const offsetMs = Number(state.manualOffsetMs);
  return new Date(state.anchorSim.getTime() + simElapsedMs + offsetMs);
}

/**
 * Loads a world's clock row and computes its current simulated time.
 */
export async function getSimNow(
  db: Db,
  worldId: string,
  realNow: Date = new Date(),
): Promise<Date> {
  const [row] = await db.select().from(clock).where(eq(clock.worldId, worldId));
  if (!row) {
    throw new Error(`No clock row found for world ${worldId}`);
  }

  return simNow(
    {
      anchorReal: row.anchorReal,
      anchorSim: row.anchorSim,
      // Postgres `numeric` comes back as a string over the wire.
      speed: Number(row.speed),
      manualOffsetMs: row.manualOffsetMs,
    },
    realNow,
  );
}

/**
 * Manually fast-forwards a world's clock by `days` whole days, by adding
 * to `manual_offset_ms`. Rejects non-positive or implausibly large
 * (> 365 day) jumps.
 */
export async function advanceClock(
  db: Db,
  worldId: string,
  days: number,
): Promise<Date> {
  if (!Number.isInteger(days)) {
    throw new Error(`advanceClock: days must be an integer, got ${days}`);
  }
  if (days <= 0 || days > 365) {
    throw new Error(`advanceClock: days must be in (0, 365], got ${days}`);
  }

  const deltaMs = BigInt(days) * 86_400_000n;

  const updated = await db
    .update(clock)
    .set({ manualOffsetMs: sql`${clock.manualOffsetMs} + ${deltaMs}` })
    .where(eq(clock.worldId, worldId))
    .returning();

  if (updated.length === 0) {
    throw new Error(`advanceClock: no clock row found for world ${worldId}`);
  }

  return getSimNow(db, worldId);
}

const DAY_MS = 86_400_000;

export interface SimDay {
  simNow: Date;
  /** The clock's anchor: simulated day 0 starts here. */
  anchorSim: Date;
  /** Whole simulated days since the anchor (P2 Task 6: the bots' day counter). */
  day: number;
}

/** A world's simulated now plus its whole-day index since the clock's anchor. */
export async function getSimDay(db: Db, worldId: string, realNow: Date = new Date()): Promise<SimDay> {
  const [row] = await db.select().from(clock).where(eq(clock.worldId, worldId));
  if (!row) {
    throw new Error(`No clock row found for world ${worldId}`);
  }
  const now = simNow(
    { anchorReal: row.anchorReal, anchorSim: row.anchorSim, speed: Number(row.speed), manualOffsetMs: row.manualOffsetMs },
    realNow,
  );
  return { simNow: now, anchorSim: row.anchorSim, day: simDayIndex(row.anchorSim, now) };
}

/** Pure: whole simulated days from `anchorSim` to `at` (floored). */
export function simDayIndex(anchorSim: Date, at: Date): number {
  return Math.floor((at.getTime() - anchorSim.getTime()) / DAY_MS);
}
