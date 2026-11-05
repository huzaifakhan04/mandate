import { and, eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { generateApiKey } from "@/server/auth/apiKeys";
import { advanceClock, getSimNow } from "@/server/clock/clock";
import "@/server/contracts/tools";
import { findTool } from "@/server/contracts/registry";
import { runTool } from "@/server/contracts/runTool";
import type { Db } from "@/server/db/client";
import { agents, apiKeys, journalEntries, loans, offers, paypalOperations, repaymentLinks } from "@/server/db/schema";
import { createTestDb } from "@/server/db/testing";
import { disclosureHash } from "@/server/domain/disclosure";
import { availableLiquidity } from "@/server/domain/liquidity";
import { getAccountBalance, trialBalance } from "@/server/ledger/trialBalance";
import { executeOperation } from "@/server/paypal/operations";
import { simApprove, simClaimPayoutItem } from "@/server/rail/simHandler";
import { pollPayoutStatus } from "@/server/services/payoutPolling";
import {
  __resetLoanActivatedHooksForTests,
  applyPayoutOutcome,
  registerLoanActivatedHook,
} from "@/server/services/loans";
import { invoiceRepaymentLinkHook } from "@/server/services/repayments";
import { createWorld } from "@/server/services/worlds";

type Data = Record<string, unknown>;

async function createSimWorld(db: Db) {
  const { worldId } = await createWorld(db, { name: "Loan World", ownerPrincipalId: null, railMode: "sim" });
  return worldId;
}

async function createTestAgent(db: Db, worldId: string, payoutReceiver: string | null = "borrower@example.com") {
  const [agent] = await db
    .insert(agents)
    .values({
      worldId,
      name: "Test Agent",
      operator: "test-operator",
      model: "test-model",
      codeManifestHash: "deadbeef",
      status: "active",
      payoutReceiver,
      payoutReceiverType: payoutReceiver ? "email" : null,
    })
    .returning();

  const generated = generateApiKey();
  await db.insert(apiKeys).values({ worldId, agentId: agent!.id, prefix: generated.prefix, keyHash: generated.hash });
  return { agentId: agent!.id, key: generated.key };
}

async function call(
  db: Db,
  toolName: string,
  key: string,
  input: Record<string, unknown>,
  idempotencyKey: string | null = null,
) {
  return runTool(findTool(toolName), toolName, input, {
    getDb: async () => db,
    authorization: `Bearer ${key}`,
    idempotencyKey,
  });
}

/** Funds the world's pool by `amountCents` via a lender's sim note purchase. */
async function fundPool(db: Db, worldId: string, amountCents: number) {
  const lender = await createTestAgent(db, worldId, "lender@example.com");
  const buy = await call(db, "buy_notes", lender.key, { amount_cents: amountCents });
  const checkoutId = (buy.envelope.data as Data).checkout_id as string;
  await simApprove(db, checkoutId);
  const confirmed = await call(db, "confirm_checkout", lender.key, { checkout_id: checkoutId });
  expect(confirmed.envelope.status).toBe("COMPLETED");
  return lender;
}

async function applyFor(db: Db, key: string, amountCents: number, termDays: number, extra: Data = {}) {
  return call(db, "apply_for_loan", key, {
    amount_cents: amountCents,
    term_days: termDays,
    purpose: "Working capital for an invoice",
    ...extra,
  });
}

async function cashBalance(db: Db, worldId: string) {
  return getAccountBalance(db, worldId, "cash_paypal", null);
}

async function loansReceivable(db: Db, worldId: string) {
  return getAccountBalance(db, worldId, "loans_receivable", null);
}

describe("lending: check_eligibility / apply_for_loan / accept_offer / decline_offer / get_loan", () => {
  let db: Db;

  beforeEach(async () => {
    process.env.API_KEY_PEPPER = "test-pepper";
    db = await createTestDb();
  });

  afterEach(() => {
    delete process.env.API_KEY_PEPPER;
    __resetLoanActivatedHooksForTests();
    // Keep the production hook (Task 7's invoice link) registered: the
    // reset only exists to drop the per-test fixture hooks.
    registerLoanActivatedHook(invoiceRepaymentLinkHook);
  });

  it("check_eligibility on an empty pool: not eligible (insufficient_liquidity), with a quote", async () => {
    const worldId = await createSimWorld(db);
    const { key } = await createTestAgent(db, worldId);

    const result = await call(db, "check_eligibility", key, { amount_cents: 25000, term_days: 14 });
    expect(result.httpStatus).toBe(200);
    const data = result.envelope.data as Data;
    expect(data.eligible).toBe(false);
    expect(data.reasons).toEqual(["insufficient_liquidity"]);
    expect(data.max_principal_cents).toBe(0);
    expect(data.available_liquidity_cents).toBe(0);
    expect(data.quote).toEqual({ fee_cents: 750, apr_bps: 7821, total_cents: 25750 });
  });

  it("check_eligibility on a funded pool: eligible, max principal = min(50000, liquidity); out of range reasons", async () => {
    const worldId = await createSimWorld(db);
    await fundPool(db, worldId, 30000);
    const { key } = await createTestAgent(db, worldId);

    const ok = await call(db, "check_eligibility", key, { amount_cents: 25000, term_days: 14 });
    expect((ok.envelope.data as Data).eligible).toBe(true);
    expect((ok.envelope.data as Data).reasons).toEqual([]);
    expect((ok.envelope.data as Data).max_principal_cents).toBe(30000);
    expect(ok.envelope.next_actions[0]).toEqual({
      tool: "apply_for_loan",
      args: { amount_cents: 25000, term_days: 14, purpose: "<describe what the money is for>" },
    });

    const bad = await call(db, "check_eligibility", key, { amount_cents: 500, term_days: 45 });
    const badData = bad.envelope.data as Data;
    expect(badData.eligible).toBe(false);
    expect(badData.reasons).toEqual(["amount_out_of_range", "term_out_of_range"]);
  });

  it("apply on an empty pool → DECLINED insufficient_liquidity", async () => {
    const worldId = await createSimWorld(db);
    const { key } = await createTestAgent(db, worldId);

    const result = await applyFor(db, key, 25000, 14);
    expect(result.httpStatus).toBe(200);
    expect(result.envelope.status).toBe("DECLINED");
    expect(result.envelope.next_actions).toEqual([
      { tool: "check_eligibility", args: { amount_cents: 25000, term_days: 14 } },
    ]);
    expect(result.envelope.reason_codes).toEqual(["insufficient_liquidity"]);
    expect((result.envelope.data as Data).application_id).toBeTruthy();
    expect(await db.select().from(offers).where(eq(offers.worldId, worldId))).toHaveLength(0);
  });

  it("apply out of range → DECLINED amount_out_of_range / term_out_of_range", async () => {
    const worldId = await createSimWorld(db);
    await fundPool(db, worldId, 100000);
    const { key } = await createTestAgent(db, worldId);

    const result = await applyFor(db, key, 60000, 5);
    expect(result.envelope.status).toBe("DECLINED");
    expect(result.envelope.reason_codes).toEqual(["amount_out_of_range", "term_out_of_range"]);
  });

  it("apply rejects an invoice smaller than the loan amount (INVALID_REQUEST)", async () => {
    const worldId = await createSimWorld(db);
    const { key } = await createTestAgent(db, worldId);
    const result = await applyFor(db, key, 25000, 14, {
      invoice: { client_email: "client@example.com", amount_cents: 20000, due_in_days: 10, description: "Work" },
    });
    expect(result.httpStatus).toBe(400);
    expect(result.envelope.status).toBe("INVALID_REQUEST");
  });

  it("fund via notes, apply, accept → loan ACTIVE, loans_receivable 25000, balanced ledger", async () => {
    const worldId = await createSimWorld(db);
    await fundPool(db, worldId, 30000);
    const { key, agentId } = await createTestAgent(db, worldId);
    const simNow = await getSimNow(db, worldId);

    const applied = await applyFor(db, key, 25000, 14, {
      invoice: { client_email: "client@example.com", amount_cents: 40000, due_in_days: 14, description: "Website build" },
    });
    expect(applied.envelope.status).toBe("OFFERED");
    const data = applied.envelope.data as Data;
    const disclosure = data.disclosure as Data;
    expect(disclosure).toMatchObject({
      funding_provided_cents: 25000,
      fee_cents: 750,
      estimated_apr_bps: 7821,
      total_repayment_cents: 25750,
      term_days: 14,
      prepayment: "No penalty",
      collateral: "Invoice payment link",
      avoidable_fees: "None in P1",
      note: "APR above 36% may exceed some state caps (unverified)",
      due_rule: "14 days after funds are sent",
    });
    expect(disclosure).not.toHaveProperty("due_date");
    expect(new Date(disclosure.estimated_due_date as string).getTime() - simNow.getTime()).toBeGreaterThanOrEqual(
      14 * 86_400_000,
    );
    expect(data.disclosure_hash).toBe(disclosureHash(disclosure));
    // Ruling P: due_rule is covered by the hash.
    expect(disclosureHash({ ...disclosure, due_rule: "14 days after the offer" })).not.toBe(data.disclosure_hash);
    const expiresAt = new Date(data.expires_sim_at as string).getTime();
    expect(expiresAt - simNow.getTime()).toBeGreaterThanOrEqual(86_400_000);
    expect(expiresAt - simNow.getTime()).toBeLessThan(86_400_000 + 60_000);
    expect(applied.envelope.next_actions).toEqual([
      { tool: "accept_offer", args: { offer_id: data.offer_id, disclosure_hash: data.disclosure_hash } },
      { tool: "decline_offer", args: { offer_id: data.offer_id } },
    ]);

    const accepted = await call(db, "accept_offer", key, {
      offer_id: data.offer_id,
      disclosure_hash: data.disclosure_hash,
    });
    expect(accepted.httpStatus).toBe(200);
    expect(accepted.envelope.status).toBe("ACTIVE");
    const acceptedData = accepted.envelope.data as Data;
    expect(acceptedData.status).toBe("ACTIVE");
    expect(acceptedData.disbursement).toEqual({ status: "SUCCEEDED" });

    expect(await loansReceivable(db, worldId)).toBe(25000n);
    expect(await cashBalance(db, worldId)).toBe(5000n);
    expect((await trialBalance(db, worldId)).totalCents).toBe(0n);
    expect(await availableLiquidity(db, worldId)).toBe(5000n);

    const [loan] = await db.select().from(loans).where(eq(loans.worldId, worldId));
    expect(loan?.agentId).toBe(agentId);
    expect(loan?.status).toBe("active");
    expect(loan?.outstandingCents).toBe(25750n);
    expect(loan?.disbursedSimAt).toBeTruthy();
    expect(loan!.dueSimAt.getTime() - loan!.disbursedSimAt!.getTime()).toBe(14 * 86_400_000);

    const got = await call(db, "get_loan", key, { loan_id: acceptedData.loan_id });
    expect(got.envelope.status).toBe("OK");
    const loanData = got.envelope.data as Data;
    expect(loanData).toMatchObject({
      loan_id: acceptedData.loan_id,
      status: "ACTIVE",
      principal_cents: 25000,
      fee_cents: 750,
      outstanding_cents: 25750,
    });
    const history = (loanData.history as Data[]).map((e) => e.type);
    expect(history).toEqual(["loan.offered", "loan.accepted", "loan.disbursed"]);

    // Task 7: the invoice's repayment link was created on activation.
    const links = await db.select().from(repaymentLinks).where(eq(repaymentLinks.loanId, acceptedData.loan_id as string));
    expect(links).toHaveLength(1);
    expect(links[0]?.amountCents).toBe(40000n);
  });

  it("no invoice → collateral None", async () => {
    const worldId = await createSimWorld(db);
    await fundPool(db, worldId, 50000);
    const { key } = await createTestAgent(db, worldId);
    const applied = await applyFor(db, key, 10000, 7);
    expect((applied.envelope.data as Data).disclosure).toMatchObject({ collateral: "None" });
  });

  it("a disclosure hash mismatch → 400 DISCLOSURE_MISMATCH, no loan", async () => {
    const worldId = await createSimWorld(db);
    await fundPool(db, worldId, 30000);
    const { key } = await createTestAgent(db, worldId);
    const applied = await applyFor(db, key, 25000, 14);
    const offerId = (applied.envelope.data as Data).offer_id;

    const result = await call(db, "accept_offer", key, { offer_id: offerId, disclosure_hash: "0".repeat(64) });
    expect(result.httpStatus).toBe(400);
    expect(result.envelope.status).toBe("DISCLOSURE_MISMATCH");
    expect(await db.select().from(loans).where(eq(loans.worldId, worldId))).toHaveLength(0);
  });

  it("an expired offer → 400 OFFER_EXPIRED, offer marked expired", async () => {
    const worldId = await createSimWorld(db);
    await fundPool(db, worldId, 30000);
    const { key } = await createTestAgent(db, worldId);
    const applied = await applyFor(db, key, 25000, 14);
    const { offer_id, disclosure_hash } = applied.envelope.data as Data;

    await advanceClock(db, worldId, 2);

    const result = await call(db, "accept_offer", key, { offer_id, disclosure_hash });
    expect(result.httpStatus).toBe(400);
    expect(result.envelope.status).toBe("OFFER_EXPIRED");
    const [offer] = await db.select().from(offers).where(eq(offers.id, offer_id as string));
    expect(offer?.status).toBe("expired");
  });

  it("Review Focus 4: two agents concurrently accept 20000 each against a 30000 pool → exactly one loan", async () => {
    const worldId = await createSimWorld(db);
    await fundPool(db, worldId, 30000);
    const a = await createTestAgent(db, worldId, "a@example.com");
    const b = await createTestAgent(db, worldId, "b@example.com");

    const offerA = (await applyFor(db, a.key, 20000, 14)).envelope.data as Data;
    const offerB = (await applyFor(db, b.key, 20000, 14)).envelope.data as Data;
    expect(offerA.offer_id).toBeTruthy();
    expect(offerB.offer_id).toBeTruthy();

    const [ra, rb] = await Promise.all([
      call(db, "accept_offer", a.key, { offer_id: offerA.offer_id, disclosure_hash: offerA.disclosure_hash }),
      call(db, "accept_offer", b.key, { offer_id: offerB.offer_id, disclosure_hash: offerB.disclosure_hash }),
    ]);

    const statuses = [ra.envelope.status, rb.envelope.status].sort();
    expect(statuses).toEqual(["ACTIVE", "INSUFFICIENT_LIQUIDITY"]);
    const loser = ra.envelope.status === "INSUFFICIENT_LIQUIDITY" ? ra : rb;
    expect(loser.httpStatus).toBe(400);

    expect(await db.select().from(loans).where(eq(loans.worldId, worldId))).toHaveLength(1);
    expect(await loansReceivable(db, worldId)).toBe(20000n);
    expect(await cashBalance(db, worldId)).toBe(10000n);
  });

  it("Review Focus 4: accept_offer holds a FOR UPDATE lock on the note series row (Ruling N)", async () => {
    // PGlite runs one transaction at a time, so the Promise.all test
    // above can't observe a missing lock; this asserts the lock itself.
    // A tuple locked by SELECT … FOR UPDATE carries the locker's xid in
    // xmax until that transaction ends.
    const worldId = await createSimWorld(db);
    await fundPool(db, worldId, 30000);
    const { key, agentId } = await createTestAgent(db, worldId);
    const applied = (await applyFor(db, key, 10000, 7)).envelope.data as Data;
    const { beginAcceptOffer } = await import("@/server/services/loans");

    const lockedBySelf = await db.transaction(async (tx) => {
      const outcome = await beginAcceptOffer(
        tx,
        worldId,
        agentId,
        applied.offer_id as string,
        applied.disclosure_hash as string,
      );
      expect(outcome.outcome).toBe("disbursing");
      const result = await tx.execute(
        sql`select (xmax::text = (txid_current() % 4294967296)::text) as locked from note_series where world_id = ${worldId}`,
      );
      return (result.rows[0] as { locked: boolean }).locked;
    });
    expect(lockedBySelf).toBe(true);
  });

  it("Review Focus 4: a DISBURSING loan's principal is reserved against the next accept", async () => {
    const worldId = await createSimWorld(db);
    await fundPool(db, worldId, 30000);
    const a = await createTestAgent(db, worldId, "a@example.com");
    const b = await createTestAgent(db, worldId, "b@example.com");
    const offerA = (await applyFor(db, a.key, 20000, 14)).envelope.data as Data;
    const offerB = (await applyFor(db, b.key, 20000, 14)).envelope.data as Data;

    // Make A's payout come back with no item yet (PayPal's usual live
    // POST response), so A's loan stays DISBURSING.
    const { beginAcceptOffer } = await import("@/server/services/loans");
    const first = await db.transaction((tx) =>
      beginAcceptOffer(tx, worldId, a.agentId, offerA.offer_id as string, offerA.disclosure_hash as string),
    );
    expect(first.outcome).toBe("disbursing");

    expect(await availableLiquidity(db, worldId)).toBe(10000n);
    const second = await call(db, "accept_offer", b.key, {
      offer_id: offerB.offer_id,
      disclosure_hash: offerB.disclosure_hash,
    });
    expect(second.envelope.status).toBe("INSUFFICIENT_LIQUIDITY");
  });

  it("Review Focus 5: a payout to a failing receiver → DISBURSEMENT_FAILED, loans_receivable 0, liquidity released", async () => {
    const worldId = await createSimWorld(db);
    await fundPool(db, worldId, 30000);
    const { key } = await createTestAgent(db, worldId, "fail@example.com");
    const applied = (await applyFor(db, key, 25000, 14)).envelope.data as Data;

    const result = await call(db, "accept_offer", key, {
      offer_id: applied.offer_id,
      disclosure_hash: applied.disclosure_hash,
    });
    expect(result.envelope.status).toBe("DISBURSEMENT_FAILED");
    expect(result.envelope.reason_codes).toContain("payout_failed");
    expect(result.envelope.summary).toMatch(/FAILED/);
    expect((result.envelope.data as Data).disbursement).toEqual({ status: "FAILED" });

    expect(await loansReceivable(db, worldId)).toBe(0n);
    const [failedLoan] = await db.select().from(loans).where(eq(loans.worldId, worldId));
    expect(failedLoan?.outstandingCents).toBe(0n);
    expect(await cashBalance(db, worldId)).toBe(30000n);
    expect(await availableLiquidity(db, worldId)).toBe(30000n);
    expect((await trialBalance(db, worldId)).totalCents).toBe(0n);

    const got = await call(db, "get_loan", key, { loan_id: (result.envelope.data as Data).loan_id });
    expect((got.envelope.data as Data).status).toBe("DISBURSEMENT_FAILED");
    expect((got.envelope.data as Data).outstanding_cents).toBe(0);
    expect(((got.envelope.data as Data).history as Data[]).map((e) => e.type)).toContain(
      "loan.disbursement_failed",
    );

    // A failed disbursement doesn't count as an open loan.
    const again = await applyFor(db, key, 10000, 7);
    expect(again.envelope.status).toBe("OFFERED");
  });

  it("Ruling Q: live-shaped send (no item) stays DISBURSING with nothing owed; pollPayoutStatus → ACTIVE, one journal", async () => {
    const worldId = await createSimWorld(db);
    await fundPool(db, worldId, 30000);
    const { key } = await createTestAgent(db, worldId, "pending-borrower@example.com");
    const applied = (await applyFor(db, key, 25000, 14)).envelope.data as Data;

    const accepted = await call(db, "accept_offer", key, {
      offer_id: applied.offer_id,
      disclosure_hash: applied.disclosure_hash,
    });
    expect(accepted.envelope.status).toBe("DISBURSING");
    expect((accepted.envelope.data as Data).disbursement).toEqual({ status: "PENDING" });
    const loanId = (accepted.envelope.data as Data).loan_id as string;

    const disbursing = await call(db, "get_loan", key, { loan_id: loanId });
    expect((disbursing.envelope.data as Data).status).toBe("DISBURSING");
    expect((disbursing.envelope.data as Data).outstanding_cents).toBe(0);
    expect(await loansReceivable(db, worldId)).toBe(0n);
    expect(await availableLiquidity(db, worldId)).toBe(5000n); // principal reserved

    const [loan] = await db.select().from(loans).where(eq(loans.id, loanId));
    await pollPayoutStatus(db, loan!.disbursementOpId!);
    await pollPayoutStatus(db, loan!.disbursementOpId!);

    const active = await call(db, "get_loan", key, { loan_id: loanId });
    expect((active.envelope.data as Data).status).toBe("ACTIVE");
    expect((active.envelope.data as Data).outstanding_cents).toBe(25750);
    expect(await loansReceivable(db, worldId)).toBe(25000n);
    const entries = await db
      .select()
      .from(journalEntries)
      .where(and(eq(journalEntries.worldId, worldId), eq(journalEntries.sourceId, loanId)));
    expect(entries).toHaveLength(1);
    const reads = await db
      .select()
      .from(paypalOperations)
      .where(and(eq(paypalOperations.worldId, worldId), eq(paypalOperations.kind, "payout.get")));
    expect(reads.length).toBeGreaterThanOrEqual(1);
  });

  it("Ruling Q: observed webhook ONHOLD stays DISBURSING; observed FAILED → DISBURSEMENT_FAILED, nothing owed", async () => {
    const worldId = await createSimWorld(db);
    await fundPool(db, worldId, 30000);
    const { key } = await createTestAgent(db, worldId, "pending-borrower@example.com");
    const applied = (await applyFor(db, key, 25000, 14)).envelope.data as Data;
    const accepted = await call(db, "accept_offer", key, {
      offer_id: applied.offer_id,
      disclosure_hash: applied.disclosure_hash,
    });
    const loanId = (accepted.envelope.data as Data).loan_id as string;
    const [loan] = await db.select().from(loans).where(eq(loans.id, loanId));

    await applyPayoutOutcome(db, loan!.disbursementOpId!, { itemStatus: "ONHOLD", source: "webhook" });
    expect((await db.select().from(loans).where(eq(loans.id, loanId)))[0]?.status).toBe("disbursing");

    await applyPayoutOutcome(db, loan!.disbursementOpId!, { itemStatus: "FAILED", source: "webhook" });
    const [failed] = await db.select().from(loans).where(eq(loans.id, loanId));
    expect(failed?.status).toBe("disbursement_failed");
    expect(failed?.outstandingCents).toBe(0n);
    expect(await loansReceivable(db, worldId)).toBe(0n);
    expect(await availableLiquidity(db, worldId)).toBe(30000n);

    const got = await call(db, "get_loan", key, { loan_id: loanId });
    expect(got.envelope.reason_codes).toEqual(["payout_failed"]);
    expect((got.envelope.data as Data).outstanding_cents).toBe(0);
  });

  it("Ruling R: UNCLAIMED → cancel → RETURNED → DISBURSEMENT_FAILED, liquidity released, no journal", async () => {
    const worldId = await createSimWorld(db);
    await fundPool(db, worldId, 30000);
    const { key } = await createTestAgent(db, worldId, "unclaimed-borrower@example.com");
    const applied = (await applyFor(db, key, 25000, 14)).envelope.data as Data;

    const result = await call(db, "accept_offer", key, {
      offer_id: applied.offer_id,
      disclosure_hash: applied.disclosure_hash,
    });
    expect(result.envelope.status).toBe("DISBURSEMENT_FAILED");
    expect(result.envelope.reason_codes).toEqual(["payout_failed", "payout_returned"]);

    const cancels = await db
      .select()
      .from(paypalOperations)
      .where(and(eq(paypalOperations.worldId, worldId), eq(paypalOperations.kind, "payout.cancel_item")));
    expect(cancels).toHaveLength(1);
    expect(cancels[0]?.status).toBe("succeeded");
    expect(cancels[0]?.purpose).toBe("payout_cancel");

    expect(await loansReceivable(db, worldId)).toBe(0n);
    expect(await availableLiquidity(db, worldId)).toBe(30000n);
    expect((await trialBalance(db, worldId)).totalCents).toBe(0n);
  });

  it("Ruling R: UNCLAIMED keeps the principal reserved; if claimed before the cancel lands, a poll activates the loan", async () => {
    const worldId = await createSimWorld(db);
    await fundPool(db, worldId, 30000);
    const { key, agentId } = await createTestAgent(db, worldId, "unclaimed-borrower@example.com");
    const applied = (await applyFor(db, key, 25000, 14)).envelope.data as Data;

    const { beginAcceptOffer } = await import("@/server/services/loans");
    const begun = await db.transaction((tx) =>
      beginAcceptOffer(tx, worldId, agentId, applied.offer_id as string, applied.disclosure_hash as string),
    );
    if (begun.outcome !== "disbursing") throw new Error(`expected disbursing, got ${begun.outcome}`);

    // The payout goes out UNCLAIMED, then the receiver claims it before
    // the bank's cancel lands (so the cancel is refused).
    const sent = await executeOperation(db, begun.payoutOperationId);
    const item = (sent.body as { item: { itemId: string; transactionStatus: string } }).item;
    expect(item.transactionStatus).toBe("UNCLAIMED");
    await simClaimPayoutItem(db, item.itemId);

    await applyPayoutOutcome(db, begun.payoutOperationId);
    expect((await db.select().from(loans).where(eq(loans.id, begun.loanId)))[0]?.status).toBe("disbursing");
    expect(await availableLiquidity(db, worldId)).toBe(5000n); // still reserved

    await pollPayoutStatus(db, begun.payoutOperationId);
    expect((await db.select().from(loans).where(eq(loans.id, begun.loanId)))[0]?.status).toBe("active");
    expect(await loansReceivable(db, worldId)).toBe(25000n);
  });

  it("M2: max_principal_cents is 0 when liquidity is below the 1000-cent minimum", async () => {
    const worldId = await createSimWorld(db);
    const { key } = await createTestAgent(db, worldId);
    // Fund 1000, then reserve 500 of it as a pending redemption → 500 left.
    const lender = await fundPool(db, worldId, 1000);
    const { beginNoteRedemption } = await import("@/server/services/notes");
    await db.transaction((tx) => beginNoteRedemption(tx, worldId, lender.agentId, 500n));
    const result = await call(db, "check_eligibility", key, { amount_cents: 1000, term_days: 7 });
    expect((result.envelope.data as Data).available_liquidity_cents).toBe(500);
    expect((result.envelope.data as Data).max_principal_cents).toBe(0);
  });

  it("M4: an unknown payout receiver type → PAYOUT_RECEIVER_MISSING", async () => {
    const worldId = await createSimWorld(db);
    await fundPool(db, worldId, 30000);
    const { key, agentId } = await createTestAgent(db, worldId);
    await db.update(agents).set({ payoutReceiverType: "venmo" }).where(eq(agents.id, agentId));
    const applied = (await applyFor(db, key, 10000, 7)).envelope.data as Data;
    const result = await call(db, "accept_offer", key, {
      offer_id: applied.offer_id,
      disclosure_hash: applied.disclosure_hash,
    });
    expect(result.envelope.status).toBe("PAYOUT_RECEIVER_MISSING");
  });

  it("the loan-activated hook runs once, inside the activation transaction", async () => {
    const worldId = await createSimWorld(db);
    await fundPool(db, worldId, 30000);
    const { key } = await createTestAgent(db, worldId);
    const seen: Array<{ id: string; status: string }> = [];
    registerLoanActivatedHook(async (_tx, loan) => {
      seen.push({ id: loan.id, status: loan.status });
    });

    const applied = (await applyFor(db, key, 25000, 14)).envelope.data as Data;
    const accepted = await call(db, "accept_offer", key, {
      offer_id: applied.offer_id,
      disclosure_hash: applied.disclosure_hash,
    });
    const loanId = (accepted.envelope.data as Data).loan_id as string;
    await applyPayoutOutcome(db, (await db.select().from(loans).where(eq(loans.id, loanId)))[0]!.disbursementOpId!);
    expect(seen).toEqual([{ id: loanId, status: "active" }]);
  });

  it("a throwing loan-activated hook rolls the activation back (no journal, still DISBURSING)", async () => {
    const worldId = await createSimWorld(db);
    await fundPool(db, worldId, 30000);
    const { key } = await createTestAgent(db, worldId);
    registerLoanActivatedHook(async () => {
      throw new Error("boom");
    });
    const applied = (await applyFor(db, key, 25000, 14)).envelope.data as Data;
    const accepted = await call(db, "accept_offer", key, {
      offer_id: applied.offer_id,
      disclosure_hash: applied.disclosure_hash,
    });
    expect(accepted.envelope.status).toBe("DISBURSING");
    expect(await loansReceivable(db, worldId)).toBe(0n);
  });

  it("one open loan per agent: apply → DECLINED open_loan_exists; accepting another open offer → OPEN_LOAN_EXISTS", async () => {
    const worldId = await createSimWorld(db);
    await fundPool(db, worldId, 100000);
    const { key, agentId } = await createTestAgent(db, worldId);

    // An open offer, then (out of band) an ACTIVE loan for the same agent
    // — the situation accept_offer must refuse.
    const pendingOffer = (await applyFor(db, key, 10000, 7)).envelope.data as Data;
    const simNow = await getSimNow(db, worldId);
    await db.insert(loans).values({
      worldId,
      offerId: pendingOffer.offer_id as string,
      agentId,
      principalCents: 5000n,
      feeCents: 75n,
      outstandingCents: 5075n,
      dueSimAt: simNow,
      status: "active",
    });

    const second = await call(db, "accept_offer", key, {
      offer_id: pendingOffer.offer_id,
      disclosure_hash: pendingOffer.disclosure_hash,
    });
    expect(second.httpStatus).toBe(409);
    expect(second.envelope.status).toBe("OPEN_LOAN_EXISTS");

    const declined = await applyFor(db, key, 10000, 7);
    expect(declined.envelope.status).toBe("DECLINED");
    expect(declined.envelope.reason_codes).toEqual(["open_loan_exists"]);

    const eligibility = await call(db, "check_eligibility", key, { amount_cents: 10000, term_days: 7 });
    expect((eligibility.envelope.data as Data).reasons).toEqual(["open_loan_exists"]);
  });

  it("the DB backstop rejects a second open loan for the same agent", async () => {
    const worldId = await createSimWorld(db);
    await fundPool(db, worldId, 30000);
    const { key, agentId } = await createTestAgent(db, worldId);
    const applied = (await applyFor(db, key, 10000, 7)).envelope.data as Data;
    const simNow = await getSimNow(db, worldId);
    const row = {
      worldId,
      offerId: applied.offer_id as string,
      agentId,
      principalCents: 10000n,
      feeCents: 150n,
      outstandingCents: 10150n,
      dueSimAt: simNow,
    };
    await db.insert(loans).values({ ...row, status: "active" });
    await expect(db.insert(loans).values({ ...row, status: "disbursing" })).rejects.toThrow();
    // Closed loans don't count.
    await db.insert(loans).values({ ...row, status: "disbursement_failed" });
  });

  it("applying again supersedes (expires) the agent's earlier open offer", async () => {
    const worldId = await createSimWorld(db);
    await fundPool(db, worldId, 30000);
    const { key } = await createTestAgent(db, worldId);

    const first = (await applyFor(db, key, 10000, 7)).envelope.data as Data;
    const second = await applyFor(db, key, 12000, 7);
    expect(second.envelope.status).toBe("OFFERED");

    const [firstOffer] = await db.select().from(offers).where(eq(offers.id, first.offer_id as string));
    expect(firstOffer?.status).toBe("expired");

    const accept = await call(db, "accept_offer", key, {
      offer_id: first.offer_id,
      disclosure_hash: first.disclosure_hash,
    });
    expect(accept.envelope.status).toBe("OFFER_EXPIRED");
  });

  it("decline_offer → DECLINED_BY_AGENT; a later accept → 409 INVALID_TRANSITION", async () => {
    const worldId = await createSimWorld(db);
    await fundPool(db, worldId, 30000);
    const { key } = await createTestAgent(db, worldId);
    const applied = (await applyFor(db, key, 10000, 7)).envelope.data as Data;

    const declined = await call(db, "decline_offer", key, { offer_id: applied.offer_id });
    expect(declined.envelope.status).toBe("DECLINED_BY_AGENT");
    const [offer] = await db.select().from(offers).where(eq(offers.id, applied.offer_id as string));
    expect(offer?.status).toBe("declined_by_agent");

    const again = await call(db, "decline_offer", key, { offer_id: applied.offer_id });
    expect(again.httpStatus).toBe(409);
    expect(again.envelope.status).toBe("INVALID_TRANSITION");

    const accept = await call(db, "accept_offer", key, {
      offer_id: applied.offer_id,
      disclosure_hash: applied.disclosure_hash,
    });
    expect(accept.httpStatus).toBe(409);
    expect(accept.envelope.status).toBe("INVALID_TRANSITION");
  });

  it("another agent's offer or loan is NOT_FOUND", async () => {
    const worldId = await createSimWorld(db);
    await fundPool(db, worldId, 30000);
    const owner = await createTestAgent(db, worldId, "owner@example.com");
    const other = await createTestAgent(db, worldId, "other@example.com");
    const applied = (await applyFor(db, owner.key, 10000, 7)).envelope.data as Data;

    const steal = await call(db, "accept_offer", other.key, {
      offer_id: applied.offer_id,
      disclosure_hash: applied.disclosure_hash,
    });
    expect(steal.httpStatus).toBe(404);
    expect(steal.envelope.status).toBe("NOT_FOUND");

    const declineOther = await call(db, "decline_offer", other.key, { offer_id: applied.offer_id });
    expect(declineOther.httpStatus).toBe(404);

    const accepted = await call(db, "accept_offer", owner.key, {
      offer_id: applied.offer_id,
      disclosure_hash: applied.disclosure_hash,
    });
    const loanId = (accepted.envelope.data as Data).loan_id;
    const peek = await call(db, "get_loan", other.key, { loan_id: loanId });
    expect(peek.httpStatus).toBe(404);
    expect(peek.envelope.status).toBe("NOT_FOUND");
  });

  it("accept_offer without a payout receiver → 400 PAYOUT_RECEIVER_MISSING, no loan", async () => {
    const worldId = await createSimWorld(db);
    await fundPool(db, worldId, 30000);
    const { key } = await createTestAgent(db, worldId, null);
    const applied = (await applyFor(db, key, 10000, 7)).envelope.data as Data;
    const result = await call(db, "accept_offer", key, {
      offer_id: applied.offer_id,
      disclosure_hash: applied.disclosure_hash,
    });
    expect(result.httpStatus).toBe(400);
    expect(result.envelope.status).toBe("PAYOUT_RECEIVER_MISSING");
    expect(await db.select().from(loans).where(eq(loans.worldId, worldId))).toHaveLength(0);
  });

  it("accept_offer under an Idempotency-Key replays the same loan without a second disbursement", async () => {
    const worldId = await createSimWorld(db);
    await fundPool(db, worldId, 30000);
    const { key } = await createTestAgent(db, worldId);
    const applied = (await applyFor(db, key, 10000, 7)).envelope.data as Data;
    const input = { offer_id: applied.offer_id, disclosure_hash: applied.disclosure_hash };

    const first = await call(db, "accept_offer", key, input, "accept-1");
    const second = await call(db, "accept_offer", key, input, "accept-1");
    expect(first.envelope.status).toBe("ACTIVE");
    expect(second.envelope).toEqual(first.envelope);
    expect(await db.select().from(loans).where(eq(loans.worldId, worldId))).toHaveLength(1);
    expect(await loansReceivable(db, worldId)).toBe(10000n);
  });

  it("get_status shows the open loan after acceptance", async () => {
    const worldId = await createSimWorld(db);
    await fundPool(db, worldId, 30000);
    const { key } = await createTestAgent(db, worldId);
    const applied = (await applyFor(db, key, 10000, 7)).envelope.data as Data;
    await call(db, "accept_offer", key, { offer_id: applied.offer_id, disclosure_hash: applied.disclosure_hash });
    const status = await call(db, "get_status", key, {});
    expect(((status.envelope.data as Data).open_loan as Data).status).toBe("ACTIVE");
  });
});

describe("Fix round 2: pollPayoutStatus is bounded", () => {
  let db: Db;

  beforeEach(async () => {
    process.env.API_KEY_PEPPER = "test-pepper";
    db = await createTestDb();
  });

  afterEach(() => {
    delete process.env.API_KEY_PEPPER;
  });

  async function payoutGetRows(worldId: string) {
    return db
      .select()
      .from(paypalOperations)
      .where(and(eq(paypalOperations.worldId, worldId), eq(paypalOperations.kind, "payout.get")));
  }

  async function disbursingLoan(receiver: string) {
    const worldId = await createSimWorld(db);
    await fundPool(db, worldId, 30000);
    const { key } = await createTestAgent(db, worldId, receiver);
    const applied = (await applyFor(db, key, 25000, 14)).envelope.data as Data;
    const accepted = await call(db, "accept_offer", key, {
      offer_id: applied.offer_id,
      disclosure_hash: applied.disclosure_hash,
    });
    const loanId = (accepted.envelope.data as Data).loan_id as string;
    const [loan] = await db.select().from(loans).where(eq(loans.id, loanId));
    return { worldId, loanId, sendOpId: loan!.disbursementOpId! };
  }

  it("a settled source → no poll, no new row", async () => {
    const { worldId, sendOpId } = await disbursingLoan("borrower@example.com"); // ACTIVE immediately
    const result = await pollPayoutStatus(db, sendOpId);
    expect(result).toEqual({ polled: false, reason: "source_settled" });
    expect(await payoutGetRows(worldId)).toHaveLength(0);
  });

  it("two immediate polls → one payout.get; after the interval → a second one", async () => {
    // A live-shaped ("pending") send resolves SUCCESS on the first poll;
    // the loan is put back to DISBURSING afterwards so later polls still
    // have a source that needs polling, isolating the throttle.
    const { worldId, loanId, sendOpId } = await disbursingLoan("pending-borrower@example.com");
    const t0 = new Date();

    const first = await pollPayoutStatus(db, sendOpId, { now: t0 });
    expect(first).toEqual({ polled: true, reason: "polled" });
    await db.update(loans).set({ status: "disbursing" }).where(eq(loans.id, loanId));

    const second = await pollPayoutStatus(db, sendOpId, { now: new Date(t0.getTime() + 1_000) });
    expect(second).toEqual({ polled: false, reason: "throttled" });
    expect(await payoutGetRows(worldId)).toHaveLength(1);

    // < 10 min since the send → 1-minute interval.
    const third = await pollPayoutStatus(db, sendOpId, { now: new Date(t0.getTime() + 61_000) });
    expect(third).toEqual({ polled: true, reason: "polled" });
    expect(await payoutGetRows(worldId)).toHaveLength(2);
  });

  it("the interval backs off with the age of the send", async () => {
    const { pollIntervalMs } = await import("@/server/services/payoutPolling");
    const min = 60_000;
    expect(pollIntervalMs(5 * min)).toBe(1 * min);
    expect(pollIntervalMs(30 * min)).toBe(5 * min);
    expect(pollIntervalMs(5 * 60 * min)).toBe(30 * min);
    expect(pollIntervalMs(48 * 60 * min)).toBe(6 * 60 * min);
  });

  it("latestPayoutGetForSend breaks a created_at tie deterministically (id desc)", async () => {
    const { latestPayoutGetForSend } = await import("@/server/paypal/operations");
    const { worldId, sendOpId } = await disbursingLoan("pending-borrower@example.com");
    const [send] = await db.select().from(paypalOperations).where(eq(paypalOperations.id, sendOpId));
    const batchId = send!.paypalId!;
    const at = new Date(send!.createdAt.getTime() + 5_000);
    const row = (id: string, status: string) => ({
      id,
      worldId,
      rail: "sim",
      kind: "payout.get",
      requestId: id,
      status: "succeeded",
      paypalId: batchId,
      createdAt: at,
      response: { batchId, batchStatus: "PENDING", items: [{ itemId: "I", transactionStatus: status }] },
    });
    await db.insert(paypalOperations).values([
      row("00000000-0000-4000-8000-000000000001", "PENDING"),
      row("ffffffff-ffff-4fff-bfff-ffffffffffff", "SUCCESS"),
    ]);
    const latest = await latestPayoutGetForSend(db, sendOpId);
    expect(latest?.items[0]?.transactionStatus).toBe("SUCCESS");
  });

  it("a non-send operation → not polled", async () => {
    const { sendOpId } = await disbursingLoan("borrower@example.com");
    const { deriveOperationId } = await import("@/server/paypal/operations");
    const result = await pollPayoutStatus(db, deriveOperationId("x", "payout_cancel", sendOpId));
    expect(result).toEqual({ polled: false, reason: "not_a_payout_send" });
  });
});

