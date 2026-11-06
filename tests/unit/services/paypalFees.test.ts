import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Db } from "@/server/db/client";
import { paypalOperations, postings, repayments } from "@/server/db/schema";
import { createTestDb } from "@/server/db/testing";
import { availableLiquidity } from "@/server/domain/liquidity";
import { CHART_OF_ACCOUNTS } from "@/server/ledger/accounts";
import { getAccountBalance, trialBalance } from "@/server/ledger/trialBalance";
import { runReconcile } from "@/server/jobs/reconcile";
import { simApprove } from "@/server/rail/simHandler";
import { listPayoutSendsAwaitingFee } from "@/server/paypal/operations";
import { knownPayoutFee } from "@/server/services/paypalFees";
import { dispatchPayoutOutcome, pollPayoutStatus } from "@/server/services/payoutPolling";

import {
  borrow,
  call,
  createSimWorld,
  createTestAgent,
  fundPool,
  getLoan,
  invoiceLink,
  journalsWithKeyPrefix,
  later,
  type Data,
} from "../jobs/fixtures";

/**
 * Task 10b (Ruling U): PayPal's processing fees are the bank's expense —
 * Dr `paypal_fees_expense` / Cr `cash_paypal`, posted exactly once per
 * capture (`paypal_fee:capture:<captureId>`) and per payout batch
 * (`paypal_fee:payout:<batchId>`), in the same transaction as the
 * capture / payout-success effect — so `cash_paypal` tracks the real
 * PayPal balance. Sim fees: 2.9% + 30¢ per capture, 25¢ per SUCCESS item.
 */

/** Ruling W: every world opens with the bank's seed capital (default 10000). */
const SEED = 10000n;

async function cash(db: Db, worldId: string) {
  return getAccountBalance(db, worldId, "cash_paypal", null);
}

async function feesExpense(db: Db, worldId: string) {
  return getAccountBalance(db, worldId, "paypal_fees_expense", null);
}

async function postingsOf(db: Db, entryId: string) {
  return db.select().from(postings).where(eq(postings.entryId, entryId));
}

describe("knownPayoutFee (fix round 3, M6)", () => {
  const send = { batchId: "B", batchStatus: "PENDING", item: null, feeCents: null };
  const get = (batchStatus: string, feeCents: string | null) => ({
    batchId: "B",
    batchStatus,
    items: [{ itemId: "I", transactionStatus: "SUCCESS" }],
    feeCents,
  });

  it("a non-zero fee on a SUCCESS item is known", () => {
    expect(knownPayoutFee(send, get("PROCESSING", "25"))).toEqual({ batchId: "B", feeCents: 25n });
  });

  it("a 0.00 fee is known only once the batch itself is final (SUCCESS)", () => {
    expect(knownPayoutFee(send, get("PROCESSING", "0"))).toBeNull();
    expect(knownPayoutFee(send, get("SUCCESS", "0"))).toEqual({ batchId: "B", feeCents: 0n });
  });
});

describe("PayPal fee journaling", () => {
  let db: Db;

  beforeEach(async () => {
    process.env.API_KEY_PEPPER = "test-pepper";
    db = await createTestDb();
  });

  afterEach(() => {
    delete process.env.API_KEY_PEPPER;
  });

  it("paypal_fees_expense is an expense account in the chart", () => {
    expect(CHART_OF_ACCOUNTS.paypal_fees_expense).toBe("expense");
  });

  it("a note purchase capture journals its fee once (confirm twice → one fee journal); cash and liquidity are net of it", async () => {
    const worldId = await createSimWorld(db);
    const lender = await createTestAgent(db, worldId, "lender@example.com", "Lender");
    const buy = await call(db, "buy_notes", lender.key, { amount_cents: 30000 });
    const checkoutId = (buy.envelope.data as Data).checkout_id as string;
    await simApprove(db, checkoutId);
    expect((await call(db, "confirm_checkout", lender.key, { checkout_id: checkoutId })).envelope.status).toBe("COMPLETED");
    expect((await call(db, "confirm_checkout", lender.key, { checkout_id: checkoutId })).envelope.status).toBe("COMPLETED");

    const fees = await journalsWithKeyPrefix(db, worldId, "paypal_fee:capture:");
    expect(fees).toHaveLength(1);
    expect(fees[0]!.idempotencyKey).toMatch(/^paypal_fee:capture:SIMCAPTURE-/);
    const lines = await postingsOf(db, fees[0]!.id);
    expect(lines.map((line) => line.amountCents).sort()).toEqual([-900n, 900n]);

    expect(await cash(db, worldId)).toBe(SEED + 29100n);
    expect(await feesExpense(db, worldId)).toBe(900n);
    expect(await availableLiquidity(db, worldId)).toBe(SEED + 29100n);
    expect((await trialBalance(db, worldId)).totalCents).toBe(0n);

    // The lender's note balance is the full 30000 — fees are the bank's.
    const statement = (await call(db, "get_statement", lender.key, {})).envelope.data as Data;
    expect((statement.notes as Data).balance_cents).toBe(30000);
    const statementLines = statement.ledger_lines as { account: string; memo: string; amount_cents: number }[];
    expect(statementLines.every((line) => line.account !== "paypal_fees_expense" && line.account !== "cash_paypal")).toBe(true);
    expect(statementLines.map((line) => line.amount_cents)).toEqual([30000]);
  });

  it("a loan disbursement's payout fee is journaled once with the disbursement; repayment capture + remainder fees too; goldens unchanged", async () => {
    const worldId = await createSimWorld(db);
    await fundPool(db, worldId, 30000);
    const borrower = await borrow(db, worldId);
    expect((await getLoan(db, borrower.loanId)).status).toBe("active");

    const payoutFees = await journalsWithKeyPrefix(db, worldId, "paypal_fee:payout:");
    expect(payoutFees).toHaveLength(1);
    expect(payoutFees[0]!.idempotencyKey).toBe(`paypal_fee:payout:SIMBATCH-${borrower.sendOpId}`);
    // 30000 − 900 (capture fee) − 25000 (principal) − 25 (payout fee).
    expect(await cash(db, worldId)).toBe(SEED + 4075n);

    // The client pays the 40000 invoice: fee 1190 (2.9% = 1160 + 30), remainder 14250 paid out (fee 25).
    const link = await invoiceLink(db, borrower.loanId);
    await simApprove(db, link!.paypalOrderId!);
    await runReconcile(db, { now: later() });
    expect((await getLoan(db, borrower.loanId)).status).toBe("repaid");
    const [repayment] = await db.select().from(repayments).where(eq(repayments.loanId, borrower.loanId));
    expect(repayment).toMatchObject({ remainderCents: 14250n, remainderStatus: "paid" });

    expect(await journalsWithKeyPrefix(db, worldId, "paypal_fee:capture:")).toHaveLength(2);
    expect(await journalsWithKeyPrefix(db, worldId, "paypal_fee:payout:")).toHaveLength(2);
    expect(await feesExpense(db, worldId)).toBe(900n + 25n + 1190n + 25n);
    // Holders still get 600 of the 750 loan fee.
    expect(await getAccountBalance(db, worldId, "note_interest_expense", null)).toBe(600n);
    // 4075 + 40000 − 1190 − 14250 − 25.
    expect(await cash(db, worldId)).toBe(SEED + 28610n);
    expect((await trialBalance(db, worldId)).totalCents).toBe(0n);

    // Re-running reconcile never posts a fee twice.
    await runReconcile(db, { now: later(10 * 60_000) });
    expect(await journalsWithKeyPrefix(db, worldId, "paypal_fee:")).toHaveLength(4);
  });

  it("a payout fee unknown at success (webhook first, live-shaped send) is posted by the later poll — once", async () => {
    const worldId = await createSimWorld(db);
    await fundPool(db, worldId, 30000);
    const borrower = await borrow(db, worldId, { invoice: false, receiver: "pending-borrower@example.com" });
    expect((await getLoan(db, borrower.loanId)).status).toBe("disbursing");

    // The webhook says SUCCESS before any payout.get: the loan activates, the fee isn't known yet.
    await dispatchPayoutOutcome(db, borrower.sendOpId, { itemStatus: "SUCCESS", source: "webhook" });
    expect((await getLoan(db, borrower.loanId)).status).toBe("active");
    expect(await journalsWithKeyPrefix(db, worldId, "paypal_fee:payout:")).toHaveLength(0);

    // The reconcile cron polls the settled batch for its fee.
    await runReconcile(db, { now: later(2 * 60_000) });
    expect(await journalsWithKeyPrefix(db, worldId, "paypal_fee:payout:")).toHaveLength(1);

    // More polls / webhooks: still one.
    await pollPayoutStatus(db, borrower.sendOpId, { now: later(60 * 60_000) });
    await dispatchPayoutOutcome(db, borrower.sendOpId, { itemStatus: "SUCCESS", source: "webhook" });
    await runReconcile(db, { now: later(3 * 60 * 60_000) });
    expect(await journalsWithKeyPrefix(db, worldId, "paypal_fee:payout:")).toHaveLength(1);
    expect(await cash(db, worldId)).toBe(SEED + 30000n - 900n - 25000n - 25n);
    expect((await trialBalance(db, worldId)).totalCents).toBe(0n);
  });

  it("a payout fee still unknown 72 h after the send is listed as payout_fee_unknown (not before)", async () => {
    const worldId = await createSimWorld(db);
    await fundPool(db, worldId, 30000);
    const borrower = await borrow(db, worldId, { invoice: false, receiver: "pending-borrower@example.com" });
    await dispatchPayoutOutcome(db, borrower.sendOpId, { itemStatus: "SUCCESS", source: "webhook" });
    expect((await getLoan(db, borrower.loanId)).status).toBe("active");

    // Inside the window: no anomaly (the fee poll would still read it).
    const young = await runReconcile(db, { now: later(), limit: 0 });
    expect(young.anomalies.filter((a) => a.type === "payout_fee_unknown")).toEqual([]);

    // PayPal never reported the fee within 72 h: listed, nothing journaled.
    await db
      .update(paypalOperations)
      .set({ createdAt: sql`now() - interval '73 hours'` })
      .where(eq(paypalOperations.id, borrower.sendOpId));
    const report = await runReconcile(db, { now: later() });
    expect(report.anomalies).toContainEqual({
      type: "payout_fee_unknown",
      worldId,
      sourceId: borrower.loanId,
      detail: {
        kind: "loan_disbursement",
        send_operation_id: borrower.sendOpId,
        batch_id: `SIMBATCH-${borrower.sendOpId}`,
      },
    });
    expect(await journalsWithKeyPrefix(db, worldId, "paypal_fee:payout:")).toHaveLength(0);
  });

  it("fix round 3 (I2): the fee scan skips sends whose fee is journaled or whose source failed, newest first", async () => {
    const worldId = await createSimWorld(db);
    await fundPool(db, worldId, 100000);
    const journaled = await borrow(db, worldId, { invoice: false }); // fee journaled with the disbursement
    const failed = await borrow(db, worldId, { invoice: false, receiver: "fail-borrower@example.com" });
    expect((await getLoan(db, failed.loanId)).status).toBe("disbursement_failed");
    const older = await borrow(db, worldId, { invoice: false, receiver: "pending-a@example.com" });
    await dispatchPayoutOutcome(db, older.sendOpId, { itemStatus: "SUCCESS", source: "webhook" });
    const newer = await borrow(db, worldId, { invoice: false, receiver: "pending-b@example.com" });
    await dispatchPayoutOutcome(db, newer.sendOpId, { itemStatus: "SUCCESS", source: "webhook" });
    // Make the order deterministic: `older` was sent a minute earlier.
    await db
      .update(paypalOperations)
      .set({ createdAt: sql`now() - interval '1 minute'` })
      .where(eq(paypalOperations.id, older.sendOpId));

    const listed = await listPayoutSendsAwaitingFee(db, worldId, { since: new Date(Date.now() - 3_600_000) });
    expect(listed).toEqual([newer.sendOpId, older.sendOpId]);
    expect(listed).not.toContain(journaled.sendOpId);
    expect(listed).not.toContain(failed.sendOpId);
    expect(await listPayoutSendsAwaitingFee(db, worldId, { since: new Date(0), limit: 1 })).toEqual([newer.sendOpId]);
  });

  it("a note redemption's payout fee is journaled; a failed payout has none", async () => {
    const worldId = await createSimWorld(db);
    const lender = await fundPool(db, worldId, 30000);
    await call(db, "redeem_notes", lender.key, { amount_cents: 1000 });
    expect(await journalsWithKeyPrefix(db, worldId, "note_redemption:")).toHaveLength(1);
    expect(await journalsWithKeyPrefix(db, worldId, "paypal_fee:payout:")).toHaveLength(1);
    expect(await cash(db, worldId)).toBe(SEED + 30000n - 900n - 1000n - 25n);

    const failing = await fundPool(db, worldId, 1000, "fail-lender@example.com");
    await call(db, "redeem_notes", failing.key, { amount_cents: 500 });
    expect(await journalsWithKeyPrefix(db, worldId, "note_redemption:")).toHaveLength(1);
    expect(await journalsWithKeyPrefix(db, worldId, "paypal_fee:payout:")).toHaveLength(1);
    expect((await trialBalance(db, worldId)).totalCents).toBe(0n);
  });
});
