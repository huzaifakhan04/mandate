/**
 * P4 Task 2 — charge-off at +10 (allowance + note holders' loss sharing),
 * the principal's guarantee, recovery and the cure edge cases.
 *
 * Review Focus 1: the charge-off applies exactly once under concurrent
 * `processDue` (this file also runs on real Postgres under `test:pg`).
 * Review Focus 3: several holders share the loss pro rata, Σ = the loss,
 * and `units == −notes_payable[holder]` (Ruling T) holds throughout.
 * Review Focus 4: a guarantee paid on top of another payment (or after
 * recovery) is refunded as a remainder; nothing is credited twice.
 */
import { and, eq, like } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { advanceClock, getSimNow } from "@/server/clock/clock";
import type { Db } from "@/server/db/client";
import {
  agentNotices,
  agents,
  journalEntries,
  loanHolderLosses,
  loanLadderSteps,
  loans,
  notePositions,
  paypalOperations,
  principals,
  repaymentLinks,
  repayments,
} from "@/server/db/schema";
import { createTestDb } from "@/server/db/testing";
import { penaltyFor } from "@/server/domain/delinquency";
import { getAccountBalance, trialBalance } from "@/server/ledger/trialBalance";
import { simApprove } from "@/server/rail/simHandler";
import { settleCheckoutByOrderId } from "@/server/services/checkouts";
import { processDue } from "@/server/services/collections";
import { advancePrivateWorld } from "@/server/services/privateWorlds";
import { applyRedemptionPayoutOutcome, beginNoteRedemption } from "@/server/services/notes";
import { MAX_GUARANTEE_LINK_ISSUES, reissueGuaranteeLink } from "@/server/services/repayments";
import { runReconcile } from "@/server/jobs/reconcile";
import { approveOwnedSimCheckout } from "@/server/auth/simApproveRoutes";
import { createWorld } from "@/server/services/worlds";

import { call, createTestAgent, fundPool, type Data } from "../../helpers/world";

const DAY_MS = 86_400_000;
const INVOICE = { client_email: "client@example.com", amount_cents: 40000, due_in_days: 14, description: "Website build" };

async function borrow(
  db: Db,
  worldId: string,
  { invoice = false, kya = {} }: { invoice?: boolean; kya?: Parameters<typeof createTestAgent>[3] } = {},
) {
  const borrower = await createTestAgent(db, worldId, "borrower@example.com", kya);
  const applied = await call(db, "apply_for_loan", borrower.key, {
    amount_cents: 25000,
    term_days: 14,
    purpose: "Working capital",
    ...(invoice ? { invoice: INVOICE } : {}),
  });
  expect(applied.envelope.status).toBe("OFFERED");
  const offer = applied.envelope.data as Data;
  const accepted = await call(db, "accept_offer", borrower.key, {
    offer_id: offer.offer_id,
    disclosure_hash: offer.disclosure_hash,
  });
  expect(accepted.envelope.status).toBe("ACTIVE");
  return { ...borrower, loanId: (accepted.envelope.data as Data).loan_id as string };
}

async function loanRow(db: Db, loanId: string) {
  const [row] = await db.select().from(loans).where(eq(loans.id, loanId));
  return row!;
}

async function agentStatus(db: Db, agentId: string) {
  const [row] = await db.select().from(agents).where(eq(agents.id, agentId));
  return row!.status;
}

function at(due: Date, days: number): Date {
  return new Date(due.getTime() + days * DAY_MS);
}

async function expectBalanced(db: Db, worldId: string) {
  expect((await trialBalance(db, worldId)).totalCents).toBe(0n);
}

/** Ruling T: every holder's units equal what the bank owes them on the ledger. */
async function expectUnitsMatchLedger(db: Db, worldId: string) {
  const positions = await db.select().from(notePositions).where(eq(notePositions.worldId, worldId));
  for (const position of positions) {
    expect(-(await getAccountBalance(db, worldId, "notes_payable", position.agentId))).toBe(position.units);
  }
}

async function units(db: Db, agentId: string) {
  const [row] = await db.select().from(notePositions).where(eq(notePositions.agentId, agentId));
  return row!.units;
}

async function link(db: Db, loanId: string, kind: string) {
  const [row] = await db
    .select()
    .from(repaymentLinks)
    .where(and(eq(repaymentLinks.loanId, loanId), eq(repaymentLinks.kind, kind)));
  return row;
}

/** The owner (or client) approves a link's sim order; the cron/webhook path settles it. */
async function payLink(db: Db, worldId: string, loanId: string, kind: string) {
  const row = await link(db, loanId, kind);
  expect(row?.paypalOrderId).toBeTruthy();
  await simApprove(db, row!.paypalOrderId!);
  const settled = await settleCheckoutByOrderId(db, worldId, row!.paypalOrderId!);
  expect(settled.status).toBe("COMPLETED");
  return settled;
}

/** Direct repayment through repay_loan → sim approve → confirm_checkout. */
async function repay(db: Db, key: string, loanId: string, amountCents?: number) {
  const started = await call(db, "repay_loan", key, {
    loan_id: loanId,
    ...(amountCents === undefined ? {} : { amount_cents: amountCents }),
  });
  expect(started.envelope.status).toBe("AWAITING_APPROVAL");
  const checkoutId = (started.envelope.data as Data).checkout_id as string;
  await simApprove(db, checkoutId);
  const confirmed = await call(db, "confirm_checkout", key, { checkout_id: checkoutId });
  expect(confirmed.envelope.status).toBe("COMPLETED");
  return confirmed.envelope.data as Data;
}

/** Moves the world clock to at least `target` (so captures happen at that sim time). */
async function moveClockTo(db: Db, worldId: string, target: Date) {
  const now = await getSimNow(db, worldId);
  const days = Math.ceil((target.getTime() - now.getTime()) / DAY_MS);
  if (days > 0) {
    await advanceClock(db, worldId, days);
  }
  return getSimNow(db, worldId);
}

describe("charge-off, the guarantee and recovery (P4 Task 2)", () => {
  let db: Db;

  beforeEach(async () => {
    process.env.API_KEY_PEPPER = "test-pepper";
    db = await createTestDb();
  });

  afterEach(() => {
    delete process.env.API_KEY_PEPPER;
  });

  it("+10 charge-off exactly once under concurrent processDue; three holders share the 25000 loss pro rata; guarantee link; penalty stops", async () => {
    const worldId = (await createWorld(db, { name: "ChargeOff", ownerPrincipalId: null, railMode: "sim" })).worldId;
    const l1 = await fundPool(db, worldId, 10000, "l1@example.com");
    const l2 = await fundPool(db, worldId, 20000, "l2@example.com");
    const l3 = await fundPool(db, worldId, 7000, "l3@example.com");
    const borrower = await borrow(db, worldId);
    const sibling = await createTestAgent(db, worldId, "sibling@example.com", { principalId: borrower.principalId });
    const due = (await loanRow(db, borrower.loanId)).dueSimAt;
    await expectBalanced(db, worldId);

    // +9: substandard, not yet charged off.
    await processDue(db, worldId, at(due, 9));
    expect((await loanRow(db, borrower.loanId)).status).toBe("substandard");

    // Three concurrent runs at +12 (tick + manual advance + retry).
    const runs = await Promise.all([
      processDue(db, worldId, at(due, 12)),
      processDue(db, worldId, at(due, 12)),
      processDue(db, worldId, at(due, 12)),
    ]);
    expect(runs.flatMap((r) => r.errors)).toEqual([]);
    expect(runs.reduce((sum, r) => sum + r.steps.charged_off, 0)).toBe(1);

    const loan = await loanRow(db, borrower.loanId);
    // The penalty accrues through the charge-off day (10), not +12.
    const penalty = penaltyFor(25000n, 10);
    expect(loan.penaltyCents).toBe(penalty);
    expect(loan).toMatchObject({
      status: "charged_off",
      delinquencyStep: "charged_off",
      chargeOffPrincipalCents: 25000n,
      chargeOffTotalCents: 25000n + 333n + 500n + penalty,
      holdersLossCents: 25000n,
      recoveredCents: 0n,
      outstandingCents: 0n,
      lateFeeOutstandingCents: 0n,
      penaltyOutstandingCents: 0n,
    });
    expect(loan.chargedOffAt?.getTime()).toBe(at(due, 10).getTime());

    // Exactly one step row, one set of journals, one loss row per holder, one guarantee.
    const steps = await db
      .select()
      .from(loanLadderSteps)
      .where(and(eq(loanLadderSteps.loanId, borrower.loanId), eq(loanLadderSteps.step, "charged_off")));
    expect(steps).toHaveLength(1);
    const journals = await db
      .select()
      .from(journalEntries)
      .where(and(eq(journalEntries.worldId, worldId), like(journalEntries.idempotencyKey, `charge_off:${borrower.loanId}:%`)));
    expect(journals).toHaveLength(3);
    const losses = await db.select().from(loanHolderLosses).where(eq(loanHolderLosses.loanId, borrower.loanId));
    expect(losses).toHaveLength(3);
    expect(losses.reduce((sum, row) => sum + row.lossCents, 0n)).toBe(25000n);

    // Pro rata by units 10000 / 20000 / 7000 (largest remainder): 6757 / 13513 / 4730.
    const lossOf = (agentId: string) => losses.find((row) => row.agentId === agentId)!.lossCents;
    expect(lossOf(l1.agentId)).toBe(6757n);
    expect(lossOf(l2.agentId)).toBe(13513n);
    expect(lossOf(l3.agentId)).toBe(4730n);
    expect(await units(db, l1.agentId)).toBe(10000n - 6757n);
    expect(await units(db, l2.agentId)).toBe(20000n - 13513n);
    expect(await units(db, l3.agentId)).toBe(7000n - 4730n);
    await expectUnitsMatchLedger(db, worldId);

    // Allowance in and out; the holders bore the whole principal loss.
    expect(await getAccountBalance(db, worldId, "loans_receivable", null)).toBe(0n);
    expect(await getAccountBalance(db, worldId, "allowance_for_losses", null)).toBe(0n);
    expect(await getAccountBalance(db, worldId, "provision_expense", null)).toBe(0n);
    await expectBalanced(db, worldId);

    // The guarantee: one order.create (purpose guarantee) and an open link for the written-off total.
    const guarantee = await link(db, borrower.loanId, "guarantee");
    expect(guarantee).toMatchObject({ status: "open", amountCents: loan.chargeOffTotalCents });
    expect(guarantee!.approveUrl).toBeTruthy();
    const [owner] = await db.select().from(principals).where(eq(principals.id, borrower.principalId));
    expect(guarantee!.payerHint).toBe(owner!.email);
    const ops = await db
      .select()
      .from(paypalOperations)
      .where(and(eq(paypalOperations.worldId, worldId), eq(paypalOperations.purpose, "guarantee")));
    expect(ops).toHaveLength(1);
    expect(ops[0]!.sourceId).toBe(borrower.loanId);

    // Notices: charged_off once, to the agent and the owner.
    const notices = await db.select().from(agentNotices).where(eq(agentNotices.loanId, borrower.loanId));
    const chargedOff = notices.filter((n) => n.kind === "charged_off");
    expect(chargedOff).toHaveLength(1);
    expect(chargedOff[0]!.principalId).toBe(borrower.principalId);

    // Still restricted, the mandate still frozen.
    expect(await agentStatus(db, borrower.agentId)).toBe("restricted");
    const declined = await call(db, "apply_for_loan", sibling.key, { amount_cents: 2000, term_days: 7, purpose: "Operations" });
    expect(declined.envelope.reason_codes).toContain("delinquent_principal");

    // get_loan shows it; later runs change nothing (the penalty has stopped).
    const got = (await call(db, "get_loan", borrower.key, { loan_id: borrower.loanId })).envelope;
    expect(got.data).toMatchObject({
      status: "CHARGED_OFF",
      total_due_cents: Number(loan.chargeOffTotalCents),
      charge_off: {
        written_off_cents: Number(loan.chargeOffTotalCents),
        recovered_cents: 0,
        guarantee_link: { url: guarantee!.approveUrl, amount_cents: Number(loan.chargeOffTotalCents), status: "OPEN" },
      },
    });
    expect(got.next_actions[0]).toMatchObject({ tool: "repay_loan" });
    await processDue(db, worldId, at(due, 30));
    expect(await loanRow(db, borrower.loanId)).toEqual(loan);
    await expectBalanced(db, worldId);
  });

  it("holders' units below the principal: they lose all of it, the bank the rest; guarantee paid → RECOVERED, holders made whole, agent active", async () => {
    // 12000 + 8000 of notes and the bank's 10000 seed capital fund the 25000 loan.
    const worldId = (await createWorld(db, { name: "Capped", ownerPrincipalId: null, railMode: "sim" })).worldId;
    const l1 = await fundPool(db, worldId, 12000, "l1@example.com");
    const l2 = await fundPool(db, worldId, 8000, "l2@example.com");
    const borrower = await borrow(db, worldId);
    const due = (await loanRow(db, borrower.loanId)).dueSimAt;

    await moveClockTo(db, worldId, at(due, 10));
    await processDue(db, worldId, await getSimNow(db, worldId));
    const loan = await loanRow(db, borrower.loanId);
    expect(loan.status).toBe("charged_off");
    expect(loan.holdersLossCents).toBe(20000n);
    expect(await units(db, l1.agentId)).toBe(0n);
    expect(await units(db, l2.agentId)).toBe(0n);
    // The bank's own loss: 5000 of principal.
    expect(await getAccountBalance(db, worldId, "provision_expense", null)).toBe(5000n);
    await expectUnitsMatchLedger(db, worldId);
    await expectBalanced(db, worldId);
    const feesBefore = await getAccountBalance(db, worldId, "paypal_fees_expense", null);

    // The owner pays the guarantee (no agent online: the cron/webhook path settles it).
    const settled = await payLink(db, worldId, borrower.loanId, "guarantee");
    expect(settled.data).toMatchObject({
      loan_status: "RECOVERED",
      applied_recovery_cents: Number(loan.chargeOffTotalCents),
      remainder_cents: 0,
    });
    const after = await loanRow(db, borrower.loanId);
    expect(after.status).toBe("recovered");
    expect(after.recoveredCents).toBe(loan.chargeOffTotalCents);
    expect(await units(db, l1.agentId)).toBe(12000n);
    expect(await units(db, l2.agentId)).toBe(8000n);
    await expectUnitsMatchLedger(db, worldId);
    // The bank keeps what it recovered beyond the holders' 20000.
    expect(await getAccountBalance(db, worldId, "recoveries_income", null)).toBe(-(loan.chargeOffTotalCents - 20000n));
    // Task 10b: PayPal's fee on the guarantee capture is still the bank's expense.
    expect(await getAccountBalance(db, worldId, "paypal_fees_expense", null)).toBeGreaterThan(feesBefore);
    expect(await agentStatus(db, borrower.agentId)).toBe("active");
    const notices = await db.select().from(agentNotices).where(eq(agentNotices.loanId, borrower.loanId));
    expect(notices.map((n) => n.kind)).toContain("recovered");
    // Settling the same order again changes nothing.
    const guarantee = await link(db, borrower.loanId, "guarantee");
    expect((await settleCheckoutByOrderId(db, worldId, guarantee!.paypalOrderId!)).status).toBe("COMPLETED");
    expect(await db.select().from(repayments).where(eq(repayments.loanId, borrower.loanId))).toHaveLength(1);
    expect(await units(db, l1.agentId)).toBe(12000n);
    // A RECOVERED loan can't be repaid again.
    const again = await call(db, "repay_loan", borrower.key, { loan_id: borrower.loanId });
    expect(again.envelope.status).toBe("INVALID_TRANSITION");
    await expectBalanced(db, worldId);
  });

  it("partial recovery via repay_loan stays CHARGED_OFF and re-issues the guarantee (P4-F); the owner then pays the OLD guarantee order: the overlap is refunded; the new one is refunded in full", async () => {
    const worldId = (await createWorld(db, { name: "Partial", ownerPrincipalId: null, railMode: "sim" })).worldId;
    const l1 = await fundPool(db, worldId, 20000, "l1@example.com");
    const l2 = await fundPool(db, worldId, 10000, "l2@example.com");
    const borrower = await borrow(db, worldId);
    const due = (await loanRow(db, borrower.loanId)).dueSimAt;
    await moveClockTo(db, worldId, at(due, 10));
    await processDue(db, worldId, await getSimNow(db, worldId));
    const loan = await loanRow(db, borrower.loanId);
    const total = loan.chargeOffTotalCents;
    const loss1 = 20000n - (await units(db, l1.agentId));
    const loss2 = 10000n - (await units(db, l2.agentId));
    expect(loss1 + loss2).toBe(25000n);
    const firstIssue = (await link(db, borrower.loanId, "guarantee"))!;
    expect(firstIssue).toMatchObject({ amountCents: total, quotedCents: total, status: "open" });

    // A restricted agent repays 9000 after charge-off: a partial recovery, all to the holders (pro rata to loss).
    const partial = await repay(db, borrower.key, borrower.loanId, 9000);
    expect(partial).toMatchObject({ loan_status: "CHARGED_OFF", applied_recovery_cents: 9000, remainder_cents: 0 });
    let row = await loanRow(db, borrower.loanId);
    expect(row.status).toBe("charged_off");
    expect(row.recoveredCents).toBe(9000n);
    expect((20000n - (await units(db, l1.agentId))) + (10000n - (await units(db, l2.agentId)))).toBe(25000n - 9000n);
    expect(await getAccountBalance(db, worldId, "recoveries_income", null)).toBe(0n);
    expect(await agentStatus(db, borrower.agentId)).toBe("restricted");
    await expectUnitsMatchLedger(db, worldId);
    await expectBalanced(db, worldId);

    // P4-F: the guarantee link (same row) is re-issued at what is still recoverable, as a quote.
    const reissued = (await link(db, borrower.loanId, "guarantee"))!;
    expect(reissued.id).toBe(firstIssue.id);
    expect(reissued).toMatchObject({ amountCents: total - 9000n, quotedCents: total - 9000n, status: "open" });
    expect(reissued.paypalOrderId).not.toBe(firstIssue.paypalOrderId);
    const [g2] = await db.select().from(paypalOperations).where(eq(paypalOperations.id, reissued.createOpId!));
    expect(g2!.sourceId).toBe(`${borrower.loanId}:g2`);

    // repay_loan caps at what is still owed.
    const tooMuch = await call(db, "repay_loan", borrower.key, { loan_id: borrower.loanId, amount_cents: Number(total - 9000n) + 1 });
    expect(tooMuch.envelope.status).toBe("AMOUNT_EXCEEDS_OUTSTANDING");

    // The owner pays the OLD (first-issue) guarantee order anyway: total − 9000 recovered, 9000 back to the borrower.
    await simApprove(db, firstIssue.paypalOrderId!);
    const settled = await settleCheckoutByOrderId(db, worldId, firstIssue.paypalOrderId!);
    expect(settled.status).toBe("COMPLETED");
    expect(settled.data).toMatchObject({
      loan_status: "RECOVERED",
      applied_recovery_cents: Number(total - 9000n),
      remainder_cents: 9000,
    });
    row = await loanRow(db, borrower.loanId);
    expect(row.status).toBe("recovered");
    expect(row.recoveredCents).toBe(total);
    // Holders exactly whole, never more.
    expect(await units(db, l1.agentId)).toBe(20000n);
    expect(await units(db, l2.agentId)).toBe(10000n);
    const losses = await db.select().from(loanHolderLosses).where(eq(loanHolderLosses.loanId, borrower.loanId));
    for (const loss of losses) {
      expect(loss.recoveredCents).toBe(loss.lossCents);
    }
    expect(await getAccountBalance(db, worldId, "recoveries_income", null)).toBe(-(total - 25000n));
    const rows = await db.select().from(repayments).where(eq(repayments.loanId, borrower.loanId));
    expect(rows.reduce((sum, r) => sum + r.appliedRecoveryCents, 0n)).toBe(total);
    const refund = rows.find((r) => r.remainderCents === 9000n)!;
    expect(refund.remainderStatus).toBe("paid");
    expect(await getAccountBalance(db, worldId, "payable_to_borrower", borrower.agentId)).toBe(0n);
    expect(await agentStatus(db, borrower.agentId)).toBe("active");
    // Final fix (minor b): the recovery closed the re-issued link (no more polling); paying it
    // anyway is still booked (stray capture) and refunded in full.
    expect((await link(db, borrower.loanId, "guarantee"))!.status).toBe("closed");
    const second = await payLink(db, worldId, borrower.loanId, "guarantee");
    expect(second.data).toMatchObject({ loan_status: "RECOVERED", applied_recovery_cents: 0, remainder_cents: Number(total - 9000n) });
    expect((await link(db, borrower.loanId, "guarantee"))!.status).toBe("closed");
    expect(await units(db, l1.agentId)).toBe(20000n);
    expect((await loanRow(db, borrower.loanId)).recoveredCents).toBe(total);
    await expectUnitsMatchLedger(db, worldId);
    await expectBalanced(db, worldId);
  });

  it("recovery via the old invoice link: the written-off total is recovered, the rest goes back to the borrower; a later guarantee payment is refunded in full", async () => {
    const worldId = (await createWorld(db, { name: "Invoice", ownerPrincipalId: null, railMode: "sim" })).worldId;
    const lender = await fundPool(db, worldId, 30000, "l1@example.com");
    const borrower = await borrow(db, worldId, { invoice: true });
    const due = (await loanRow(db, borrower.loanId)).dueSimAt;
    await moveClockTo(db, worldId, at(due, 11));
    await processDue(db, worldId, await getSimNow(db, worldId));
    const loan = await loanRow(db, borrower.loanId);
    expect(loan.status).toBe("charged_off");
    const total = loan.chargeOffTotalCents;
    expect(await units(db, lender.agentId)).toBe(30000n - 25000n);

    // The client finally pays the 40000 invoice link.
    const settled = await payLink(db, worldId, borrower.loanId, "invoice");
    expect(settled.data).toMatchObject({
      loan_status: "RECOVERED",
      applied_recovery_cents: Number(total),
      remainder_cents: Number(40000n - total),
    });
    expect(await units(db, lender.agentId)).toBe(30000n);
    const recoveries = await getAccountBalance(db, worldId, "recoveries_income", null);
    expect(recoveries).toBe(-(total - 25000n));
    await expectBalanced(db, worldId);

    // The owner pays the guarantee too (Review Focus 4): all of it is returned, nothing credited.
    const second = await payLink(db, worldId, borrower.loanId, "guarantee");
    expect(second.data).toMatchObject({ loan_status: "RECOVERED", applied_recovery_cents: 0, remainder_cents: Number(total) });
    expect(await units(db, lender.agentId)).toBe(30000n);
    expect(await getAccountBalance(db, worldId, "recoveries_income", null)).toBe(recoveries);
    expect((await loanRow(db, borrower.loanId)).recoveredCents).toBe(total);
    const rows = await db.select().from(repayments).where(eq(repayments.loanId, borrower.loanId));
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.remainderStatus === "paid")).toBe(true);
    expect(await getAccountBalance(db, worldId, "payable_to_borrower", borrower.agentId)).toBe(0n);
    await expectUnitsMatchLedger(db, worldId);
    await expectBalanced(db, worldId);
  });

  it("cure edge cases: paid in full before +10 → REPAID (no charge-off); a checkout started while substandard but captured after charge-off is a recovery", async () => {
    const worldId = (await createWorld(db, { name: "Edges", ownerPrincipalId: null, railMode: "sim" })).worldId;
    await fundPool(db, worldId, 60000, "l1@example.com");

    // 1) Cured at +9: the charge-off never happens.
    const cured = await borrow(db, worldId);
    const due = (await loanRow(db, cured.loanId)).dueSimAt;
    await moveClockTo(db, worldId, at(due, 9));
    await processDue(db, worldId, await getSimNow(db, worldId));
    expect((await loanRow(db, cured.loanId)).status).toBe("substandard");
    expect((await repay(db, cured.key, cured.loanId)).loan_status).toBe("REPAID");
    await processDue(db, worldId, at(due, 12));
    const curedRow = await loanRow(db, cured.loanId);
    expect(curedRow.status).toBe("repaid");
    expect(curedRow.chargedOffAt).toBeNull();
    expect(await link(db, cured.loanId, "guarantee")).toBeUndefined();
    await expectBalanced(db, worldId);

    // 2) A second borrower's full repayment starts at +9 (substandard) …
    const late = await borrow(db, worldId);
    const due2 = (await loanRow(db, late.loanId)).dueSimAt;
    await moveClockTo(db, worldId, at(due2, 9));
    const simNow = await getSimNow(db, worldId);
    await processDue(db, worldId, simNow);
    const started = await call(db, "repay_loan", late.key, { loan_id: late.loanId });
    const checkoutId = (started.envelope.data as Data).checkout_id as string;
    const amount = BigInt((started.envelope.data as Data).amount_cents as number);
    await simApprove(db, checkoutId);
    // … the loan is charged off before it is captured (the ladder runs ahead of the world clock) …
    await processDue(db, worldId, at(due2, 10));
    const chargedOff = await loanRow(db, late.loanId);
    expect(chargedOff.status).toBe("charged_off");
    // … so the capture is a recovery of `amount`. Ruling P4-E: it was a full-payoff quote paid as quoted,
    // so it fully recovers — the penalty accrued between the quote (+9) and the charge-off is waived.
    const confirmed = (await call(db, "confirm_checkout", late.key, { checkout_id: checkoutId })).envelope;
    expect(confirmed.status).toBe("COMPLETED");
    expect(confirmed.data).toMatchObject({ loan_status: "RECOVERED", applied_recovery_cents: Number(amount), remainder_cents: 0 });
    const row = await loanRow(db, late.loanId);
    expect(row.status).toBe("recovered");
    expect(row.recoveredCents).toBe(amount);
    const residue = penaltyFor(25000n, 10) - penaltyFor(25000n, daysLateAt(due2, simNow));
    expect(residue).toBeGreaterThan(0n);
    expect(row.chargeOffTotalCents - amount).toBe(residue);
    expect(row.waivedCents - chargedOff.waivedCents).toBe(residue);
    expect(await agentStatus(db, late.agentId)).toBe("active");
    // The guarantee isn't re-issued for a recovered loan.
    expect((await link(db, late.loanId, "guarantee"))!.amountCents).toBe(row.chargeOffTotalCents);
    await expectUnitsMatchLedger(db, worldId);
    await expectBalanced(db, worldId);
  });

  it("private world: borrow → +7 +7 +2 (late) → +7 (substandard) → +7 (charged off) → the owner approves the guarantee → RECOVERED", async () => {
    const [owner] = await db
      .insert(principals)
      .values({ email: "owner@example.com", name: "Owner", entityType: "individual", verifiedAt: new Date() })
      .returning();
    const ownerId = owner!.id;
    const { worldId } = await createWorld(db, { name: "Sandbox", ownerPrincipalId: ownerId, railMode: "sim", kind: "private" });
    const lender = await fundPool(db, worldId, 30000, "l1@example.com");
    const borrower = await borrow(db, worldId, { kya: { principalId: ownerId } });

    for (const days of [7, 7, 2]) {
      await advancePrivateWorld(db, ownerId, worldId, days);
    }
    expect((await loanRow(db, borrower.loanId)).status).toBe("late");
    await advancePrivateWorld(db, ownerId, worldId, 7);
    expect((await loanRow(db, borrower.loanId)).status).toBe("substandard");
    await advancePrivateWorld(db, ownerId, worldId, 7);
    const loan = await loanRow(db, borrower.loanId);
    expect(loan.status).toBe("charged_off");
    expect(loan.chargedOffAt?.getTime()).toBe(at(loan.dueSimAt, 10).getTime());
    await expectBalanced(db, worldId);

    // The guarantee's sim order points at the owner's approve page in this world.
    const guarantee = await link(db, borrower.loanId, "guarantee");
    expect(guarantee!.approveUrl).toContain(`/dashboard/worlds/${worldId}/checkouts/`);
    const approved = await approveOwnedSimCheckout(db, ownerId, worldId, guarantee!.paypalOrderId!);
    expect(approved.outcome).toBe("approved");
    if (approved.outcome === "approved") {
      expect(approved.checkout.purpose).toBe("guarantee");
      expect(approved.checkout.returnPath).toBe(`/checkout/guarantee/return?token=${guarantee!.paypalOrderId}`);
    }
    expect((await settleCheckoutByOrderId(db, worldId, guarantee!.paypalOrderId!)).status).toBe("COMPLETED");

    const after = await loanRow(db, borrower.loanId);
    expect(after.status).toBe("recovered");
    expect(await units(db, lender.agentId)).toBe(30000n);
    expect(await agentStatus(db, borrower.agentId)).toBe("active");
    await expectUnitsMatchLedger(db, worldId);
    await expectBalanced(db, worldId);
  });
});

/** Holder L1 (25000, receiver as given) with a 12000 redemption pending, L2 (10000); a 25000 loan charged off at +10. */
async function chargeOffWithPendingRedemption(db: Db, l1Receiver: string) {
  const worldId = (await createWorld(db, { name: "Deferred", ownerPrincipalId: null, railMode: "sim" })).worldId;
  const l1 = await fundPool(db, worldId, 25000, l1Receiver);
  const l2 = await fundPool(db, worldId, 10000, "l2@example.com");
  const redemption = await db.transaction(async (tx) => {
    const outcome = await beginNoteRedemption(tx, worldId, l1.agentId, 12000n);
    if (outcome.outcome !== "submitted") {
      throw new Error(`expected submitted, got ${outcome.outcome}`);
    }
    return outcome;
  });
  const borrower = await borrow(db, worldId);
  const due = (await loanRow(db, borrower.loanId)).dueSimAt;
  await moveClockTo(db, worldId, at(due, 10));
  await processDue(db, worldId, await getSimNow(db, worldId));
  const loan = await loanRow(db, borrower.loanId);
  expect(loan.status).toBe("charged_off");
  return { worldId, l1, l2, borrower, loan, redemption };
}

async function lossRow(db: Db, loanId: string, agentId: string) {
  const [row] = await db
    .select()
    .from(loanHolderLosses)
    .where(and(eq(loanHolderLosses.loanId, loanId), eq(loanHolderLosses.agentId, agentId)));
  return row!;
}

describe("charge-off fix round 1 (P4-D deferred holder loss, P4-F re-issue, M5, M6)", () => {
  let db: Db;

  beforeEach(async () => {
    process.env.API_KEY_PEPPER = "test-pepper";
    db = await createTestDb();
  });

  afterEach(() => {
    delete process.env.API_KEY_PEPPER;
  });

  it("P4-D: shares on full units (17857 / 7143); 12000 reserved by a pending redemption defers 4857; the redemption SUCCEEDS → the bank absorbs it", async () => {
    const { worldId, l1, l2, loan, redemption } = await chargeOffWithPendingRedemption(db, "l1@example.com");
    const row = await lossRow(db, loan.id, l1.agentId);
    expect(row).toMatchObject({ lossCents: 13000n, deferredCents: 4857n });
    expect((await lossRow(db, loan.id, l2.agentId)).lossCents).toBe(7143n);
    expect(loan.holdersLossCents).toBe(20143n);
    expect(await units(db, l1.agentId)).toBe(12000n); // exactly the reserved units
    expect(await getAccountBalance(db, worldId, "provision_expense", null)).toBe(4857n);
    await expectUnitsMatchLedger(db, worldId);
    await expectBalanced(db, worldId);

    await applyRedemptionPayoutOutcome(db, redemption.payoutOperationId);
    expect(await units(db, l1.agentId)).toBe(0n);
    expect(await lossRow(db, loan.id, l1.agentId)).toMatchObject({ lossCents: 13000n, deferredCents: 0n });
    // Absorbed by the bank: nothing more journaled.
    expect(await getAccountBalance(db, worldId, "provision_expense", null)).toBe(4857n);
    await expectUnitsMatchLedger(db, worldId);
    await expectBalanced(db, worldId);
  });

  it("P4-D: the redemption FAILS → the deferred 4857 is applied (units 7143); the guarantee then makes the holder whole", async () => {
    const { worldId, l1, borrower, loan, redemption } = await chargeOffWithPendingRedemption(db, "fail@example.com");
    expect(await lossRow(db, loan.id, l1.agentId)).toMatchObject({ lossCents: 13000n, deferredCents: 4857n });

    await applyRedemptionPayoutOutcome(db, redemption.payoutOperationId);
    expect(await lossRow(db, loan.id, l1.agentId)).toMatchObject({ lossCents: 17857n, deferredCents: 0n });
    expect(await units(db, l1.agentId)).toBe(25000n - 17857n);
    expect(await getAccountBalance(db, worldId, "provision_expense", null)).toBe(0n);
    await expectUnitsMatchLedger(db, worldId);
    await expectBalanced(db, worldId);
    // Settling the same outcome again changes nothing.
    await applyRedemptionPayoutOutcome(db, redemption.payoutOperationId);
    expect(await units(db, l1.agentId)).toBe(25000n - 17857n);

    await payLink(db, worldId, borrower.loanId, "guarantee");
    expect(await units(db, l1.agentId)).toBe(25000n);
    await expectUnitsMatchLedger(db, worldId);
    await expectBalanced(db, worldId);
  });

  it("P4-D: a redemption that fails AFTER the loan was recovered applies the deferred loss and passes back what the bank kept", async () => {
    const { worldId, l1, borrower, loan, redemption } = await chargeOffWithPendingRedemption(db, "fail@example.com");
    await payLink(db, worldId, borrower.loanId, "guarantee");
    expect((await loanRow(db, loan.id)).status).toBe("recovered");
    expect(await units(db, l1.agentId)).toBe(25000n); // 12000 + 13000 credited back
    const kept = -(await getAccountBalance(db, worldId, "recoveries_income", null));
    expect(kept).toBe(loan.chargeOffTotalCents - 20143n);

    await applyRedemptionPayoutOutcome(db, redemption.payoutOperationId);
    expect(await lossRow(db, loan.id, l1.agentId)).toMatchObject({ lossCents: 17857n, recoveredCents: 17857n, deferredCents: 0n });
    expect(await units(db, l1.agentId)).toBe(25000n);
    expect(-(await getAccountBalance(db, worldId, "recoveries_income", null))).toBe(kept - 4857n);
    await expectUnitsMatchLedger(db, worldId);
    await expectBalanced(db, worldId);
  });

  it("P4-F: a guarantee whose order.create failed is re-issued in place by the reconcile cron, up to MAX_GUARANTEE_LINK_ISSUES issues", async () => {
    const worldId = (await createWorld(db, { name: "Reissue", ownerPrincipalId: null, railMode: "sim" })).worldId;
    await fundPool(db, worldId, 30000, "l1@example.com");
    const borrower = await borrow(db, worldId);
    const due = (await loanRow(db, borrower.loanId)).dueSimAt;
    await moveClockTo(db, worldId, at(due, 10));
    await processDue(db, worldId, await getSimNow(db, worldId));
    const total = (await loanRow(db, borrower.loanId)).chargeOffTotalCents;
    const first = (await link(db, borrower.loanId, "guarantee"))!;

    // Simulate a terminally failed create.
    await db.update(repaymentLinks).set({ status: "failed" }).where(eq(repaymentLinks.id, first.id));
    const report = await runReconcile(db);
    expect(report.errors ?? []).toEqual([]);
    let row = (await link(db, borrower.loanId, "guarantee"))!;
    expect(row).toMatchObject({ id: first.id, status: "open", amountCents: total, quotedCents: total });
    expect(row.createOpId).not.toBe(first.createOpId);

    for (let issue = 3; issue <= MAX_GUARANTEE_LINK_ISSUES; issue += 1) {
      await db.update(repaymentLinks).set({ status: "failed" }).where(eq(repaymentLinks.id, first.id));
      expect((await reissueGuaranteeLink(db, worldId, borrower.loanId)).outcome).toBe("reissued");
    }
    await db.update(repaymentLinks).set({ status: "failed" }).where(eq(repaymentLinks.id, first.id));
    expect(await reissueGuaranteeLink(db, worldId, borrower.loanId)).toEqual({
      outcome: "exhausted",
      issues: MAX_GUARANTEE_LINK_ISSUES,
      firstTime: false,
    });
    row = (await link(db, borrower.loanId, "guarantee"))!;
    expect(row.status).toBe("failed");
    expect(row.reissueExhaustedAt).toBeNull();

    // Final fix I3: the reconcile cron reports the exhausted link once, marks it, then skips it.
    const exhausted = await runReconcile(db);
    expect(exhausted.anomalies.filter((a) => a.sourceId === first.id).map((a) => a.detail)).toEqual([
      { loan_id: borrower.loanId, reason: `guarantee_reissue_exhausted:${MAX_GUARANTEE_LINK_ISSUES}` },
    ]);
    expect((await link(db, borrower.loanId, "guarantee"))!.reissueExhaustedAt).not.toBeNull();
    const again = await runReconcile(db);
    expect(again.anomalies.filter((a) => a.sourceId === first.id)).toEqual([]);
    await expectBalanced(db, worldId);
  });

  it("M5: the guarantee and a direct repayment settling at once after charge-off credit at most what is owed; the excess is refunded once", async () => {
    const worldId = (await createWorld(db, { name: "Race", ownerPrincipalId: null, railMode: "sim" })).worldId;
    const l1 = await fundPool(db, worldId, 20000, "l1@example.com");
    const l2 = await fundPool(db, worldId, 15000, "l2@example.com");
    const borrower = await borrow(db, worldId);
    const due = (await loanRow(db, borrower.loanId)).dueSimAt;
    await moveClockTo(db, worldId, at(due, 10));
    await processDue(db, worldId, await getSimNow(db, worldId));
    const total = (await loanRow(db, borrower.loanId)).chargeOffTotalCents;

    const started = await call(db, "repay_loan", borrower.key, { loan_id: borrower.loanId });
    const checkoutId = (started.envelope.data as Data).checkout_id as string;
    expect((started.envelope.data as Data).amount_cents).toBe(Number(total));
    await simApprove(db, checkoutId);
    const guarantee = (await link(db, borrower.loanId, "guarantee"))!;
    await simApprove(db, guarantee.paypalOrderId!);

    const [byOwner, byAgent] = await Promise.all([
      settleCheckoutByOrderId(db, worldId, guarantee.paypalOrderId!),
      call(db, "confirm_checkout", borrower.key, { checkout_id: checkoutId }),
    ]);
    expect(byOwner.status).toBe("COMPLETED");
    expect(byAgent.envelope.status).toBe("COMPLETED");

    const rows = await db.select().from(repayments).where(eq(repayments.loanId, borrower.loanId));
    expect(rows).toHaveLength(2);
    expect(rows.reduce((sum, r) => sum + r.appliedRecoveryCents, 0n)).toBe(total);
    expect(rows.reduce((sum, r) => sum + r.remainderCents, 0n)).toBe(total);
    expect(rows.filter((r) => r.remainderCents === total)).toHaveLength(1);
    const loan = await loanRow(db, borrower.loanId);
    expect(loan).toMatchObject({ status: "recovered", recoveredCents: total });
    expect(await units(db, l1.agentId)).toBe(20000n);
    expect(await units(db, l2.agentId)).toBe(15000n);
    expect(await getAccountBalance(db, worldId, "payable_to_borrower", borrower.agentId)).toBe(0n);
    await expectUnitsMatchLedger(db, worldId);
    await expectBalanced(db, worldId);
  });

  it("M6: get_status shows the charged-off loan with what is recoverable and the guarantee link", async () => {
    const worldId = (await createWorld(db, { name: "Status", ownerPrincipalId: null, railMode: "sim" })).worldId;
    await fundPool(db, worldId, 30000, "l1@example.com");
    const borrower = await borrow(db, worldId);
    const due = (await loanRow(db, borrower.loanId)).dueSimAt;
    await processDue(db, worldId, at(due, 10));
    const loan = await loanRow(db, borrower.loanId);
    const guarantee = (await link(db, borrower.loanId, "guarantee"))!;
    const status = (await call(db, "get_status", borrower.key, {})).envelope;
    expect((status.data as Data).open_loan).toMatchObject({
      loan_id: borrower.loanId,
      status: "CHARGED_OFF",
      total_due_cents: Number(loan.chargeOffTotalCents),
      days_late: 0,
      guarantee_link: { url: guarantee.approveUrl, amount_cents: Number(loan.chargeOffTotalCents), status: "OPEN" },
    });
    expect(status.next_actions[0]).toMatchObject({ tool: "repay_loan", args: { loan_id: borrower.loanId } });
  });
});

describe("charge-off fix round 2: every completed capture is booked", () => {
  let db: Db;

  beforeEach(async () => {
    process.env.API_KEY_PEPPER = "test-pepper";
    db = await createTestDb();
  });

  afterEach(() => {
    delete process.env.API_KEY_PEPPER;
  });

  async function journalFor(db: Db, worldId: string, captureId: string) {
    return db
      .select()
      .from(journalEntries)
      .where(and(eq(journalEntries.worldId, worldId), eq(journalEntries.idempotencyKey, `repayment_capture:${captureId}`)));
  }

  it("re-issued guarantee paid first, then the superseded order is captured: booked and refunded in full, once", async () => {
    const worldId = (await createWorld(db, { name: "Stray", ownerPrincipalId: null, railMode: "sim" })).worldId;
    const l1 = await fundPool(db, worldId, 30000, "l1@example.com");
    const borrower = await borrow(db, worldId);
    const due = (await loanRow(db, borrower.loanId)).dueSimAt;
    await moveClockTo(db, worldId, at(due, 10));
    await processDue(db, worldId, await getSimNow(db, worldId));
    const total = (await loanRow(db, borrower.loanId)).chargeOffTotalCents;
    const firstIssue = (await link(db, borrower.loanId, "guarantee"))!;
    await repay(db, borrower.key, borrower.loanId, 9000);

    // The re-issued link (total − 9000) is paid first → RECOVERED, the link row is `paid`.
    const fresh = await payLink(db, worldId, borrower.loanId, "guarantee");
    expect(fresh.data).toMatchObject({ loan_status: "RECOVERED", applied_recovery_cents: Number(total - 9000n), remainder_cents: 0 });
    expect((await link(db, borrower.loanId, "guarantee"))!.status).toBe("paid");
    await expectBalanced(db, worldId);

    // Then the owner's older order (total) is captured: nothing left to recover, all of it refunded.
    await simApprove(db, firstIssue.paypalOrderId!);
    const stray = await settleCheckoutByOrderId(db, worldId, firstIssue.paypalOrderId!);
    expect(stray.status).toBe("COMPLETED");
    expect(stray.data).toMatchObject({ loan_status: "RECOVERED", applied_recovery_cents: 0, remainder_cents: Number(total) });
    const captureId = (stray.data as Data).repayment_id as string;
    const [row] = await db.select().from(repayments).where(eq(repayments.id, captureId));
    expect(await journalFor(db, worldId, row!.captureId!)).toHaveLength(1);
    expect(row!.remainderStatus).toBe("paid");
    // Settling it again changes nothing.
    await settleCheckoutByOrderId(db, worldId, firstIssue.paypalOrderId!);
    const rows = await db.select().from(repayments).where(eq(repayments.loanId, borrower.loanId));
    expect(rows).toHaveLength(3);
    expect(rows.reduce((sum, r) => sum + r.appliedRecoveryCents, 0n)).toBe(total);
    expect(rows.reduce((sum, r) => sum + r.remainderCents, 0n)).toBe(total);
    expect(await units(db, l1.agentId)).toBe(30000n);
    expect(await getAccountBalance(db, worldId, "payable_to_borrower", borrower.agentId)).toBe(0n);
    await expectUnitsMatchLedger(db, worldId);
    await expectBalanced(db, worldId);
  });

  it("a direct repayment captured after its link was marked failed is still booked (waterfall), link left failed", async () => {
    const worldId = (await createWorld(db, { name: "Failed", ownerPrincipalId: null, railMode: "sim" })).worldId;
    await fundPool(db, worldId, 30000, "l1@example.com");
    const borrower = await borrow(db, worldId);
    const started = await call(db, "repay_loan", borrower.key, { loan_id: borrower.loanId, amount_cents: 5000 });
    const checkoutId = (started.envelope.data as Data).checkout_id as string;
    await simApprove(db, checkoutId);
    await db.update(repaymentLinks).set({ status: "failed" }).where(eq(repaymentLinks.paypalOrderId, checkoutId));
    const confirmed = (await call(db, "confirm_checkout", borrower.key, { checkout_id: checkoutId })).envelope;
    expect(confirmed.status).toBe("COMPLETED");
    expect(confirmed.data).toMatchObject({ loan_status: "ACTIVE", applied_fee_cents: 333, applied_principal_cents: 5000 - 333 });
    const [row] = await db.select().from(repayments).where(eq(repayments.loanId, borrower.loanId));
    expect(await journalFor(db, worldId, row!.captureId!)).toHaveLength(1);
    expect((await db.select().from(repaymentLinks).where(eq(repaymentLinks.paypalOrderId, checkoutId)))[0]!.status).toBe("failed");
    expect((await loanRow(db, borrower.loanId)).outstandingCents).toBe(25333n - 5000n);
    await expectBalanced(db, worldId);
  });

  it("an invoice link already marked paid, captured on a repaid loan: booked, all of it refunded", async () => {
    const worldId = (await createWorld(db, { name: "Paid", ownerPrincipalId: null, railMode: "sim" })).worldId;
    await fundPool(db, worldId, 30000, "l1@example.com");
    const borrower = await borrow(db, worldId, { invoice: true });
    expect((await repay(db, borrower.key, borrower.loanId)).loan_status).toBe("REPAID");
    const invoice = (await link(db, borrower.loanId, "invoice"))!;
    await db.update(repaymentLinks).set({ status: "paid" }).where(eq(repaymentLinks.id, invoice.id));
    const settled = await payLink(db, worldId, borrower.loanId, "invoice");
    expect(settled.data).toMatchObject({ loan_status: "REPAID", remainder_cents: 40000, remainder_status: "PAID" });
    await expectBalanced(db, worldId);
    expect(await getAccountBalance(db, worldId, "payable_to_borrower", borrower.agentId)).toBe(0n);
  });
});

function daysLateAt(due: Date, simNow: Date): number {
  return Math.min(Math.floor((simNow.getTime() - due.getTime()) / DAY_MS), 10);
}
