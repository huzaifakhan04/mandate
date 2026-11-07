import { and, eq, inArray } from "drizzle-orm";

import { getSimDay, getSimNow } from "../clock/clock";
import type { Db } from "../db/client";
import { agents, events, principals, worlds } from "../db/schema";
import { scoped } from "../db/scoped";
import { hashIp, signTerms } from "../services/mandates";
import type { BotAction } from "./act";
import { borrowerArchetype, borrowerDay, borrowerDayV2, type BorrowerArchetype } from "./borrowerBot";
import { lenderBuy, lenderDay, lenderDayV2, type BotRef } from "./lenderBot";

/**
 * P2 Task 6: the private-world bot runner.
 *
 * - `insertBots` (inside the world-creation transaction): 2 lender bots
 *   (unclaimed, tier 0 — lending needs no claim) and 2 borrower bots
 *   claimed by the world's system "bot principal" with a signed mandate
 *   (P5 bots v2: 4 lenders and 6 borrowers, each borrower claimed by its
 *   own system principal).
 * - `seedBots` (after commit): the lenders buy 20000 and 15000 of notes
 *   (v2: 20000, 15000, 15000, 10000).
 * - `runBotsCatchUp`: the bots act once per simulated day the world's
 *   clock has moved past `worlds.last_bot_sim_day` (at most `maxDays` per
 *   call). Each day is claimed with a conditional update before it runs,
 *   so concurrent ticks / clicks never run a day twice, and a frozen
 *   clock means no actions however often the cron ticks.
 *
 * Bots act through `runTool` (see `act.ts`); their worlds are sim-only.
 */

export const LENDER_BOT_NAMES = ["Lender bot · Ada", "Lender bot · Grace"] as const;
export const BORROWER_BOT_NAMES = ["Borrower bot · Atlas", "Borrower bot · Juno"] as const;
export const SEED_NOTE_PURCHASES_CENTS = [20000, 15000] as const;

/**
 * P5 Task 4 — bots v2 (`worlds.bot_version` = 2, every private world
 * created from now on): 4 lenders that react to the real return
 * (`lenderDayV2`) and 6 borrowers with seeded archetypes
 * (`borrowerDayV2`). The first names are the P2 ones, so a v1 world's
 * bots are the head of each list.
 */
export const LENDER_BOT_NAMES_V2 = [...LENDER_BOT_NAMES, "Lender bot · Hopper", "Lender bot · Turing"] as const;
export const BORROWER_BOT_NAMES_V2 = [
  ...BORROWER_BOT_NAMES,
  "Borrower bot · Vega",
  "Borrower bot · Orion",
  "Borrower bot · Lyra",
  "Borrower bot · Nova",
] as const;
export const SEED_NOTE_PURCHASES_CENTS_V2 = [20000, 15000, 15000, 10000] as const;
/** The bot generation new private worlds get. */
export const CURRENT_BOT_VERSION = 2;

function botNames(version: number): { lenders: readonly string[]; borrowers: readonly string[] } {
  return version >= 2
    ? { lenders: LENDER_BOT_NAMES_V2, borrowers: BORROWER_BOT_NAMES_V2 }
    : { lenders: LENDER_BOT_NAMES, borrowers: BORROWER_BOT_NAMES };
}

async function worldBotVersion(db: Db, worldId: string): Promise<{ version: number; seed: string }> {
  const [world] = await db
    .select({ id: worlds.id, botVersion: worlds.botVersion, botSeed: worlds.botSeed })
    .from(worlds)
    .where(eq(worlds.id, worldId))
    .limit(1);
  return { version: world?.botVersion ?? 1, seed: world?.botSeed ?? world?.id ?? worldId };
}
export const BOT_OPERATOR = "Mandate bots";
export const BOT_MODEL = "simulated";

/** The borrower bots' standing mandate (signed by the bot principal). */
export const BOT_MANDATE = {
  maxPerLoanCents: 15000n,
  maxTotalOwedCents: 40000n,
  maxFeeBps: 1000,
  maxTermDays: 30,
  eligibleCollateral: ["invoice_link"],
  expiresAt: null,
} as const;

/** A per-bot payout receiver on the sim rail (never "fail"/"unclaimed"/"pending", which the sim rail treats specially). */
function botReceiver(name: string): string {
  const handle = name.split("·").pop()!.trim().toLowerCase();
  return `${handle}.bot@sim.mandate.bots`;
}

/** Bots v2: a borrower bot's own system principal (simulated identity checks). */
async function insertBorrowerPrincipal(tx: Db, botName: string, now: Date): Promise<string> {
  const handle = botName.split("·").pop()!.trim();
  const [principal] = await tx
    .insert(principals)
    .values({
      email: `${handle.toLowerCase()}.principal@sim.mandate.bots`,
      name: `Mandate bots · ${handle}`,
      entityType: "system",
      verifiedAt: now,
      kycStatus: "simulated",
      sanctionsStatus: "simulated",
    })
    .returning();
  return principal!.id;
}

/** Inserts the world's bots (4 for v1, 10 for v2); signs the borrowers' mandates. Run inside the world-creation transaction. */
export async function insertBots(tx: Db, worldId: string, botPrincipalId: string, now: Date, version = 1): Promise<void> {
  const names = botNames(version);
  const base = {
    operator: BOT_OPERATOR,
    model: BOT_MODEL,
    codeManifestHash: "simulated-bot",
    status: "active",
    isBot: true,
    payoutReceiverType: "email",
    registeredSimAt: await getSimNow(tx, worldId, now),
  } as const;
  for (const name of names.lenders) {
    await scoped(tx, worldId).insert(agents, { ...base, name, payoutReceiver: botReceiver(name) });
  }
  for (const name of names.borrowers) {
    // Bots v2: each borrower bot has its own system principal — independent
    // simulated borrowers, so one bot's default freezes only its own mandate
    // and the concentration limit counts each bot as its own obligor.
    const principalId = version >= 2 ? await insertBorrowerPrincipal(tx, name, now) : botPrincipalId;
    const [bot] = await scoped(tx, worldId).insert(agents, {
      ...base,
      name,
      payoutReceiver: botReceiver(name),
      principalId,
      claimedAt: now,
    });
    const signed = await signTerms(
      tx,
      worldId,
      principalId,
      bot!.id,
      { ...BOT_MANDATE, eligibleCollateral: [...BOT_MANDATE.eligibleCollateral] },
      BOT_OPERATOR,
      hashIp("bot"),
      now,
    );
    if (signed.outcome !== "signed") {
      throw new Error(`Expected the bot mandate to be signed for ${name}`);
    }
  }
}

export interface WorldBots {
  lenders: BotRef[];
  borrowers: BotRef[];
}

export async function worldBots(db: Db, worldId: string): Promise<WorldBots> {
  const rows = await scoped(db, worldId).select(agents, eq(agents.isBot, true));
  const refs = rows.map((row) => ({ id: row.id, name: row.name }));
  return {
    lenders: LENDER_BOT_NAMES_V2.flatMap((name) => refs.filter((ref) => ref.name === name)),
    borrowers: BORROWER_BOT_NAMES_V2.flatMap((name) => refs.filter((ref) => ref.name === name)),
  };
}

/** After the world commits: the lender bots fund the pool (v1 20000 + 15000; v2 20000 + 15000 + 15000 + 10000). */
export async function seedBots(db: Db, worldId: string): Promise<BotAction[]> {
  const { lenders } = await worldBots(db, worldId);
  const { version } = await worldBotVersion(db, worldId);
  const amounts: readonly number[] = version >= 2 ? SEED_NOTE_PURCHASES_CENTS_V2 : SEED_NOTE_PURCHASES_CENTS;
  const actions: BotAction[] = [];
  for (const [i, lender] of lenders.entries()) {
    actions.push(await lenderBuy(db, lender, amounts[i] ?? 10000));
  }
  await recordBotDay(db, worldId, 0, actions);
  return actions;
}

async function recordBotDay(db: Db, worldId: string, day: number, actions: BotAction[]): Promise<void> {
  const { simNow } = await getSimDay(db, worldId);
  await scoped(db, worldId).insert(events, {
    type: "bot.day",
    aggregateType: "world",
    aggregateId: worldId,
    payload: { day, actions },
    occurredSimAt: simNow,
  });
}

function errorText(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : "unknown error";
}

/**
 * One simulated day of bot activity: lenders first (so new money is
 * there), then borrowers. One bot's failure is logged and recorded and
 * never stops the others.
 */
export async function runBotDay(db: Db, worldId: string, seed: string, day: number): Promise<BotAction[]> {
  const { anchorSim } = await getSimDay(db, worldId);
  const { lenders, borrowers } = await worldBots(db, worldId);
  const { version } = await worldBotVersion(db, worldId);
  const actions: BotAction[] = [];
  const attempt = async (bot: BotRef, run: () => Promise<BotAction[]>) => {
    try {
      actions.push(...(await run()));
    } catch (err) {
      console.error(`[bots] world ${worldId} day ${day} ${bot.name} failed: ${errorText(err)}`);
      actions.push({ bot: bot.name, action: "error", status: "INTERNAL_ERROR" });
    }
  };
  for (const [i, lender] of lenders.entries()) {
    await attempt(lender, () =>
      version >= 2 ? lenderDayV2(db, worldId, seed, day, i, lender) : lenderDay(db, seed, day, i, lender),
    );
  }
  for (const [i, borrower] of borrowers.entries()) {
    await attempt(borrower, () =>
      version >= 2
        ? borrowerDayV2(db, worldId, seed, day, i, anchorSim, borrower)
        : borrowerDay(db, worldId, seed, day, i, anchorSim, borrower),
    );
  }
  await recordBotDay(db, worldId, day, actions);
  return actions;
}

/**
 * Runs the bots for each simulated day the world's clock has passed since
 * `last_bot_sim_day`, oldest first, at most `maxDays`. Returns how many
 * days ran (0 for a frozen clock, a non-private or an archived world).
 */
export async function runBotsCatchUp(
  db: Db,
  worldId: string,
  { maxDays = 7, now = new Date() }: { maxDays?: number; now?: Date } = {},
): Promise<number> {
  const [world] = await db
    .select()
    .from(worlds)
    .where(and(eq(worlds.id, worldId), inArray(worlds.kind, ["private", "demo"]), eq(worlds.status, "active")))
    .limit(1);
  if (!world) {
    return 0;
  }
  const seed = world.botSeed ?? world.id;
  const { day: today } = await getSimDay(db, worldId, now);
  let last = world.lastBotSimDay ?? 0;
  let ran = 0;
  while (last < today && ran < maxDays) {
    const day = last + 1;
    // Claim the day first: only one caller ever runs it.
    const claimed = await db
      .update(worlds)
      .set({ lastBotSimDay: day })
      .where(and(eq(worlds.id, worldId), eq(worlds.lastBotSimDay, last), eq(worlds.status, "active")))
      .returning();
    if (claimed.length === 0) {
      break;
    }
    await runBotDay(db, worldId, seed, day);
    last = day;
    ran += 1;
  }
  return ran;
}

/** P5 bots v2: each borrower bot's archetype (by bot id), for the world page; empty for a v1 world. */
export async function borrowerArchetypes(db: Db, worldId: string): Promise<Map<string, BorrowerArchetype>> {
  const { version, seed } = await worldBotVersion(db, worldId);
  const out = new Map<string, BorrowerArchetype>();
  if (version < 2) {
    return out;
  }
  const { borrowers } = await worldBots(db, worldId);
  for (const [i, borrower] of borrowers.entries()) {
    out.set(borrower.id, borrowerArchetype(seed, i));
  }
  return out;
}
