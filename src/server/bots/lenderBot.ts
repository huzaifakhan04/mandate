import { and, eq, inArray } from "drizzle-orm";

import type { Db } from "../db/client";
import { notePositions, noteTransactions } from "../db/schema";
import { scoped } from "../db/scoped";
import { OPEN_REDEMPTION_STATUSES } from "../domain/treasury";
import { simApprove } from "../rail/simHandler";
import { currentEconomy, liveUtilization } from "../services/economy";
import { botCall, dataOf, type BotAction } from "./act";
import { intBetween, rngFor } from "./rng";

/**
 * P2 Task 6: a lender bot. It buys notes exactly as an agent does —
 * `buy_notes`, then the sim payer approves the checkout, then
 * `confirm_checkout` — and redeems with `redeem_notes`. Private worlds
 * are sim-only, so this never touches PayPal.
 */

export interface BotRef {
  id: string;
  name: string;
}

/** Buys `amountCents` of notes (buy → sim approve → confirm). Returns the final status. */
export async function lenderBuy(db: Db, bot: BotRef, amountCents: number): Promise<BotAction> {
  const bought = await botCall(db, bot.id, "buy_notes", { amount_cents: amountCents });
  const checkoutId = dataOf(bought).checkout_id;
  if (typeof checkoutId !== "string") {
    return { bot: bot.name, action: "buy_notes", amountCents, status: bought.status };
  }
  await simApprove(db, checkoutId, { email: "lender-bot@sim.mandate.bots", givenName: "Lender", surname: "Bot" });
  const confirmed = await botCall(db, bot.id, "confirm_checkout", { checkout_id: checkoutId });
  return { bot: bot.name, action: "buy_notes", amountCents, status: confirmed.status };
}

/**
 * One simulated day for lender bot number `index`: about one day in five
 * it buys 1000–5000 more; about one in seven it redeems 1000–3000 (a
 * redemption the pool can't cover right now is simply refused).
 */
export async function lenderDay(db: Db, seed: string, day: number, index: number, bot: BotRef): Promise<BotAction[]> {
  const rng = rngFor(seed, "lender", index, day);
  const roll = rng();
  if (roll < 0.2) {
    return [await lenderBuy(db, bot, intBetween(rng, 10, 50) * 100)];
  }
  if (roll < 0.34) {
    const amountCents = intBetween(rng, 10, 30) * 100;
    const redeemed = await botCall(db, bot.id, "redeem_notes", { amount_cents: amountCents });
    return [{ bot: bot.name, action: "redeem_notes", amountCents, status: redeemed.status }];
  }
  return [];
}

/** The bot's notes it could still ask to redeem: units − its pending and queued redemptions. */
export async function redeemableUnits(db: Db, worldId: string, agentId: string): Promise<bigint> {
  const positions = await scoped(db, worldId).select(notePositions, eq(notePositions.agentId, agentId));
  if (positions.length === 0) {
    return 0n;
  }
  const open = await scoped(db, worldId).select(
    noteTransactions,
    and(
      inArray(
        noteTransactions.positionId,
        positions.map((position) => position.id),
      ),
      eq(noteTransactions.kind, "redeem"),
      inArray(noteTransactions.status, [...OPEN_REDEMPTION_STATUSES]),
    )!,
  );
  const units = positions.reduce((sum, position) => sum + position.units, 0n);
  return units - open.reduce((sum, row) => sum + row.amountCents, 0n);
}

/** P5 bots v2: a lender buys more above this real return (annual bps)… */
export const LENDER_BUY_ABOVE_REAL_BPS = 200;
/** …and redeems below this one. */
export const LENDER_REDEEM_BELOW_REAL_BPS = 0;

/**
 * The real return a v2 lender bot reacts to: what the pool charges for
 * money today — the base rate plus the live utilization premium — minus
 * the world's annual inflation rate (annual bps). A rate spike or a busy
 * pool raises it; inflation above the rate makes it negative.
 */
export async function lenderRealReturnBps(db: Db, worldId: string): Promise<number> {
  const economy = await currentEconomy(db, worldId);
  const live = await liveUtilization(db, worldId);
  return economy.baseRateBps + live.premiumBps - economy.inflationRateBps;
}

async function redeemSome(db: Db, worldId: string, bot: BotRef, wantedCents: number): Promise<BotAction[]> {
  const redeemable = await redeemableUnits(db, worldId, bot.id);
  const amountCents = Math.min(wantedCents, Number(redeemable));
  if (amountCents <= 0) {
    return [];
  }
  const redeemed = await botCall(db, bot.id, "redeem_notes", { amount_cents: amountCents });
  return [{ bot: bot.name, action: "redeem_notes", amountCents, status: redeemed.status }];
}

/**
 * P5 bots v2: one simulated day for lender bot number `index`, reacting to
 * the real return (`lenderRealReturnBps`): above 2% it buys 1000–5000 on
 * about one day in three; below 0 it redeems 1000–3000 (never more than it
 * can) on about one day in three; in between it trades lightly (buys about
 * one day in seven, redeems about one in ten). Seeded per world, bot and day.
 */
export async function lenderDayV2(
  db: Db,
  worldId: string,
  seed: string,
  day: number,
  index: number,
  bot: BotRef,
): Promise<BotAction[]> {
  const realBps = await lenderRealReturnBps(db, worldId);
  const rng = rngFor(seed, "lender-v2", index, day);
  const roll = rng();
  const buyCents = intBetween(rng, 10, 50) * 100;
  const redeemCents = intBetween(rng, 10, 30) * 100;
  if (realBps > LENDER_BUY_ABOVE_REAL_BPS) {
    return roll < 0.35 ? [await lenderBuy(db, bot, buyCents)] : [];
  }
  if (realBps < LENDER_REDEEM_BELOW_REAL_BPS) {
    return roll < 0.35 ? redeemSome(db, worldId, bot, redeemCents) : [];
  }
  if (roll < 0.15) {
    return [await lenderBuy(db, bot, buyCents)];
  }
  if (roll < 0.25) {
    return redeemSome(db, worldId, bot, redeemCents);
  }
  return [];
}
