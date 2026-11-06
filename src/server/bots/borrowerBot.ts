import { and, eq, inArray } from "drizzle-orm";

import { simDayIndex } from "../clock/clock";
import type { Db } from "../db/client";
import { loans, repaymentLinks } from "../db/schema";
import { scoped } from "../db/scoped";
import { isOwingStatus, OPEN_LOAN_DB_STATUSES } from "../domain/loanMachine";
import { simApprove } from "../rail/simHandler";
import { settleCheckoutByOrderId } from "../services/checkouts";
import { botCall, dataOf, type BotAction } from "./act";
import type { BotRef } from "./lenderBot";
import { intBetween, pick, rngFor } from "./rng";

/**
 * P2 Task 6: a borrower bot. With no open loan it applies for an
 * invoice-backed loan (2000–5000 cents against a ≥ 1.5× invoice, 7–21 days) and accepts the
 * offer — the same `apply_for_loan` / `accept_offer` tools, tier gate and
 * mandate checks any agent goes through. Its invoice client then pays the
 * repayment link (sim approve + `settleCheckoutByOrderId`, the same path
 * a PayPal webhook takes) on a seeded day before the loan is due.
 */

const PURPOSES = [
  "Working capital for a client invoice",
  "Cloud credits for a delivery sprint",
  "Contractor payment ahead of an invoice",
  "Inventory for a fulfilled order",
] as const;

const CLIENTS = ["acme", "globex", "initech", "umbrella", "hooli"] as const;

/**
 * The day (since the clock's anchor) this loan's client pays: seeded by
 * the bot and the disbursement day, somewhere in [disbursed + 1, due − 1].
 */
export function clientPayDay(seed: string, index: number, disbursedDay: number, dueDay: number): number {
  const rng = rngFor(seed, "client-pays", index, disbursedDay);
  return intBetween(rng, disbursedDay + 1, Math.max(disbursedDay + 1, dueDay - 1));
}

async function openLoan(db: Db, worldId: string, botId: string) {
  const [loan] = await scoped(db, worldId).select(
    loans,
    and(eq(loans.agentId, botId), inArray(loans.status, [...OPEN_LOAN_DB_STATUSES]))!,
  );
  return loan ?? null;
}

/** The client pays the loan's invoice link if today is its seeded pay day. */
async function maybeClientPays(
  db: Db,
  worldId: string,
  seed: string,
  day: number,
  index: number,
  anchorSim: Date,
  bot: BotRef,
  loan: typeof loans.$inferSelect,
): Promise<BotAction[]> {
  if (!isOwingStatus(loan.status) || !loan.disbursedSimAt) {
    return [];
  }
  const payDay = clientPayDay(seed, index, simDayIndex(anchorSim, loan.disbursedSimAt), simDayIndex(anchorSim, loan.dueSimAt));
  if (day < payDay) {
    return [];
  }
  const [link] = await scoped(db, worldId).select(
    repaymentLinks,
    and(eq(repaymentLinks.loanId, loan.id), eq(repaymentLinks.kind, "invoice"), eq(repaymentLinks.status, "open"))!,
  );
  if (!link?.paypalOrderId) {
    return [];
  }
  await simApprove(db, link.paypalOrderId, { email: "client@sim.mandate.bots", givenName: "Invoice", surname: "Client" });
  const settled = await settleCheckoutByOrderId(db, worldId, link.paypalOrderId);
  return [{ bot: bot.name, action: "client_paid_invoice", amountCents: Number(link.amountCents), status: settled.status }];
}

/** Applies for a seeded loan and accepts the offer. */
async function applyAndAccept(db: Db, rng: () => number, bot: BotRef): Promise<BotAction[]> {
  // P3 (Ruling P3-A): a new borrower is grade D at best, which auto-approves
  // up to 5000 cents, and only with an invoice covering ≥ 1.5× (collateral
  // 20 points). So the bots borrow 2000–5000 against a 1.5×+ invoice.
  const amountCents = intBetween(rng, 20, 50) * 100;
  const termDays = intBetween(rng, 7, 21);
  const invoiceCents = (amountCents * 3) / 2 + intBetween(rng, 0, 20) * 100;
  const client = pick(rng, CLIENTS);
  const applied = await botCall(db, bot.id, "apply_for_loan", {
    amount_cents: amountCents,
    term_days: termDays,
    purpose: pick(rng, PURPOSES),
    invoice: {
      client_email: `${client}@sim.mandate.bots`,
      amount_cents: invoiceCents,
      due_in_days: termDays,
      description: `Invoice to ${client}`,
    },
    // ALA sections E and H (P3 Task 4): required, else declaration_missing.
    declarations: { no_other_debt: true },
    attest: true,
  });
  const actions: BotAction[] = [{ bot: bot.name, action: "apply_for_loan", amountCents, status: applied.status }];
  if (applied.status !== "OFFERED") {
    return actions;
  }
  const offer = dataOf(applied);
  const accepted = await botCall(db, bot.id, "accept_offer", {
    offer_id: offer.offer_id,
    disclosure_hash: offer.disclosure_hash,
  });
  actions.push({ bot: bot.name, action: "accept_offer", amountCents, status: accepted.status });
  return actions;
}

/**
 * One simulated day for borrower bot number `index`: its client pays a
 * loan whose pay day has come; then, with no open loan, it applies (on
 * about three days in five) and accepts.
 */
export async function borrowerDay(
  db: Db,
  worldId: string,
  seed: string,
  day: number,
  index: number,
  anchorSim: Date,
  bot: BotRef,
): Promise<BotAction[]> {
  const actions: BotAction[] = [];
  const loan = await openLoan(db, worldId, bot.id);
  if (loan) {
    actions.push(...(await maybeClientPays(db, worldId, seed, day, index, anchorSim, bot, loan)));
    if (await openLoan(db, worldId, bot.id)) {
      return actions;
    }
  }
  const rng = rngFor(seed, "borrower", index, day);
  if (rng() < 0.6) {
    actions.push(...(await applyAndAccept(db, rng, bot)));
  }
  return actions;
}
