import type { Db } from "../db/client";
import { simApprove } from "../rail/simHandler";
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
