import { and, count, eq } from "drizzle-orm";

import { advanceClock, getSimDay } from "../clock/clock";
import { insertBots, runBotsCatchUp, seedBots } from "../bots/runner";
import type { Db } from "../db/client";
import { agents, events, loans, notePositions, principals, worlds } from "../db/schema";
import { scoped } from "../db/scoped";
import { availableLiquidity } from "../domain/liquidity";
import { OPEN_LOAN_DB_STATUSES } from "../domain/loanMachine";
import { trialBalance } from "../ledger/trialBalance";
import { listOwnedPrivateWorlds, ownedPrivateWorld, type WorldRow } from "./privateWorldAccess";
import { createWorldInTx } from "./worlds";

export { ownedPrivateWorld, resolveDashboardWorld } from "./privateWorldAccess";

/**
 * P2 Task 6: private sandbox worlds. A verified principal may run up to
 * three at once. Each is sim-rail only (no PayPal, ever — Review Focus 5),
 * opens with 2 lender bots that fund the pool (20000 + 15000) and 2
 * borrower bots claimed by the world's system "bot principal" under a
 * signed mandate, and has a frozen clock the owner moves with +1 / +7
 * days — the bots act once per simulated day. "Reset" archives the world
 * and opens a fresh one with the same name.
 *
 * Every action takes the principal and checks ownership
 * (`ownedPrivateWorld`): someone else's world, an archived one or a
 * malformed id → `not_found`.
 */

export const MAX_PRIVATE_WORLDS = 3;
export const MAX_ADVANCE_DAYS = 7;

export type CreatePrivateWorldOutcome =
  | { outcome: "created"; worldId: string }
  | { outcome: "limit" }
  | { outcome: "unverified" }
  | { outcome: "invalid" };

/** A world name: trimmed, whitespace collapsed, 1–60 characters; `null` if not. */
export function cleanWorldName(raw: unknown): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  const name = raw.trim().replace(/\s+/g, " ");
  return name.length >= 1 && name.length <= 60 ? name : null;
}

/**
 * Creates a private world for `principalId` — under the principal's row
 * lock, so concurrent creates can't pass the limit of 3 — with its bot
 * principal and bots; then (after commit) the lender bots fund the pool.
 */
export async function createPrivateWorld(
  db: Db,
  principalId: string,
  input: { name: unknown; seed?: string | null },
  now: Date = new Date(),
): Promise<CreatePrivateWorldOutcome> {
  const name = cleanWorldName(input.name);
  if (!/^[0-9a-f-]{36}$/i.test(principalId)) {
    return { outcome: "unverified" };
  }
  const created = await db.transaction(async (tx): Promise<CreatePrivateWorldOutcome> => {
    const [principal] = await tx.select().from(principals).where(eq(principals.id, principalId)).for("update");
    if (!principal || !principal.verifiedAt || principal.entityType === "system") {
      return { outcome: "unverified" };
    }
    if (!name) {
      return { outcome: "invalid" };
    }
    const [{ value: active } = { value: 0 }] = await tx
      .select({ value: count() })
      .from(worlds)
      .where(and(eq(worlds.ownerPrincipalId, principalId), eq(worlds.kind, "private"), eq(worlds.status, "active")));
    if (active >= MAX_PRIVATE_WORLDS) {
      return { outcome: "limit" };
    }
    return { outcome: "created", worldId: await createWorldWithBots(tx, principalId, name, input.seed ?? null, now) };
  });
  if (created.outcome === "created") {
    await seedBots(db, created.worldId);
  }
  return created;
}

/** The world row, its bot principal and its bots (inside the caller's transaction). */
async function createWorldWithBots(tx: Db, ownerId: string, name: string, seed: string | null, now: Date): Promise<string> {
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
    name,
    ownerPrincipalId: ownerId,
    railMode: "sim",
    kind: "private",
    botPrincipalId: botPrincipal!.id,
    botSeed: seed,
  });
  await insertBots(tx, worldId, botPrincipal!.id, now);
  return worldId;
}

export interface PrivateWorldSummary {
  id: string;
  name: string;
  simNow: Date;
  simDay: number;
  createdAt: Date;
}

export async function listPrivateWorlds(db: Db, principalId: string): Promise<PrivateWorldSummary[]> {
  const rows = await listOwnedPrivateWorlds(db, principalId);
  const out: PrivateWorldSummary[] = [];
  for (const world of rows) {
    const { simNow, day } = await getSimDay(db, world.id);
    out.push({ id: world.id, name: world.name, simNow, simDay: day, createdAt: world.createdAt });
  }
  return out;
}

export type AdvanceOutcome =
  | { outcome: "advanced"; simDay: number; simNow: Date }
  | { outcome: "not_found" }
  | { outcome: "invalid" };

/**
 * Moves the owner's world clock forward `days` (1–7) one day at a time,
 * running the bots for each day as it passes — so a loan taken on day 3
 * is disbursed on day 3, not on the last day of the jump.
 */
export async function advancePrivateWorld(
  db: Db,
  principalId: string,
  worldId: string,
  days: number,
): Promise<AdvanceOutcome> {
  const world = await ownedPrivateWorld(db, principalId, worldId);
  if (!world) {
    return { outcome: "not_found" };
  }
  if (!Number.isInteger(days) || days < 1 || days > MAX_ADVANCE_DAYS) {
    return { outcome: "invalid" };
  }
  for (let i = 0; i < days; i += 1) {
    await advanceClock(db, world.id, 1);
    await runBotsCatchUp(db, world.id, { maxDays: MAX_ADVANCE_DAYS });
  }
  const { simNow, day } = await getSimDay(db, world.id);
  return { outcome: "advanced", simDay: day, simNow };
}

export type ResetOutcome = { outcome: "reset"; worldId: string } | { outcome: "not_found" };

/**
 * Archives the owner's world (its agents stop: `WORLD_ARCHIVED`; crons
 * and the dashboard skip it) and opens a fresh one with the same name.
 * The old world is archived, never deleted — its ledger stays.
 */
export async function resetPrivateWorld(db: Db, principalId: string, worldId: string, now: Date = new Date()): Promise<ResetOutcome> {
  const created = await db.transaction(async (tx): Promise<ResetOutcome> => {
    await tx.select({ id: principals.id }).from(principals).where(eq(principals.id, principalId)).for("update");
    const world = await ownedPrivateWorld(tx, principalId, worldId);
    if (!world) {
      return { outcome: "not_found" };
    }
    const archived = await tx
      .update(worlds)
      .set({ status: "archived", archivedAt: now })
      .where(and(eq(worlds.id, world.id), eq(worlds.status, "active")))
      .returning();
    if (archived.length !== 1) {
      return { outcome: "not_found" };
    }
    return { outcome: "reset", worldId: await createWorldWithBots(tx, principalId, world.name, world.botSeed, now) };
  });
  if (created.outcome === "reset") {
    await seedBots(db, created.worldId);
  }
  return created;
}

// ---------------------------------------------------------------------
// The world page's read model
// ---------------------------------------------------------------------

export interface BotView {
  id: string;
  name: string;
  role: "lender" | "borrower";
  notesCents: bigint;
  openLoan: { status: string; principalCents: bigint; outstandingCents: bigint; dueSimAt: Date } | null;
  loansRepaid: number;
}

export interface BotDayView {
  day: number;
  occurredSimAt: Date;
  actions: Array<{ bot: string; action: string; amountCents?: number; status: string }>;
}

export interface PrivateWorldView {
  world: Pick<WorldRow, "id" | "name" | "slug" | "createdAt">;
  simNow: Date;
  simDay: number;
  liquidityCents: bigint;
  notesOutstandingCents: bigint;
  loansOutstandingCents: bigint;
  openLoans: number;
  repaidLoans: number;
  bots: BotView[];
  recentDays: BotDayView[];
  /** Σ of every posting in the world: always 0 for a balanced ledger. */
  trialBalanceCents: bigint;
}

export const RECENT_BOT_DAYS = 8;

export async function privateWorldView(db: Db, principalId: string, worldId: string): Promise<PrivateWorldView | null> {
  const world = await ownedPrivateWorld(db, principalId, worldId);
  if (!world) {
    return null;
  }
  const w = scoped(db, world.id);
  const { simNow, day } = await getSimDay(db, world.id);
  const botRows = await w.select(agents, eq(agents.isBot, true));
  const positions = await w.select(notePositions);
  const loanRows = await w.select(loans);
  const open = loanRows.filter((loan) => (OPEN_LOAN_DB_STATUSES as readonly string[]).includes(loan.status));
  const botIds = new Set(botRows.map((bot) => bot.id));

  const bots: BotView[] = botRows
    .map((bot) => {
      const openLoan = open.find((loan) => loan.agentId === bot.id);
      return {
        id: bot.id,
        name: bot.name,
        role: bot.principalId ? ("borrower" as const) : ("lender" as const),
        notesCents: positions.filter((p) => p.agentId === bot.id).reduce((sum, p) => sum + p.units, 0n),
        openLoan: openLoan
          ? {
              status: openLoan.status,
              principalCents: openLoan.principalCents,
              outstandingCents: openLoan.outstandingCents,
              dueSimAt: openLoan.dueSimAt,
            }
          : null,
        loansRepaid: loanRows.filter((loan) => loan.agentId === bot.id && loan.status === "repaid").length,
      };
    })
    .sort((a, b) => (a.role === b.role ? a.name.localeCompare(b.name) : a.role === "lender" ? -1 : 1));

  const dayEvents = (await w.select(events, and(eq(events.type, "bot.day"), eq(events.aggregateId, world.id))!)).sort(
    (a, b) => (a.seq < b.seq ? 1 : a.seq > b.seq ? -1 : 0),
  );
  const recentDays = dayEvents.slice(0, RECENT_BOT_DAYS).map((event) => {
    const payload = (event.payload ?? {}) as { day?: number; actions?: BotDayView["actions"] };
    return { day: payload.day ?? 0, occurredSimAt: event.occurredSimAt, actions: payload.actions ?? [] };
  });

  return {
    world: { id: world.id, name: world.name, slug: world.slug, createdAt: world.createdAt },
    simNow,
    simDay: day,
    liquidityCents: await availableLiquidity(db, world.id),
    notesOutstandingCents: positions.reduce((sum, p) => sum + p.units, 0n),
    loansOutstandingCents: open.reduce((sum, loan) => sum + loan.outstandingCents, 0n),
    openLoans: open.length,
    repaidLoans: loanRows.filter((loan) => loan.status === "repaid").length,
    bots: bots.filter((bot) => botIds.has(bot.id)),
    recentDays,
    trialBalanceCents: (await trialBalance(db, world.id)).totalCents,
  };
}
