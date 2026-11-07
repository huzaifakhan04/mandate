import { randomUUID } from "crypto";

import { and, eq } from "drizzle-orm";

import { advanceClock, getSimDay } from "../clock/clock";
import { borrowerArchetype } from "../bots/borrowerBot";
import { BORROWER_BOT_NAMES_V2, CURRENT_BOT_VERSION, insertBots, runBotsCatchUp, seedBots } from "../bots/runner";
import type { Db } from "../db/client";
import { pgErrorCode } from "../db/errors";
import { principals, worlds } from "../db/schema";
import { failWorldOperations } from "../paypal/operations";
import { processDue } from "./collections";
import { invalidateConsoleSnapshot } from "./console";
import { stepEconomyToNow } from "./economy";
import { replanWorldInstallments } from "./installments";
import { processRedemptionQueue } from "./notes";
import { recentStressEvents, STRESS_SCENARIOS, triggerStressInWorld, type StressScenario } from "./stress";
import { writeDailyTreasuryMemo } from "./treasuryMemo";
import { createWorldInTx } from "./worlds";

/**
 * P8 — the public demo world (`worlds.kind = 'demo'`, exactly one active).
 *
 * - Sim rail only (row CHECK `worlds_demo_is_sim`, and `railForWorld` /
 *   `assertWorldMayUsePaypal` treat it like a private world): simulated
 *   money, no PayPal, ever; templates for the treasury memo and the risk
 *   investigator (no LLM spend).
 * - Seeded with bots v2 (4 lenders, 6 borrowers) under a seed picked so the
 *   borrowers include a good payer, a late payer and a defaulter.
 * - Read-only from outside: no owner (no dashboard / console controls), no
 *   API keys on its agents, `register_agent` only ever registers into the
 *   main world, and `runTool` refuses any non-bot call in it
 *   (`DEMO_WORLD_READ_ONLY`).
 * - Auto-advanced by the tick (`advanceDemoWorld`): its frozen clock moves
 *   one sim day per `DEMO_REAL_MS_PER_SIM_DAY` (10 real minutes) of real
 *   time since it was created, at most `DEMO_MAX_CATCH_UP_DAYS` per tick;
 *   each day runs the economy, the delinquency ladder, the repayment-plan
 *   re-planner, the redemption queue, the bots and the treasury memo, and
 *   every 3rd sim day a MILD stress event in rotation (rate spike → note
 *   run → default wave) — so the console always shows movement.
 * - After `DEMO_RESET_SIM_DAYS` (90) sim days it is archived (never
 *   deleted) and a fresh one is created.
 */

export const DEMO_WORLD_NAME = "Demo world";
export const DEMO_REAL_MS_PER_SIM_DAY = 10 * 60_000;
export const DEMO_MAX_CATCH_UP_DAYS = 3;
export const DEMO_STRESS_EVERY_DAYS = 3;
export const DEMO_RESET_SIM_DAYS = 90;
/** The rotation of mild stress events (day 3 → rate spike, day 6 → note run, day 9 → default wave, …). */
export const DEMO_STRESS_ROTATION: readonly StressScenario[] = ["rate_spike", "note_run", "default_wave"];

export type DemoWorldRow = typeof worlds.$inferSelect;

/** The active demo world, or `null`. */
export async function findDemoWorld(db: Db): Promise<DemoWorldRow | null> {
  const [row] = await db
    .select()
    .from(worlds)
    .where(and(eq(worlds.kind, "demo"), eq(worlds.status, "active")))
    .limit(1);
  return row ?? null;
}

/** A bot seed whose 6 v2 borrowers include a good, a late and a defaulting payer. */
export function pickDemoSeed(base: string = randomUUID()): string {
  for (let k = 0; k < 1000; k += 1) {
    const seed = `${base}:${k}`;
    const kinds = new Set(BORROWER_BOT_NAMES_V2.map((_, index) => borrowerArchetype(seed, index)));
    if (kinds.has("defaulter") && kinds.has("late") && kinds.has("good")) {
      return seed;
    }
  }
  return base;
}

/** Inserts the demo world, its bot principal and its bots (inside the caller's transaction). */
async function createDemoWorldInTx(tx: Db, now: Date): Promise<string> {
  const [botPrincipal] = await tx
    .insert(principals)
    .values({
      email: "bots@sim.mandate.bots",
      name: "Mandate bots",
      entityType: "system",
      verifiedAt: now,
      kycStatus: "simulated",
      sanctionsStatus: "simulated",
    })
    .returning();
  const { worldId } = await createWorldInTx(tx, {
    name: DEMO_WORLD_NAME,
    ownerPrincipalId: null,
    railMode: "sim",
    kind: "demo",
    botPrincipalId: botPrincipal!.id,
    botSeed: pickDemoSeed(),
    botVersion: CURRENT_BOT_VERSION,
  });
  await insertBots(tx, worldId, botPrincipal!.id, now, CURRENT_BOT_VERSION);
  return worldId;
}

/**
 * Ensures the one active demo world exists; idempotent and race-safe (the
 * partial unique index `worlds_one_active_demo_idx` lets only one
 * concurrent creator win — the loser re-reads the winner's row). The
 * creator then seeds the lenders' opening note purchases.
 */
export async function ensureDemoWorld(db: Db, now: Date = new Date()): Promise<{ worldId: string; created: boolean }> {
  const existing = await findDemoWorld(db);
  if (existing) {
    return { worldId: existing.id, created: false };
  }
  let worldId: string;
  try {
    worldId = await db.transaction((tx) => createDemoWorldInTx(tx, now));
  } catch (err) {
    if (pgErrorCode(err) !== "23505") {
      throw err;
    }
    const winner = await findDemoWorld(db);
    if (!winner) {
      throw err;
    }
    return { worldId: winner.id, created: false };
  }
  await seedBots(db, worldId);
  return { worldId, created: true };
}

/** The sim day the demo world should be on at `now` (one per 10 real minutes since it was created). */
export function demoTargetDay(createdAt: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - createdAt.getTime()) / DEMO_REAL_MS_PER_SIM_DAY));
}

/** The mild stress scenario for `day`, or `null` (every 3rd sim day, in rotation). */
export function demoStressFor(day: number): StressScenario | null {
  if (day <= 0 || day % DEMO_STRESS_EVERY_DAYS !== 0) {
    return null;
  }
  return DEMO_STRESS_ROTATION[(day / DEMO_STRESS_EVERY_DAYS - 1) % DEMO_STRESS_ROTATION.length] ?? null;
}

/**
 * Claims the next sim day: under the world row's lock, moves the clock one
 * day iff it is still behind `targetDay` (and the world is active). Returns
 * the new day, or `null` when there is nothing to do — so concurrent ticks
 * never advance the same day twice.
 */
async function claimNextDay(db: Db, worldId: string, targetDay: number): Promise<number | null> {
  return db.transaction(async (tx) => {
    const [locked] = await tx
      .select({ id: worlds.id })
      .from(worlds)
      .where(and(eq(worlds.id, worldId), eq(worlds.status, "active")))
      .for("update");
    if (!locked) {
      return null;
    }
    const { day } = await getSimDay(tx, worldId);
    if (day >= targetDay || day >= DEMO_RESET_SIM_DAYS) {
      return null;
    }
    await advanceClock(tx, worldId, 1);
    return day + 1;
  });
}

/** One demo sim day's work, after the clock moved (each step is idempotent per day). */
async function runDemoDay(db: Db, world: DemoWorldRow, day: number): Promise<{ stress: StressScenario | null; errors: string[] }> {
  const errors: string[] = [];
  const step = async (name: string, run: () => Promise<unknown>) => {
    try {
      await run();
    } catch (err) {
      errors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const { simNow } = await getSimDay(db, world.id);
  await step("economy", () => stepEconomyToNow(db, world.id));
  await step("ladder", () => processDue(db, world.id, simNow));
  await step("installments", () => replanWorldInstallments(db, world.id, simNow));
  await step("queue", () => processRedemptionQueue(db, world.id));
  await step("bots", () => runBotsCatchUp(db, world.id, { maxDays: DEMO_MAX_CATCH_UP_DAYS }));
  let stress: StressScenario | null = null;
  const scenario = demoStressFor(day);
  if (scenario && (STRESS_SCENARIOS as readonly string[]).includes(scenario)) {
    await step("stress", async () => {
      const [latest] = await recentStressEvents(db, world.id, 1);
      if (latest?.simDay === day) {
        return; // already injected for this day
      }
      await triggerStressInWorld(db, world, scenario, { mild: true });
      stress = scenario;
    });
  }
  await step("memo", () => writeDailyTreasuryMemo(db, world.id));
  return { stress, errors };
}

export interface DemoReset {
  archivedWorldId: string;
  worldId: string;
}

/** Archives the demo world (its unfinished operations fail as `world_archived`) and creates a fresh one. */
export async function resetDemoWorld(db: Db, worldId: string, now: Date = new Date()): Promise<DemoReset | null> {
  const fresh = await db.transaction(async (tx) => {
    const archived = await tx
      .update(worlds)
      .set({ status: "archived", archivedAt: now })
      .where(and(eq(worlds.id, worldId), eq(worlds.kind, "demo"), eq(worlds.status, "active")))
      .returning();
    if (archived.length !== 1) {
      return null;
    }
    await failWorldOperations(tx, worldId);
    return createDemoWorldInTx(tx, now);
  });
  if (!fresh) {
    return null;
  }
  await seedBots(db, fresh);
  invalidateConsoleSnapshot(worldId);
  invalidateConsoleSnapshot(fresh);
  return { archivedWorldId: worldId, worldId: fresh };
}

export interface DemoAdvanceReport {
  worldId: string | null;
  created: boolean;
  days: number;
  simDay: number;
  stress: StressScenario[];
  reset: DemoReset | null;
  errors: string[];
}

/**
 * The tick's demo-world step: ensure it exists (`ensure`, the cron route),
 * reset it once it has run `DEMO_RESET_SIM_DAYS` sim days, otherwise move
 * it toward the day its age in real time calls for — at most
 * `maxDays` (3) per call, each day fully processed before the next.
 */
export async function advanceDemoWorld(
  db: Db,
  { now = new Date(), ensure = false, maxDays = DEMO_MAX_CATCH_UP_DAYS }: { now?: Date; ensure?: boolean; maxDays?: number } = {},
): Promise<DemoAdvanceReport> {
  const report: DemoAdvanceReport = { worldId: null, created: false, days: 0, simDay: 0, stress: [], reset: null, errors: [] };
  if (ensure) {
    const ensured = await ensureDemoWorld(db, now);
    report.created = ensured.created;
  }
  let world = await findDemoWorld(db);
  if (!world) {
    return report;
  }
  report.worldId = world.id;
  const { day: startDay } = await getSimDay(db, world.id, now);
  report.simDay = startDay;
  if (startDay >= DEMO_RESET_SIM_DAYS) {
    report.reset = await resetDemoWorld(db, world.id, now);
    if (report.reset) {
      report.worldId = report.reset.worldId;
      report.simDay = 0;
    }
    return report;
  }
  const target = Math.min(demoTargetDay(world.createdAt, now), DEMO_RESET_SIM_DAYS);
  while (report.days < maxDays) {
    const day = await claimNextDay(db, world.id, target);
    if (day === null) {
      break;
    }
    const outcome = await runDemoDay(db, world, day);
    report.days += 1;
    report.simDay = day;
    if (outcome.stress) {
      report.stress.push(outcome.stress);
    }
    report.errors.push(...outcome.errors.map((e) => `day ${day} ${e}`));
    // The row may have changed (bot day counter); re-read for the next day.
    world = (await findDemoWorld(db)) ?? world;
  }
  if (report.days > 0) {
    invalidateConsoleSnapshot(world.id);
  }
  return report;
}
