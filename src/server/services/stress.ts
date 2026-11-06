import { and, eq, inArray } from "drizzle-orm";

import { botCall } from "../bots/act";
import { redeemableUnits, type BotRef } from "../bots/lenderBot";
import { rngFor } from "../bots/rng";
import { worldBots } from "../bots/runner";
import { getSimDay } from "../clock/clock";
import type { Db } from "../db/client";
import { events } from "../db/schema";
import { scoped } from "../db/scoped";
import { RATE_SPIKE_EVENT } from "./economy";
import { ownedPrivateWorld } from "./privateWorldAccess";

/**
 * P5 Task 4: stress scenarios a private world's owner can trigger from
 * `/dashboard/worlds/[id]` (POST `/dashboard/worlds/[id]/stress`). Private
 * worlds only, owner only: the main world, someone else's world, an
 * archived one or a malformed id → `not_found`, nothing recorded
 * (`ownedPrivateWorld`; Review Focus 5).
 *
 * - `default_wave`: the next 3 borrower-bot loans accepted in the world
 *   skip repayment (their invoice clients never pay, the bot never repays),
 *   so they walk the delinquency ladder to charge-off. Each such loan gets a
 *   `stress.default_wave_loan` marker event (aggregate = the loan) when the
 *   bot accepts it.
 * - `note_run`: every lender bot asks to redeem ALL its redeemable notes at
 *   once, through `redeem_notes` — paid while cash allows, the rest
 *   `QUEUED` behind the reserve floor (FIFO). The lenders go in a seeded order.
 * - `rate_spike`: the base rate jumps +500 bps at the world's next economy
 *   step (sim day + 1; `stepEconomy`), then the walk's mean reversion pulls
 *   it back.
 *
 * Each is one `events` row (`stress.<scenario>`, aggregate = the world)
 * with its parameters — what was drawn from the world's seed included —
 * and, for a note run, what each lender's request returned.
 */

export const STRESS_SCENARIOS = ["default_wave", "note_run", "rate_spike"] as const;
export type StressScenario = (typeof STRESS_SCENARIOS)[number];

export const DEFAULT_WAVE_LOANS = 3;
export const RATE_SPIKE_BPS = 500;

export const STRESS_EVENT: Record<StressScenario, string> = {
  default_wave: "stress.default_wave",
  note_run: "stress.note_run",
  rate_spike: RATE_SPIKE_EVENT,
};
export const DEFAULT_WAVE_LOAN_EVENT = "stress.default_wave_loan";

export function isStressScenario(value: unknown): value is StressScenario {
  return typeof value === "string" && (STRESS_SCENARIOS as readonly string[]).includes(value);
}

export type StressOutcome =
  | { outcome: "triggered"; scenario: StressScenario; eventId: string; simDay: number; params: Record<string, unknown> }
  | { outcome: "not_found" }
  | { outcome: "invalid" };

/** Seeded order: sort by a per-bot draw from the world seed and the day. */
function seededOrder(seed: string, day: number, bots: BotRef[]): BotRef[] {
  return bots
    .map((bot, index) => ({ bot, key: rngFor(seed, "stress", "note_run", day, index)() }))
    .sort((a, b) => a.key - b.key)
    .map((entry) => entry.bot);
}

/** Triggers `scenario` in the owner's private world (see the module comment). */
export async function triggerStressScenario(
  db: Db,
  principalId: string,
  worldId: string,
  scenario: unknown,
): Promise<StressOutcome> {
  const world = await ownedPrivateWorld(db, principalId, worldId);
  if (!world) {
    return { outcome: "not_found" };
  }
  if (!isStressScenario(scenario)) {
    return { outcome: "invalid" };
  }
  const seed = world.botSeed ?? world.id;
  const { day, simNow } = await getSimDay(db, world.id);
  let params: Record<string, unknown>;
  switch (scenario) {
    case "default_wave":
      params = { loans: DEFAULT_WAVE_LOANS };
      break;
    case "rate_spike":
      params = { bump_bps: RATE_SPIKE_BPS, apply_sim_day: day + 1 };
      break;
    case "note_run": {
      const { lenders } = await worldBots(db, world.id);
      const order = seededOrder(seed, day, lenders);
      const requests: Array<{ bot: string; amount_cents: number; status: string; queue_position?: number }> = [];
      for (const lender of order) {
        const units = await redeemableUnits(db, world.id, lender.id);
        if (units <= 0n) {
          continue;
        }
        const redeemed = await botCall(db, lender.id, "redeem_notes", { amount_cents: Number(units) });
        const queue = ((redeemed.data ?? {}) as { queue?: { position?: number } }).queue;
        requests.push({
          bot: lender.name,
          amount_cents: Number(units),
          status: redeemed.status,
          ...(typeof queue?.position === "number" ? { queue_position: queue.position } : {}),
        });
      }
      params = { order: order.map((bot) => bot.name), requests };
      break;
    }
  }
  const [event] = await scoped(db, world.id).insert(events, {
    type: STRESS_EVENT[scenario],
    aggregateType: "world",
    aggregateId: world.id,
    payload: { scenario, sim_day: day, seed, params },
    occurredSimAt: simNow,
  });
  return { outcome: "triggered", scenario, eventId: event!.id, simDay: day, params };
}

/**
 * Called when a borrower bot has just accepted `loanId`: if a
 * `default_wave` still has loans to take, the loan is marked to skip
 * repayment (oldest wave first). Returns whether it was marked.
 */
export async function markDefaultWaveLoan(db: Db, worldId: string, loanId: string): Promise<boolean> {
  const waves = (await scoped(db, worldId).select(events, eq(events.type, STRESS_EVENT.default_wave))).sort((a, b) =>
    a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0,
  );
  if (waves.length === 0) {
    return false;
  }
  const marks = await scoped(db, worldId).select(events, eq(events.type, DEFAULT_WAVE_LOAN_EVENT));
  if (marks.some((mark) => mark.aggregateId === loanId)) {
    return true;
  }
  for (const wave of waves) {
    const wanted = Number(((wave.payload ?? {}) as { params?: { loans?: number } }).params?.loans ?? 0);
    const taken = marks.filter((mark) => (mark.payload as { wave_id?: string } | null)?.wave_id === wave.id).length;
    if (taken < wanted) {
      const { simNow } = await getSimDay(db, worldId);
      await scoped(db, worldId).insert(events, {
        type: DEFAULT_WAVE_LOAN_EVENT,
        aggregateType: "loan",
        aggregateId: loanId,
        payload: { wave_id: wave.id, nth: taken + 1 },
        occurredSimAt: simNow,
      });
      return true;
    }
  }
  return false;
}

/** Whether a `default_wave` marked this loan to skip repayment. */
export async function skipsRepayment(db: Db, worldId: string, loanId: string): Promise<boolean> {
  const [mark] = await scoped(db, worldId).select(
    events,
    and(eq(events.type, DEFAULT_WAVE_LOAN_EVENT), eq(events.aggregateId, loanId))!,
  );
  return Boolean(mark);
}

export interface StressEventView {
  id: string;
  scenario: StressScenario;
  simDay: number;
  occurredSimAt: Date;
  params: Record<string, unknown>;
  /** default_wave: loans marked so far. */
  loansTaken?: number;
}

/** The world's stress scenarios, newest first (at most `limit`). */
export async function recentStressEvents(db: Db, worldId: string, limit = 10): Promise<StressEventView[]> {
  const rows = (
    await scoped(db, worldId).select(events, inArray(events.type, Object.values(STRESS_EVENT)))
  ).sort((a, b) => (a.seq < b.seq ? 1 : a.seq > b.seq ? -1 : 0));
  const marks = await scoped(db, worldId).select(events, eq(events.type, DEFAULT_WAVE_LOAN_EVENT));
  return rows.slice(0, limit).map((row) => {
    const payload = (row.payload ?? {}) as { scenario?: StressScenario; sim_day?: number; params?: Record<string, unknown> };
    const scenario = payload.scenario ?? "default_wave";
    return {
      id: row.id,
      scenario,
      simDay: payload.sim_day ?? 0,
      occurredSimAt: row.occurredSimAt,
      params: payload.params ?? {},
      ...(scenario === "default_wave"
        ? { loansTaken: marks.filter((mark) => (mark.payload as { wave_id?: string } | null)?.wave_id === row.id).length }
        : {}),
    };
  });
}
