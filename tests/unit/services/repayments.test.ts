import { and, eq, like } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { generateApiKey } from "@/server/auth/apiKeys";
import "@/server/contracts/tools";
import { findTool } from "@/server/contracts/registry";
import { runTool } from "@/server/contracts/runTool";
import type { Db } from "@/server/db/client";
import {
  agents,
  apiKeys,
  events,
  journalEntries,
  loans,
  notePositions,
  paypalOperations,
  repaymentLinks,
  repayments,
} from "@/server/db/schema";
import { createTestDb } from "@/server/db/testing";
import { availableLiquidity } from "@/server/domain/liquidity";
import { getAccountBalance, trialBalance } from "@/server/ledger/trialBalance";
import { simApprove } from "@/server/rail/simHandler";
import { settleCheckoutByOrderId } from "@/server/services/checkouts";
import { pollPayoutStatus } from "@/server/services/payoutPolling";
import { invoiceLinkDescription } from "@/server/services/repayments";
import { createWorld } from "@/server/services/worlds";

type Data = Record<string, unknown>;

async function createSimWorld(db: Db) {
  const { worldId } = await createWorld(db, { name: "Repay World", ownerPrincipalId: null, railMode: "sim" });
  return worldId;
}

async function createTestAgent(db: Db, worldId: string, payoutReceiver: string, name = "Test Agent") {
  const [agent] = await db
    .insert(agents)
    .values({
      worldId,
      name,
      operator: "test-operator",
      model: "test-model",
      codeManifestHash: "deadbeef",
      status: "active",
      payoutReceiver,
      payoutReceiverType: "email",
    })
    .returning();
  const generated = generateApiKey();
  await db.insert(apiKeys).values({ worldId, agentId: agent!.id, prefix: generated.prefix, keyHash: generated.hash });
  return { agentId: agent!.id, key: generated.key };
}

async function call(db: Db, toolName: string, key: string, input: Record<string, unknown>) {
  return runTool(findTool(toolName), toolName, input, { getDb: async () => db, authorization: `Bearer ${key}` });
}

async function fundPool(db: Db, worldId: string, amountCents: number, receiver = "lender@example.com") {
  const lender = await createTestAgent(db, worldId, receiver, "Lender");
  const buy = await call(db, "buy_notes", lender.key, { amount_cents: amountCents });
  const checkoutId = (buy.envelope.data as Data).checkout_id as string;
  await simApprove(db, checkoutId);
  const confirmed = await call(db, "confirm_checkout", lender.key, { checkout_id: checkoutId });
  expect(confirmed.envelope.status).toBe("COMPLETED");
  return lender;
}

const INVOICE = { client_email: "client@example.com", amount_cents: 40000, due_in_days: 14, description: "Website build" };

/** Borrower takes 25000 for 14 days (fee 750), with or without the 40000 invoice; returns the ACTIVE loan id. */
async function borrow(
  db: Db,
  worldId: string,
  { invoice = true, receiver = "borrower@example.com" }: { invoice?: boolean; receiver?: string } = {},
) {
  const borrower = await createTestAgent(db, worldId, receiver, "Acme Agent");
  const applied = await call(db, "apply_for_loan", borrower.key, {
    amount_cents: 25000,
    term_days: 14,
    purpose: "Working capital for an invoice",
    ...(invoice ? { invoice: INVOICE } : {}),
  });
  expect(applied.envelope.status).toBe("OFFERED");
  const offer = applied.envelope.data as Data;
  const accepted = await call(db, "accept_offer", borrower.key, {
    offer_id: offer.offer_id,
    disclosure_hash: offer.disclosure_hash,
  });
  expect(accepted.envelope.status).toBe("ACTIVE");
  return { ...borrower, loanId: (accepted.envelope.data as Data).loan_id as string, accepted };
}

async function bal(db: Db, worldId: string, code: Parameters<typeof getAccountBalance>[2], owner: string | null = null) {
  return getAccountBalance(db, worldId, code, owner);
}

async function invoiceLink(db: Db, loanId: string) {
  const [link] = await db
    .select()
    .from(repaymentLinks)
    .where(and(eq(repaymentLinks.loanId, loanId), eq(repaymentLinks.kind, "invoice")));
  return link;
}

async function repaymentJournalCount(db: Db, worldId: string) {
  const rows = await db
    .select()
    .from(journalEntries)
    .where(and(eq(journalEntries.worldId, worldId), like(journalEntries.idempotencyKey, "repayment_capture:%")));
  return rows.length;
}

async function remainderOps(db: Db, worldId: string) {
  return db
    .select()
    .from(paypalOperations)
    .where(and(eq(paypalOperations.worldId, worldId), eq(paypalOperations.purpose, "remainder_payout")));
}

/** Every holder's redeemable units equal what the bank owes them on the ledger. */
async function expectPositionsMatchLedger(db: Db, worldId: string) {
  const positions = await db.select().from(notePositions).where(eq(notePositions.worldId, worldId));
  for (const position of positions) {
    expect(-(await bal(db, worldId, "notes_payable", position.agentId))).toBe(position.units);
  }
}

describe("repayment: invoice link, repay_loan, waterfall, remainder, note distribution, get_statement", () => {
  let db: Db;

  beforeEach(async () => {
    process.env.API_KEY_PEPPER = "test-pepper";
    db = await createTestDb();
  });

  afterEach(() => {
    delete process.env.API_KEY_PEPPER;
  });

  it("e2e (sim): client pays the 40000 invoice link with no agent online → REPAID, remainder 14250 paid, holder +600, bank 150", async () => {
    const worldId = await createSimWorld(db);
    const lender = await fundPool(db, worldId, 30000);
    const borrower = await borrow(db, worldId);

    // The link is created on activation and its URL stored.
    const link = await invoiceLink(db, borrower.loanId);
    expect(link).toBeTruthy();
    expect(link!.amountCents).toBe(40000n);
    expect(link!.status).toBe("open");
    expect(link!.approveUrl).toMatch(/^https:\/\/sim\.paypal\.local\//);
    expect(link!.paypalOrderId).toBeTruthy();

    const [createOp] = await db
      .select()
      .from(paypalOperations)
      .where(and(eq(paypalOperations.worldId, worldId), eq(paypalOperations.purpose, "repayment_link")));
    expect(createOp?.sourceId).toBe(borrower.loanId);
    expect(createOp?.kind).toBe("order.create");
    const unit = ((createOp!.request as Data).body as { purchase_units: Data[] }).purchase_units[0]!;
    expect(unit.description).toBe("Invoice Website build — pay to Mandate on behalf of Acme Agent");
    expect(unit).not.toHaveProperty("payee");
    expect(unit.amount).toEqual({ currency_code: "USD", value: "400.00" });

    // accept_offer tells the agent to forward the link to its client.
    expect(borrower.accepted.envelope.next_actions[0]).toMatchObject({
      tool: "human_approval",
      args: { url: link!.approveUrl, who: "client" },
    });

    // get_loan shows it.
    const got = await call(db, "get_loan", borrower.key, { loan_id: borrower.loanId });
    expect((got.envelope.data as Data).repayment_link).toEqual({
      url: link!.approveUrl,
      amount_cents: 40000,
      status: "OPEN",
    });

    // The client approves; nobody calls confirm_checkout — the cron/webhook path settles it.
    await simApprove(db, link!.paypalOrderId!);
    const settled = await settleCheckoutByOrderId(db, worldId, link!.paypalOrderId!);
    expect(settled.status).toBe("COMPLETED");

    const [loan] = await db.select().from(loans).where(eq(loans.id, borrower.loanId));
    expect(loan?.status).toBe("repaid");
    expect(loan?.outstandingCents).toBe(0n);

    const [repayment] = await db.select().from(repayments).where(eq(repayments.loanId, borrower.loanId));
    expect(repayment).toMatchObject({
      grossCents: 40000n,
      appliedPrincipalCents: 25000n,
      appliedFeeCents: 750n,
      remainderCents: 14250n,
      remainderStatus: "paid",
    });
    expect(repayment?.captureId).toBeTruthy();

    // Remainder payout of 14250 succeeded.
    const ops = await remainderOps(db, worldId);
    expect(ops).toHaveLength(1);
    expect(ops[0]?.status).toBe("succeeded");
    expect(ops[0]?.sourceId).toBe(repayment!.id);
    const payoutItem = ((ops[0]!.executableRequest as Data).body as { items: Data[] }).items[0]!;
    expect(payoutItem.amount).toEqual({ currency: "USD", value: "142.50" });
    expect(payoutItem.receiver).toBe("borrower@example.com");

    // Ledger.
    expect(await bal(db, worldId, "loans_receivable")).toBe(0n);
    expect(await bal(db, worldId, "fee_income")).toBe(-750n);
    expect(await bal(db, worldId, "note_interest_expense")).toBe(600n);
    expect(await bal(db, worldId, "payable_to_borrower", borrower.agentId)).toBe(0n);
    expect(await bal(db, worldId, "notes_payable", lender.agentId)).toBe(-30600n);
    // cash: 30000 − 25000 + 40000 − 14250 = 30750 = holders 30600 + bank 150.
    expect(await bal(db, worldId, "cash_paypal")).toBe(30750n);
    expect((await trialBalance(db, worldId)).totalCents).toBe(0n);
    await expectPositionsMatchLedger(db, worldId);

    const [position] = await db.select().from(notePositions).where(eq(notePositions.agentId, lender.agentId));
    expect(position?.units).toBe(30600n);
    expect(position?.accruedCents).toBe(600n);

    // Events.
    const types = (await db.select().from(events).where(eq(events.aggregateId, borrower.loanId))).map((e) => e.type);
    expect(types).toEqual(
      expect.arrayContaining(["loan.repayment_received", "loan.repaid", "loan.remainder_paid"]),
    );

    // get_loan: REPAID, link PAID.
    const after = await call(db, "get_loan", borrower.key, { loan_id: borrower.loanId });
    expect((after.envelope.data as Data).status).toBe("REPAID");
    expect(((after.envelope.data as Data).repayment_link as Data).status).toBe("PAID");

    // get_statement — lender sees 600 earned on a 30600 balance.
    const lenderStatement = await call(db, "get_statement", lender.key, {});
    expect(lenderStatement.envelope.status).toBe("OK");
    const ls = lenderStatement.envelope.data as Data;
    expect(ls.notes).toEqual({ balance_cents: 30600, earned_cents: 600 });
    expect(ls.loans).toEqual([]);
    const lenderLines = ls.ledger_lines as Data[];
    expect(lenderLines.map((l) => [l.account, l.amount_cents])).toEqual([
      ["notes_payable", 30000],
      ["notes_payable", 600],
    ]);
    for (const line of lenderLines) {
      expect(typeof line.sim_at).toBe("string");
      expect(typeof line.memo).toBe("string");
    }

    // Borrower: its loan, and the remainder in then out of payable_to_borrower; nothing of the lender's.
    const borrowerStatement = (await call(db, "get_statement", borrower.key, {})).envelope.data as Data;
    expect(borrowerStatement.notes).toEqual({ balance_cents: 0, earned_cents: 0 });
    expect(borrowerStatement.loans).toEqual([
      expect.objectContaining({ loan_id: borrower.loanId, status: "REPAID", outstanding_cents: 0 }),
    ]);
    expect((borrowerStatement.ledger_lines as Data[]).map((l) => [l.account, l.amount_cents])).toEqual([
      ["payable_to_borrower", 14250],
      ["payable_to_borrower", -14250],
    ]);
  });

  it("partial direct repay 10000 → fee 750 first, principal 9250, ACTIVE with 15750 outstanding; default amount then repays in full", async () => {
    const worldId = await createSimWorld(db);
    const lender = await fundPool(db, worldId, 30000);
    const borrower = await borrow(db, worldId, { invoice: false });
    expect(await invoiceLink(db, borrower.loanId)).toBeUndefined();
    const noLink = await call(db, "get_loan", borrower.key, { loan_id: borrower.loanId });
    expect(noLink.envelope.data as Data).not.toHaveProperty("repayment_link");

    const repay = await call(db, "repay_loan", borrower.key, { loan_id: borrower.loanId, amount_cents: 10000 });
    expect(repay.httpStatus).toBe(200);
    expect(repay.envelope.status).toBe("AWAITING_APPROVAL");
    const repayData = repay.envelope.data as Data;
    expect(repayData.amount_cents).toBe(10000);
    const checkoutId = repayData.checkout_id as string;
    expect(repay.envelope.next_actions[0]).toEqual({
      tool: "human_approval",
      args: {
        url: repayData.approve_url,
        who: "payer",
        then: { tool: "confirm_checkout", args: { checkout_id: checkoutId } },
      },
    });

    await simApprove(db, checkoutId);
    const confirmed = await call(db, "confirm_checkout", borrower.key, { checkout_id: checkoutId });
    expect(confirmed.envelope.status).toBe("COMPLETED");
    expect(confirmed.envelope.data as Data).toMatchObject({
      loan_id: borrower.loanId,
      loan_status: "ACTIVE",
      applied_fee_cents: 750,
      applied_principal_cents: 9250,
      remainder_cents: 0,
      outstanding_cents: 15750,
    });

    const [loan] = await db.select().from(loans).where(eq(loans.id, borrower.loanId));
    expect(loan?.status).toBe("active");
    expect(loan?.outstandingCents).toBe(15750n);
    expect(await bal(db, worldId, "loans_receivable")).toBe(15750n);
    expect(await bal(db, worldId, "fee_income")).toBe(-750n);
    expect(await bal(db, worldId, "notes_payable", lender.agentId)).toBe(-30600n);
    expect(await remainderOps(db, worldId)).toHaveLength(0);
    expect((await trialBalance(db, worldId)).totalCents).toBe(0n);

    // Default amount = outstanding (15750, all principal — no fee left, so no holders' journal).
    const rest = await call(db, "repay_loan", borrower.key, { loan_id: borrower.loanId });
    const restData = rest.envelope.data as Data;
    expect(restData.amount_cents).toBe(15750);
    await simApprove(db, restData.checkout_id as string);
    const done = await call(db, "confirm_checkout", borrower.key, { checkout_id: restData.checkout_id });
    expect(done.envelope.status).toBe("COMPLETED");
    expect((done.envelope.data as Data).loan_status).toBe("REPAID");

    const [repaid] = await db.select().from(loans).where(eq(loans.id, borrower.loanId));
    expect(repaid?.status).toBe("repaid");
    expect(repaid?.outstandingCents).toBe(0n);
    expect(await bal(db, worldId, "loans_receivable")).toBe(0n);
    expect(await bal(db, worldId, "notes_payable", lender.agentId)).toBe(-30600n);
    expect(await bal(db, worldId, "note_interest_expense")).toBe(600n);
    expect((await trialBalance(db, worldId)).totalCents).toBe(0n);
    await expectPositionsMatchLedger(db, worldId);

    // A REPAID loan can't be repaid again.
    const again = await call(db, "repay_loan", borrower.key, { loan_id: borrower.loanId });
    expect(again.httpStatus).toBe(409);
    expect(again.envelope.status).toBe("INVALID_TRANSITION");
  });

  it("holders' share is cumulative over partial payments: fee paid as 1 then 749 cents → holders 600 in total", async () => {
    const worldId = await createSimWorld(db);
    const lender = await fundPool(db, worldId, 30000);
    const borrower = await borrow(db, worldId, { invoice: false });

    for (const amount of [1, 749]) {
      const repay = await call(db, "repay_loan", borrower.key, { loan_id: borrower.loanId, amount_cents: amount });
      const checkoutId = (repay.envelope.data as Data).checkout_id as string;
      await simApprove(db, checkoutId);
      const done = await call(db, "confirm_checkout", borrower.key, { checkout_id: checkoutId });
      expect(done.envelope.status).toBe("COMPLETED");
    }

    expect(await bal(db, worldId, "fee_income")).toBe(-750n);
    expect(await bal(db, worldId, "note_interest_expense")).toBe(600n);
    expect(await bal(db, worldId, "notes_payable", lender.agentId)).toBe(-30600n);
    const [loan] = await db.select().from(loans).where(eq(loans.id, borrower.loanId));
    expect(loan?.outstandingCents).toBe(25000n);
    expect((await trialBalance(db, worldId)).totalCents).toBe(0n);
    await expectPositionsMatchLedger(db, worldId);
  });

  it("invoice link description: no double space when the invoice description is blank", () => {
    expect(invoiceLinkDescription("Website build", "Acme Agent")).toBe(
      "Invoice Website build — pay to Mandate on behalf of Acme Agent",
    );
    expect(invoiceLinkDescription("", "Acme Agent")).toBe("Invoice — pay to Mandate on behalf of Acme Agent");
    expect(invoiceLinkDescription("   ", "Acme Agent")).toBe("Invoice — pay to Mandate on behalf of Acme Agent");
    expect(invoiceLinkDescription("x".repeat(500), "Acme Agent").length).toBeLessThanOrEqual(127);
  });

  it("repay_loan: overpaying → 400 AMOUNT_EXCEEDS_OUTSTANDING; another agent's loan → NOT_FOUND", async () => {
    const worldId = await createSimWorld(db);
    const lender = await fundPool(db, worldId, 30000);
    const borrower = await borrow(db, worldId, { invoice: false });

    const over = await call(db, "repay_loan", borrower.key, { loan_id: borrower.loanId, amount_cents: 25751 });
    expect(over.httpStatus).toBe(400);
    expect(over.envelope.status).toBe("AMOUNT_EXCEEDS_OUTSTANDING");
    expect((over.envelope.data as Data).outstanding_cents).toBe(25750);

    const other = await call(db, "repay_loan", lender.key, { loan_id: borrower.loanId });
    expect(other.httpStatus).toBe(404);
    expect(other.envelope.status).toBe("NOT_FOUND");

    expect(
      await db.select().from(repaymentLinks).where(eq(repaymentLinks.worldId, worldId)),
    ).toHaveLength(0);
  });

  it("the borrower can confirm its client's link itself; another agent can't", async () => {
    const worldId = await createSimWorld(db);
    const lender = await fundPool(db, worldId, 30000);
    const borrower = await borrow(db, worldId);
    const link = await invoiceLink(db, borrower.loanId);
    await simApprove(db, link!.paypalOrderId!);

    const foreign = await call(db, "confirm_checkout", lender.key, { checkout_id: link!.paypalOrderId });
    expect(foreign.envelope.status).toBe("NOT_FOUND");

    const own = await call(db, "confirm_checkout", borrower.key, { checkout_id: link!.paypalOrderId });
    expect(own.envelope.status).toBe("COMPLETED");
    expect((own.envelope.data as Data).loan_status).toBe("REPAID");
    expect((own.envelope.data as Data).remainder_cents).toBe(14250);
  });

  it("Review Focus 2: settling the same link order twice, then concurrently with confirm_checkout → one journal, one repayment, one remainder payout", async () => {
    const worldId = await createSimWorld(db);
    await fundPool(db, worldId, 30000);
    const borrower = await borrow(db, worldId);
    const link = await invoiceLink(db, borrower.loanId);
    const orderId = link!.paypalOrderId!;
    await simApprove(db, orderId);

    const results = await Promise.all([
      settleCheckoutByOrderId(db, worldId, orderId),
      settleCheckoutByOrderId(db, worldId, orderId),
      call(db, "confirm_checkout", borrower.key, { checkout_id: orderId }),
    ]);
    // Whoever lost the race may report PENDING; a later pass completes.
    expect(results.map((r) => ("envelope" in r ? r.envelope.status : r.status))).toContain("COMPLETED");
    const again = await settleCheckoutByOrderId(db, worldId, orderId);
    expect(again.status).toBe("COMPLETED");
    const third = await settleCheckoutByOrderId(db, worldId, orderId);
    expect(third.status).toBe("COMPLETED");

    expect(await repaymentJournalCount(db, worldId)).toBe(2); // the repayment + the holders' share, once each
    expect(await db.select().from(repayments).where(eq(repayments.worldId, worldId))).toHaveLength(1);
    expect(await remainderOps(db, worldId)).toHaveLength(1);
    const repaidEvents = (await db.select().from(events).where(eq(events.aggregateId, borrower.loanId))).filter(
      (e) => e.type === "loan.repaid",
    );
    expect(repaidEvents).toHaveLength(1);
    expect(await bal(db, worldId, "cash_paypal")).toBe(30750n);
    expect(await bal(db, worldId, "payable_to_borrower", borrower.agentId)).toBe(0n);
    expect((await trialBalance(db, worldId)).totalCents).toBe(0n);
    await expectPositionsMatchLedger(db, worldId);
  });

  it("an unapproved link order is not captured (AWAITING_APPROVAL), and a later settle after approval works", async () => {
    const worldId = await createSimWorld(db);
    await fundPool(db, worldId, 30000);
    const borrower = await borrow(db, worldId);
    const link = await invoiceLink(db, borrower.loanId);

    const early = await settleCheckoutByOrderId(db, worldId, link!.paypalOrderId!);
    expect(early.status).toBe("AWAITING_APPROVAL");
    const [loan] = await db.select().from(loans).where(eq(loans.id, borrower.loanId));
    expect(loan?.status).toBe("active");

    await simApprove(db, link!.paypalOrderId!);
    expect((await settleCheckoutByOrderId(db, worldId, link!.paypalOrderId!)).status).toBe("COMPLETED");
  });

  it("settleCheckoutByOrderId for an unknown order → NOT_FOUND", async () => {
    const worldId = await createSimWorld(db);
    expect((await settleCheckoutByOrderId(db, worldId, "SIMORDER-nope")).status).toBe("NOT_FOUND");
  });

  it("two holders share the fee pro rata (20000/10000 → 400/200)", async () => {
    const worldId = await createSimWorld(db);
    const big = await fundPool(db, worldId, 20000, "big@example.com");
    const small = await fundPool(db, worldId, 10000, "small@example.com");
    const borrower = await borrow(db, worldId);
    const link = await invoiceLink(db, borrower.loanId);
    await simApprove(db, link!.paypalOrderId!);
    expect((await settleCheckoutByOrderId(db, worldId, link!.paypalOrderId!)).status).toBe("COMPLETED");

    expect(await bal(db, worldId, "notes_payable", big.agentId)).toBe(-20400n);
    expect(await bal(db, worldId, "notes_payable", small.agentId)).toBe(-10200n);
    expect((await trialBalance(db, worldId)).totalCents).toBe(0n);
    await expectPositionsMatchLedger(db, worldId);

    // Earned interest is redeemable: the big holder redeems 20400 in full.
    const redeemed = await call(db, "redeem_notes", big.key, { amount_cents: 20400 });
    expect(redeemed.envelope.status).toBe("PENDING"); // settled by its afterCommit payout
    const [pos] = await db.select().from(notePositions).where(eq(notePositions.agentId, big.agentId));
    expect(pos?.units).toBe(0n);
    expect(pos?.costCents).toBe(0n);
    expect(await bal(db, worldId, "notes_payable", big.agentId)).toBe(0n);
    expect((await trialBalance(db, worldId)).totalCents).toBe(0n);
  });

  it("a failed remainder payout leaves the money owed in payable_to_borrower (shown by get_status), held out of liquidity", async () => {
    const worldId = await createSimWorld(db);
    await fundPool(db, worldId, 30000);
    const borrower = await borrow(db, worldId);
    // The borrower's payout receiver goes bad after the disbursement.
    await db.update(agents).set({ payoutReceiver: "fail-borrower@example.com" }).where(eq(agents.id, borrower.agentId));

    const link = await invoiceLink(db, borrower.loanId);
    await simApprove(db, link!.paypalOrderId!);
    expect((await settleCheckoutByOrderId(db, worldId, link!.paypalOrderId!)).status).toBe("COMPLETED");

    const [repayment] = await db.select().from(repayments).where(eq(repayments.loanId, borrower.loanId));
    expect(repayment?.remainderStatus).toBe("failed");
    expect(await bal(db, worldId, "payable_to_borrower", borrower.agentId)).toBe(-14250n);
    expect(await bal(db, worldId, "cash_paypal")).toBe(45000n);
    expect((await trialBalance(db, worldId)).totalCents).toBe(0n);
    // The borrower's money is not lendable pool liquidity.
    expect(await availableLiquidity(db, worldId)).toBe(30750n);

    const status = await call(db, "get_status", borrower.key, {});
    expect((status.envelope.data as Data).balances).toMatchObject({ payable_to_you_cents: 14250 });

    const types = (await db.select().from(events).where(eq(events.aggregateId, borrower.loanId))).map((e) => e.type);
    expect(types).toContain("loan.remainder_payout_failed");

    // Re-settling doesn't post or pay anything again.
    await settleCheckoutByOrderId(db, worldId, link!.paypalOrderId!);
    expect(await remainderOps(db, worldId)).toHaveLength(1);
    expect(await bal(db, worldId, "payable_to_borrower", borrower.agentId)).toBe(-14250n);
  });

  it("a live-shaped (pending) remainder payout is settled later by pollPayoutStatus", async () => {
    const worldId = await createSimWorld(db);
    await fundPool(db, worldId, 30000);
    const borrower = await borrow(db, worldId);
    await db
      .update(agents)
      .set({ payoutReceiver: "pending-borrower@example.com" })
      .where(eq(agents.id, borrower.agentId));

    const link = await invoiceLink(db, borrower.loanId);
    await simApprove(db, link!.paypalOrderId!);
    expect((await settleCheckoutByOrderId(db, worldId, link!.paypalOrderId!)).status).toBe("COMPLETED");

    const [pending] = await db.select().from(repayments).where(eq(repayments.loanId, borrower.loanId));
    expect(pending?.remainderStatus).toBe("pending");
    expect(await bal(db, worldId, "payable_to_borrower", borrower.agentId)).toBe(-14250n);
    expect(await availableLiquidity(db, worldId)).toBe(30750n);

    const polled = await pollPayoutStatus(db, pending!.remainderPayoutOpId!);
    expect(polled).toEqual({ polled: true, reason: "polled" });

    const [paid] = await db.select().from(repayments).where(eq(repayments.loanId, borrower.loanId));
    expect(paid?.remainderStatus).toBe("paid");
    expect(await bal(db, worldId, "payable_to_borrower", borrower.agentId)).toBe(0n);
    expect(await bal(db, worldId, "cash_paypal")).toBe(30750n);
    expect((await trialBalance(db, worldId)).totalCents).toBe(0n);

    expect(await pollPayoutStatus(db, pending!.remainderPayoutOpId!)).toEqual({
      polled: false,
      reason: "source_settled",
    });
  });

  it("the client pays the link after the loan was already repaid directly → the whole payment is remainder, returned to the borrower", async () => {
    const worldId = await createSimWorld(db);
    const lender = await fundPool(db, worldId, 30000);
    const borrower = await borrow(db, worldId);

    const repay = await call(db, "repay_loan", borrower.key, { loan_id: borrower.loanId });
    const checkoutId = (repay.envelope.data as Data).checkout_id as string;
    await simApprove(db, checkoutId);
    expect((await call(db, "confirm_checkout", borrower.key, { checkout_id: checkoutId })).envelope.status).toBe(
      "COMPLETED",
    );

    const link = await invoiceLink(db, borrower.loanId);
    await simApprove(db, link!.paypalOrderId!);
    expect((await settleCheckoutByOrderId(db, worldId, link!.paypalOrderId!)).status).toBe("COMPLETED");

    const rows = await db.select().from(repayments).where(eq(repayments.loanId, borrower.loanId));
    const linkRepayment = rows.find((r) => r.grossCents === 40000n);
    expect(linkRepayment).toMatchObject({
      appliedFeeCents: 0n,
      appliedPrincipalCents: 0n,
      remainderCents: 40000n,
      remainderStatus: "paid",
    });
    // Holders earned on the fee exactly once.
    expect(await bal(db, worldId, "notes_payable", lender.agentId)).toBe(-30600n);
    expect(await bal(db, worldId, "payable_to_borrower", borrower.agentId)).toBe(0n);
    expect((await trialBalance(db, worldId)).totalCents).toBe(0n);
    const repaidEvents = (await db.select().from(events).where(eq(events.aggregateId, borrower.loanId))).filter(
      (e) => e.type === "loan.repaid",
    );
    expect(repaidEvents).toHaveLength(1);
  });
});
