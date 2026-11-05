import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { generateApiKey } from "@/server/auth/apiKeys";
import "@/server/contracts/tools";
import { findTool } from "@/server/contracts/registry";
import { runTool } from "@/server/contracts/runTool";
import type { Db } from "@/server/db/client";
import {
  agents,
  apiKeys,
  journalEntries,
  noteSeries,
  noteTransactions,
  notePositions,
  paypalOperations,
} from "@/server/db/schema";
import { createTestDb } from "@/server/db/testing";
import { availableLiquidity } from "@/server/domain/liquidity";
import { trialBalance } from "@/server/ledger/trialBalance";
import { deriveOperationId } from "@/server/paypal/operations";
import { simApprove } from "@/server/rail/simHandler";
import { beginNoteRedemption } from "@/server/services/notes";
import { createWorld } from "@/server/services/worlds";

async function createSimWorld(db: Db) {
  const { worldId } = await createWorld(db, { name: "Test World", ownerPrincipalId: null, railMode: "sim" });
  return worldId;
}

async function createTestAgent(db: Db, worldId: string, payoutReceiver = "lender@example.com") {
  const [agent] = await db
    .insert(agents)
    .values({
      worldId,
      name: "Test Lender",
      operator: "test-operator",
      model: "test-model",
      codeManifestHash: "deadbeef",
      status: "active",
      payoutReceiver,
      payoutReceiverType: "email",
    })
    .returning();

  const generated = generateApiKey();
  await db.insert(apiKeys).values({
    worldId,
    agentId: agent!.id,
    prefix: generated.prefix,
    keyHash: generated.hash,
  });

  return { agentId: agent!.id, key: generated.key };
}

async function call(db: Db, toolName: string, key: string, input: Record<string, unknown>) {
  return runTool(findTool(toolName), toolName, input, { getDb: async () => db, authorization: `Bearer ${key}` });
}

describe("buy_notes / confirm_checkout / redeem_notes", () => {
  let db: Db;

  beforeEach(async () => {
    process.env.API_KEY_PEPPER = "test-pepper";
    db = await createTestDb();
  });

  afterEach(() => {
    delete process.env.API_KEY_PEPPER;
  });

  it("buy -> confirm credits cash_paypal/notes_payable and the note position", async () => {
    const worldId = await createSimWorld(db);
    const { key } = await createTestAgent(db, worldId);

    const buyResult = await call(db, "buy_notes", key, { amount_cents: 25000 });
    expect(buyResult.envelope.status).toBe("AWAITING_APPROVAL");
    const checkoutId = (buyResult.envelope.data as Record<string, unknown>).checkout_id as string;
    expect(checkoutId).toBeTruthy();
    expect((buyResult.envelope.data as Record<string, unknown>).approve_url).toBeTruthy();

    // Not yet approved.
    const beforeApproval = await call(db, "confirm_checkout", key, { checkout_id: checkoutId });
    expect(beforeApproval.envelope.status).toBe("AWAITING_APPROVAL");
    expect((beforeApproval.envelope.data as Record<string, unknown>).approve_url).toBeTruthy();

    await simApprove(db, checkoutId);

    const confirmed = await call(db, "confirm_checkout", key, { checkout_id: checkoutId });
    expect(confirmed.envelope.status).toBe("COMPLETED");

    const tb = await trialBalance(db, worldId);
    const cash = tb.accounts.find((a) => a.code === "cash_paypal" && a.ownerRef === null);
    const notesPayable = tb.accounts.find((a) => a.code === "notes_payable" && a.ownerRef !== null);
    expect(cash?.balanceCents).toBe(25000n);
    expect(notesPayable?.balanceCents).toBe(-25000n);
    expect(tb.totalCents).toBe(0n);

    const [position] = await db.select().from(notePositions).where(eq(notePositions.worldId, worldId));
    expect(position?.units).toBe(25000n);
  });

  it("confirming the same checkout twice posts exactly one journal entry", async () => {
    const worldId = await createSimWorld(db);
    const { key } = await createTestAgent(db, worldId);

    const buyResult = await call(db, "buy_notes", key, { amount_cents: 10000 });
    const checkoutId = (buyResult.envelope.data as Record<string, unknown>).checkout_id as string;
    await simApprove(db, checkoutId);

    const first = await call(db, "confirm_checkout", key, { checkout_id: checkoutId });
    expect(first.envelope.status).toBe("COMPLETED");
    const second = await call(db, "confirm_checkout", key, { checkout_id: checkoutId });
    expect(second.envelope.status).toBe("COMPLETED");

    const tb = await trialBalance(db, worldId);
    const cash = tb.accounts.find((a) => a.code === "cash_paypal" && a.ownerRef === null);
    expect(cash?.balanceCents).toBe(10000n);

    const [position] = await db.select().from(notePositions).where(eq(notePositions.worldId, worldId));
    expect(position?.units).toBe(10000n);
  });

  it("redeeming more than the position balance fails with INSUFFICIENT_NOTE_BALANCE", async () => {
    const worldId = await createSimWorld(db);
    const { key } = await createTestAgent(db, worldId);

    const buyResult = await call(db, "buy_notes", key, { amount_cents: 5000 });
    const checkoutId = (buyResult.envelope.data as Record<string, unknown>).checkout_id as string;
    await simApprove(db, checkoutId);
    await call(db, "confirm_checkout", key, { checkout_id: checkoutId });

    const redeem = await call(db, "redeem_notes", key, { amount_cents: 6000 });
    expect(redeem.httpStatus).toBe(400);
    expect(redeem.envelope.status).toBe("INSUFFICIENT_NOTE_BALANCE");
  });

  it("redeem -> payout success returns the balance to zero", async () => {
    const worldId = await createSimWorld(db);
    const { key } = await createTestAgent(db, worldId);

    const buyResult = await call(db, "buy_notes", key, { amount_cents: 15000 });
    const checkoutId = (buyResult.envelope.data as Record<string, unknown>).checkout_id as string;
    await simApprove(db, checkoutId);
    await call(db, "confirm_checkout", key, { checkout_id: checkoutId });

    const redeem = await call(db, "redeem_notes", key, { amount_cents: 15000 });
    expect(redeem.envelope.status).toBe("PENDING");

    const tb = await trialBalance(db, worldId);
    expect(tb.totalCents).toBe(0n);
    const cash = tb.accounts.find((a) => a.code === "cash_paypal" && a.ownerRef === null);
    const notesPayable = tb.accounts.find((a) => a.code === "notes_payable" && a.ownerRef !== null);
    expect(cash?.balanceCents).toBe(0n);
    expect(notesPayable?.balanceCents).toBe(0n);

    const [position] = await db.select().from(notePositions).where(eq(notePositions.worldId, worldId));
    expect(position?.units).toBe(0n);

    const liquidity = await availableLiquidity(db, worldId);
    expect(liquidity).toBe(0n);
  });

  it("a payout to a failing receiver leaves the note position unchanged", async () => {
    const worldId = await createSimWorld(db);
    const { key } = await createTestAgent(db, worldId, "fail@example.com");

    const buyResult = await call(db, "buy_notes", key, { amount_cents: 8000 });
    const checkoutId = (buyResult.envelope.data as Record<string, unknown>).checkout_id as string;
    await simApprove(db, checkoutId);
    await call(db, "confirm_checkout", key, { checkout_id: checkoutId });

    await call(db, "redeem_notes", key, { amount_cents: 8000 });

    const [position] = await db.select().from(notePositions).where(eq(notePositions.worldId, worldId));
    expect(position?.units).toBe(8000n);

    const tb = await trialBalance(db, worldId);
    const cash = tb.accounts.find((a) => a.code === "cash_paypal" && a.ownerRef === null);
    expect(cash?.balanceCents).toBe(8000n);

    // Fix round 1 (M5): the redemption's own transaction is failed, and
    // liquidity is restored (no longer counted as a pending redemption).
    const [redeemTx] = await db
      .select()
      .from(noteTransactions)
      .where(and(eq(noteTransactions.worldId, worldId), eq(noteTransactions.kind, "redeem")));
    expect(redeemTx?.status).toBe("failed");

    const liquidity = await availableLiquidity(db, worldId);
    expect(liquidity).toBe(8000n);
  });

  it("M5: confirming the same checkout twice posts exactly one journal entry (by idempotency key)", async () => {
    const worldId = await createSimWorld(db);
    const { key } = await createTestAgent(db, worldId);

    const buyResult = await call(db, "buy_notes", key, { amount_cents: 12000 });
    const checkoutId = (buyResult.envelope.data as Record<string, unknown>).checkout_id as string;
    await simApprove(db, checkoutId);

    await call(db, "confirm_checkout", key, { checkout_id: checkoutId });
    await call(db, "confirm_checkout", key, { checkout_id: checkoutId });
    await call(db, "confirm_checkout", key, { checkout_id: checkoutId });

    const entries = await db
      .select()
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.worldId, worldId),
          eq(journalEntries.idempotencyKey, `note_purchase_capture:${checkoutId}`),
        ),
      );
    expect(entries).toHaveLength(1);
  });

  it("M5: buy_notes under an Idempotency-Key replays the same checkout_id and approve_url", async () => {
    const worldId = await createSimWorld(db);
    const { key } = await createTestAgent(db, worldId);

    const buy = (input: Record<string, unknown>) =>
      runTool(findTool("buy_notes"), "buy_notes", input, {
        getDb: async () => db,
        authorization: `Bearer ${key}`,
        idempotencyKey: "buy-idem-1",
      });

    const first = await buy({ amount_cents: 9000 });
    const second = await buy({ amount_cents: 9000 });

    expect(first.envelope.status).toBe("AWAITING_APPROVAL");
    expect(second.envelope).toEqual(first.envelope);
    const firstData = first.envelope.data as Record<string, unknown>;
    const secondData = second.envelope.data as Record<string, unknown>;
    expect(secondData.checkout_id).toBe(firstData.checkout_id);
    expect(secondData.approve_url).toBe(firstData.approve_url);
  });
});

describe("Fix round 1: C1 note_positions.units CHECK constraint", () => {
  beforeEach(() => {
    process.env.API_KEY_PEPPER = "test-pepper";
  });

  afterEach(() => {
    delete process.env.API_KEY_PEPPER;
  });

  it("rejects a negative units value at the database level (backstop under the application-level check)", async () => {
    const db = await createTestDb();
    const worldId = await createSimWorld(db);
    const { agentId } = await createTestAgent(db, worldId);
    const [series] = await db.select().from(noteSeries).where(eq(noteSeries.worldId, worldId));

    await expect(
      db.insert(notePositions).values({ worldId, seriesId: series!.id, agentId, units: -1n, costCents: 0n }),
    ).rejects.toThrow();
  });
});

describe("Fix round 1: C1 double redemption", () => {
  let db: Db;

  beforeEach(async () => {
    process.env.API_KEY_PEPPER = "test-pepper";
    db = await createTestDb();
  });

  afterEach(() => {
    delete process.env.API_KEY_PEPPER;
  });

  it("a second redemption of the full balance while the first payout is still pending gets INSUFFICIENT_NOTE_BALANCE", async () => {
    const worldId = await createSimWorld(db);
    const { key, agentId } = await createTestAgent(db, worldId);

    const buyResult = await call(db, "buy_notes", key, { amount_cents: 10000 });
    const checkoutId = (buyResult.envelope.data as Record<string, unknown>).checkout_id as string;
    await simApprove(db, checkoutId);
    await call(db, "confirm_checkout", key, { checkout_id: checkoutId });

    // Enqueue a redemption but deliberately never settle it (call the
    // service directly, bypassing the tool's afterCommit settlement) —
    // this is the "payout stays pending" scenario.
    const first = await db.transaction((tx) => beginNoteRedemption(tx, worldId, agentId, 10000n));
    expect(first.outcome).toBe("submitted");

    const second = await db.transaction((tx) => beginNoteRedemption(tx, worldId, agentId, 10000n));
    expect(second.outcome).toBe("insufficient_note_balance");
    if (second.outcome === "insufficient_note_balance") {
      expect(second.redeemableUnits).toBe(0n);
    }

    const [position] = await db.select().from(notePositions).where(eq(notePositions.worldId, worldId));
    expect(position?.units).toBe(10000n); // untouched — nothing settled yet
  });

  it("Fix round 2 (item 2): two truly concurrent redemptions of the full balance — exactly one wins", async () => {
    const worldId = await createSimWorld(db);
    const { key, agentId } = await createTestAgent(db, worldId);

    const buyResult = await call(db, "buy_notes", key, { amount_cents: 7000 });
    const checkoutId = (buyResult.envelope.data as Record<string, unknown>).checkout_id as string;
    await simApprove(db, checkoutId);
    await call(db, "confirm_checkout", key, { checkout_id: checkoutId });

    // Both transactions race for the series lock, then the position
    // lock, before either reads `units`/the pending-redemption sum —
    // the fix under test (Fix round 2, item 2) is locking the position
    // row *before* that read, not after.
    const [first, second] = await Promise.all([
      db.transaction((tx) => beginNoteRedemption(tx, worldId, agentId, 7000n)),
      db.transaction((tx) => beginNoteRedemption(tx, worldId, agentId, 7000n)),
    ]);

    const outcomes = [first.outcome, second.outcome].sort();
    expect(outcomes).toEqual(["insufficient_note_balance", "submitted"]);

    const [position] = await db.select().from(notePositions).where(eq(notePositions.worldId, worldId));
    expect(position?.units).toBe(7000n); // neither settled; still untouched
  });
});

describe("Fix round 1: C2 payout item statuses", () => {
  let db: Db;

  beforeEach(async () => {
    process.env.API_KEY_PEPPER = "test-pepper";
    db = await createTestDb();
  });

  afterEach(() => {
    delete process.env.API_KEY_PEPPER;
  });

  it("a succeeded payout.send operation with no item (item: null) leaves the redemption pending", async () => {
    const { applyRedemptionPayoutOutcome } = await import("@/server/services/notes");
    const worldId = await createSimWorld(db);
    const { key, agentId } = await createTestAgent(db, worldId);

    const buyResult = await call(db, "buy_notes", key, { amount_cents: 5000 });
    const checkoutId = (buyResult.envelope.data as Record<string, unknown>).checkout_id as string;
    await simApprove(db, checkoutId);
    await call(db, "confirm_checkout", key, { checkout_id: checkoutId });

    const { noteTxId, payoutOperationId } = await db.transaction(async (tx) => {
      const outcome = await beginNoteRedemption(tx, worldId, agentId, 5000n);
      if (outcome.outcome !== "submitted") {
        throw new Error(`expected submitted, got ${outcome.outcome}`);
      }
      return outcome;
    });

    // Simulate what a live PayPal `payout.send` POST usually looks like:
    // the operation succeeded (batch accepted) but no item is reported
    // yet (that only shows up later via payout.get/webhook).
    await db
      .update(paypalOperations)
      .set({
        status: "succeeded",
        httpStatus: 201,
        response: { batchId: "BATCH-1", batchStatus: "PENDING", item: null },
        paypalId: "BATCH-1",
      })
      .where(eq(paypalOperations.id, payoutOperationId));

    await applyRedemptionPayoutOutcome(db, payoutOperationId);

    const [noteTx] = await db.select().from(noteTransactions).where(eq(noteTransactions.id, noteTxId));
    expect(noteTx?.status).toBe("pending");

    const [position] = await db.select().from(notePositions).where(eq(notePositions.worldId, worldId));
    expect(position?.units).toBe(5000n); // untouched
  });
});

describe("Fix round 1: I3 terminal checkout failure", () => {
  let db: Db;

  beforeEach(async () => {
    process.env.API_KEY_PEPPER = "test-pepper";
    db = await createTestDb();
  });

  afterEach(() => {
    delete process.env.API_KEY_PEPPER;
  });

  it("a VOIDED order fails the checkout and marks the note transaction failed", async () => {
    const worldId = await createSimWorld(db);
    const { key } = await createTestAgent(db, worldId);

    const buyResult = await call(db, "buy_notes", key, { amount_cents: 4000 });
    const checkoutId = (buyResult.envelope.data as Record<string, unknown>).checkout_id as string;

    // Void the sim order directly (no sim-rail path produces VOIDED —
    // this models a human/PayPal-side void of a real sandbox order).
    const [createOp] = await db
      .select()
      .from(paypalOperations)
      .where(and(eq(paypalOperations.kind, "order.create"), eq(paypalOperations.paypalId, checkoutId)));
    expect(createOp).toBeTruthy();
    await db
      .update(paypalOperations)
      .set({ simState: { ...(createOp!.simState as object), status: "VOIDED" } })
      .where(eq(paypalOperations.id, createOp!.id));

    const result = await call(db, "confirm_checkout", key, { checkout_id: checkoutId });
    expect(result.envelope.status).toBe("CHECKOUT_FAILED");
    expect(result.httpStatus).toBe(400);
    expect(result.envelope.reason_codes).toContain("order_voided");
    // Fix round 2 (item 4): the retry next action carries the original amount.
    expect(result.envelope.next_actions).toEqual([{ tool: "buy_notes", args: { amount_cents: 4000 } }]);

    const [noteTx] = await db
      .select()
      .from(noteTransactions)
      .where(and(eq(noteTransactions.worldId, worldId), eq(noteTransactions.kind, "buy")));
    expect(noteTx?.status).toBe("failed");
  });

  it("a terminally-failed capture operation fails the checkout and marks the note transaction failed", async () => {
    const worldId = await createSimWorld(db);
    const { key } = await createTestAgent(db, worldId);

    const buyResult = await call(db, "buy_notes", key, { amount_cents: 4500 });
    const checkoutId = (buyResult.envelope.data as Record<string, unknown>).checkout_id as string;
    await simApprove(db, checkoutId);

    // Pre-seed the deterministic capture operation row as terminally
    // failed (as if PayPal declined the capture outright) — this is the
    // `existingCaptureOp?.status === "failed_terminal"` branch of
    // `finalizeConfirmCheckout`, reached without ever attempting a GET
    // or a capture in this call.
    const captureOpId = deriveOperationId(worldId, "note_purchase_capture", checkoutId);
    await db.insert(paypalOperations).values({
      id: captureOpId,
      worldId,
      rail: "sim",
      kind: "order.capture",
      requestId: captureOpId,
      status: "failed_terminal",
      purpose: "note_purchase_capture",
      sourceId: checkoutId,
      attempts: 1,
      response: { error: { name: "DECLINED", issue: "INSTRUMENT_DECLINED", message: null, debugId: null, details: null } },
    });

    const result = await call(db, "confirm_checkout", key, { checkout_id: checkoutId });
    expect(result.envelope.status).toBe("CHECKOUT_FAILED");
    expect(result.httpStatus).toBe(400);
    expect(result.envelope.reason_codes).toContain("INSTRUMENT_DECLINED");
    // Fix round 2 (item 4): the retry next action carries the original amount.
    expect(result.envelope.next_actions).toEqual([{ tool: "buy_notes", args: { amount_cents: 4500 } }]);

    const [noteTx] = await db
      .select()
      .from(noteTransactions)
      .where(and(eq(noteTransactions.worldId, worldId), eq(noteTransactions.kind, "buy")));
    expect(noteTx?.status).toBe("failed");
  });
});

describe("Fix round 1: M2 amount mismatch / M3 no redundant order.get", () => {
  let db: Db;

  beforeEach(async () => {
    process.env.API_KEY_PEPPER = "test-pepper";
    db = await createTestDb();
  });

  afterEach(() => {
    delete process.env.API_KEY_PEPPER;
  });

  it("M2: a captured amount that doesn't match the note transaction fails the checkout and credits nothing", async () => {
    const worldId = await createSimWorld(db);
    const { key } = await createTestAgent(db, worldId);

    const buyResult = await call(db, "buy_notes", key, { amount_cents: 5000 });
    const checkoutId = (buyResult.envelope.data as Record<string, unknown>).checkout_id as string;
    await simApprove(db, checkoutId);

    // Pre-seed the deterministic capture operation as already succeeded,
    // but with a captured amount that doesn't match the 5000-cent note
    // transaction (M3: this is picked up directly, with no new
    // order.get/capture attempt).
    const captureOpId = deriveOperationId(worldId, "note_purchase_capture", checkoutId);
    await db.insert(paypalOperations).values({
      id: captureOpId,
      worldId,
      rail: "sim",
      kind: "order.capture",
      requestId: captureOpId,
      status: "succeeded",
      purpose: "note_purchase_capture",
      sourceId: checkoutId,
      paypalId: checkoutId,
      attempts: 1,
      response: { orderId: checkoutId, status: "COMPLETED", captureId: "CAP-1", captureStatus: "COMPLETED", amountCents: "1", recovered: false },
    });

    const getOpsBefore = await db
      .select()
      .from(paypalOperations)
      .where(and(eq(paypalOperations.worldId, worldId), eq(paypalOperations.kind, "order.get")));

    const result = await call(db, "confirm_checkout", key, { checkout_id: checkoutId });
    expect(result.envelope.status).toBe("CHECKOUT_FAILED");
    expect(result.envelope.reason_codes).toContain("amount_mismatch");

    const getOpsAfter = await db
      .select()
      .from(paypalOperations)
      .where(and(eq(paypalOperations.worldId, worldId), eq(paypalOperations.kind, "order.get")));
    // M3: no new order.get was made — the already-succeeded capture op
    // short-circuited straight to applying (and rejecting) the effect.
    expect(getOpsAfter).toHaveLength(getOpsBefore.length);

    const [noteTx] = await db
      .select()
      .from(noteTransactions)
      .where(and(eq(noteTransactions.worldId, worldId), eq(noteTransactions.kind, "buy")));
    expect(noteTx?.status).toBe("review");

    const tb = await trialBalance(db, worldId);
    expect(tb.totalCents).toBe(0n);
    const cash = tb.accounts.find((a) => a.code === "cash_paypal" && a.ownerRef === null);
    expect(cash?.balanceCents ?? 0n).toBe(0n); // nothing credited

    // Fix round 2 (item 1): confirming the same (now `review`) checkout
    // again must report the mismatch again — never COMPLETED — and still
    // credit nothing.
    const second = await call(db, "confirm_checkout", key, { checkout_id: checkoutId });
    expect(second.envelope.status).toBe("CHECKOUT_FAILED");
    expect(second.envelope.status).not.toBe("COMPLETED");
    expect(second.envelope.reason_codes).toContain("amount_mismatch");

    const [noteTxAfter] = await db
      .select()
      .from(noteTransactions)
      .where(and(eq(noteTransactions.worldId, worldId), eq(noteTransactions.kind, "buy")));
    expect(noteTxAfter?.status).toBe("review");

    const tbAfter = await trialBalance(db, worldId);
    expect(tbAfter.totalCents).toBe(0n);
    const cashAfter = tbAfter.accounts.find((a) => a.code === "cash_paypal" && a.ownerRef === null);
    expect(cashAfter?.balanceCents ?? 0n).toBe(0n); // still nothing credited
  });

  it("M3: confirming an already-completed checkout again makes no new order.get", async () => {
    const worldId = await createSimWorld(db);
    const { key } = await createTestAgent(db, worldId);

    const buyResult = await call(db, "buy_notes", key, { amount_cents: 3000 });
    const checkoutId = (buyResult.envelope.data as Record<string, unknown>).checkout_id as string;
    await simApprove(db, checkoutId);
    const first = await call(db, "confirm_checkout", key, { checkout_id: checkoutId });
    expect(first.envelope.status).toBe("COMPLETED");

    const getOpsBefore = await db
      .select()
      .from(paypalOperations)
      .where(and(eq(paypalOperations.worldId, worldId), eq(paypalOperations.kind, "order.get")));

    const second = await call(db, "confirm_checkout", key, { checkout_id: checkoutId });
    expect(second.envelope.status).toBe("COMPLETED");

    const getOpsAfter = await db
      .select()
      .from(paypalOperations)
      .where(and(eq(paypalOperations.worldId, worldId), eq(paypalOperations.kind, "order.get")));
    expect(getOpsAfter).toHaveLength(getOpsBefore.length);
  });
});

describe("Fix round 1: I4 fail-closed ownership", () => {
  let db: Db;

  beforeEach(async () => {
    process.env.API_KEY_PEPPER = "test-pepper";
    db = await createTestDb();
  });

  afterEach(() => {
    delete process.env.API_KEY_PEPPER;
  });

  it("confirm_checkout for another agent's checkout returns NOT_FOUND", async () => {
    const worldId = await createSimWorld(db);
    const agentA = await createTestAgent(db, worldId, "a@example.com");
    const agentB = await createTestAgent(db, worldId, "b@example.com");

    const buyResult = await call(db, "buy_notes", agentA.key, { amount_cents: 3000 });
    const checkoutId = (buyResult.envelope.data as Record<string, unknown>).checkout_id as string;

    const result = await call(db, "confirm_checkout", agentB.key, { checkout_id: checkoutId });
    expect(result.envelope.status).toBe("NOT_FOUND");
    expect(result.httpStatus).toBe(404);
  });
});

describe("Fix round 1: M1 missing payout receiver", () => {
  let db: Db;

  beforeEach(async () => {
    process.env.API_KEY_PEPPER = "test-pepper";
    db = await createTestDb();
  });

  afterEach(() => {
    delete process.env.API_KEY_PEPPER;
  });

  it("redeem_notes fails with PAYOUT_RECEIVER_MISSING when the agent has none on file", async () => {
    const worldId = await createSimWorld(db);
    const generated = generateApiKey();
    const [agent] = await db
      .insert(agents)
      .values({
        worldId,
        name: "No Receiver",
        operator: "test-operator",
        model: "test-model",
        codeManifestHash: "deadbeef",
        status: "active",
        payoutReceiver: null,
        payoutReceiverType: null,
      })
      .returning();
    await db.insert(apiKeys).values({
      worldId,
      agentId: agent!.id,
      prefix: generated.prefix,
      keyHash: generated.hash,
    });

    const buyResult = await call(db, "buy_notes", generated.key, { amount_cents: 2000 });
    const checkoutId = (buyResult.envelope.data as Record<string, unknown>).checkout_id as string;
    await simApprove(db, checkoutId);
    await call(db, "confirm_checkout", generated.key, { checkout_id: checkoutId });

    const redeem = await call(db, "redeem_notes", generated.key, { amount_cents: 2000 });
    expect(redeem.envelope.status).toBe("PAYOUT_RECEIVER_MISSING");
    expect(redeem.httpStatus).toBe(400);
  });
});

describe("Fix round 2: item 3 — credit only on capture status COMPLETED", () => {
  let db: Db;

  beforeEach(async () => {
    process.env.API_KEY_PEPPER = "test-pepper";
    db = await createTestDb();
  });

  afterEach(() => {
    delete process.env.API_KEY_PEPPER;
  });

  it("a succeeded capture operation with captureStatus PENDING leaves the checkout and note transaction pending", async () => {
    const worldId = await createSimWorld(db);
    const { key } = await createTestAgent(db, worldId);

    const buyResult = await call(db, "buy_notes", key, { amount_cents: 6000 });
    const checkoutId = (buyResult.envelope.data as Record<string, unknown>).checkout_id as string;
    await simApprove(db, checkoutId);

    // Pre-seed the deterministic capture operation as succeeded at the
    // HTTP level, but with PayPal's own capture object still PENDING
    // (e.g. an eCheck) — nothing should be credited yet.
    const captureOpId = deriveOperationId(worldId, "note_purchase_capture", checkoutId);
    await db.insert(paypalOperations).values({
      id: captureOpId,
      worldId,
      rail: "sim",
      kind: "order.capture",
      requestId: captureOpId,
      status: "succeeded",
      purpose: "note_purchase_capture",
      sourceId: checkoutId,
      paypalId: checkoutId,
      attempts: 1,
      response: {
        orderId: checkoutId,
        status: "COMPLETED",
        captureId: "CAP-PENDING",
        captureStatus: "PENDING",
        amountCents: "6000",
        recovered: false,
      },
    });

    const result = await call(db, "confirm_checkout", key, { checkout_id: checkoutId });
    expect(result.envelope.status).toBe("PENDING");
    expect(result.envelope.status).not.toBe("COMPLETED");

    const [noteTx] = await db
      .select()
      .from(noteTransactions)
      .where(and(eq(noteTransactions.worldId, worldId), eq(noteTransactions.kind, "buy")));
    expect(noteTx?.status).toBe("pending");

    const tb = await trialBalance(db, worldId);
    expect(tb.totalCents).toBe(0n);
    const cash = tb.accounts.find((a) => a.code === "cash_paypal" && a.ownerRef === null);
    expect(cash?.balanceCents ?? 0n).toBe(0n);
  });

  it("a succeeded capture operation with captureStatus DECLINED fails the checkout via applyFailure", async () => {
    const worldId = await createSimWorld(db);
    const { key } = await createTestAgent(db, worldId);

    const buyResult = await call(db, "buy_notes", key, { amount_cents: 6500 });
    const checkoutId = (buyResult.envelope.data as Record<string, unknown>).checkout_id as string;
    await simApprove(db, checkoutId);

    const captureOpId = deriveOperationId(worldId, "note_purchase_capture", checkoutId);
    await db.insert(paypalOperations).values({
      id: captureOpId,
      worldId,
      rail: "sim",
      kind: "order.capture",
      requestId: captureOpId,
      status: "succeeded",
      purpose: "note_purchase_capture",
      sourceId: checkoutId,
      paypalId: checkoutId,
      attempts: 1,
      response: {
        orderId: checkoutId,
        status: "VOIDED",
        captureId: "CAP-DECLINED",
        captureStatus: "DECLINED",
        amountCents: "6500",
        recovered: false,
      },
    });

    const result = await call(db, "confirm_checkout", key, { checkout_id: checkoutId });
    expect(result.envelope.status).toBe("CHECKOUT_FAILED");
    expect(result.httpStatus).toBe(400);
    expect(result.envelope.reason_codes).toContain("capture_declined");
    expect(result.envelope.next_actions).toEqual([{ tool: "buy_notes", args: { amount_cents: 6500 } }]);

    const [noteTx] = await db
      .select()
      .from(noteTransactions)
      .where(and(eq(noteTransactions.worldId, worldId), eq(noteTransactions.kind, "buy")));
    expect(noteTx?.status).toBe("failed");

    const tb = await trialBalance(db, worldId);
    expect(tb.totalCents).toBe(0n);
    const cash = tb.accounts.find((a) => a.code === "cash_paypal" && a.ownerRef === null);
    expect(cash?.balanceCents ?? 0n).toBe(0n);
  });
});

describe("Fix round 2: item 5 — terminally-failed order.get fails the checkout", () => {
  let db: Db;

  beforeEach(async () => {
    process.env.API_KEY_PEPPER = "test-pepper";
    db = await createTestDb();
  });

  afterEach(() => {
    delete process.env.API_KEY_PEPPER;
  });

  it("a 404 RESOURCE_NOT_FOUND on order.get fails the checkout instead of staying PENDING forever", async () => {
    const worldId = await createSimWorld(db);
    const { key } = await createTestAgent(db, worldId);

    const buyResult = await call(db, "buy_notes", key, { amount_cents: 3500 });
    const checkoutId = (buyResult.envelope.data as Record<string, unknown>).checkout_id as string;

    // Break the sim order's lookup so `order.get` 404s (RESOURCE_NOT_FOUND
    // is classified failed_terminal — see classify.ts): wipe the orderId
    // the sim handler matches on out of the create op's sim_state.
    const [createOp] = await db
      .select()
      .from(paypalOperations)
      .where(and(eq(paypalOperations.kind, "order.create"), eq(paypalOperations.paypalId, checkoutId)));
    expect(createOp).toBeTruthy();
    await db
      .update(paypalOperations)
      .set({ simState: { ...(createOp!.simState as object), orderId: "SIMORDER-gone" } })
      .where(eq(paypalOperations.id, createOp!.id));

    const result = await call(db, "confirm_checkout", key, { checkout_id: checkoutId });
    expect(result.envelope.status).toBe("CHECKOUT_FAILED");
    expect(result.httpStatus).toBe(400);
    expect(result.envelope.reason_codes).toContain("checkout_failed");
    expect(result.envelope.next_actions).toEqual([{ tool: "buy_notes", args: { amount_cents: 3500 } }]);

    const [noteTx] = await db
      .select()
      .from(noteTransactions)
      .where(and(eq(noteTransactions.worldId, worldId), eq(noteTransactions.kind, "buy")));
    expect(noteTx?.status).toBe("failed");
  });
});

describe("Fix round 1 (Task 6, Rulings Q/R): redemption payout status", () => {
  let db: Db;

  beforeEach(async () => {
    process.env.API_KEY_PEPPER = "test-pepper";
    db = await createTestDb();
  });

  afterEach(() => {
    delete process.env.API_KEY_PEPPER;
  });

  async function fundedLender(receiver: string, amountCents: number) {
    const worldId = await createSimWorld(db);
    const { key, agentId } = await createTestAgent(db, worldId, receiver);
    const buyResult = await call(db, "buy_notes", key, { amount_cents: amountCents });
    const checkoutId = (buyResult.envelope.data as Record<string, unknown>).checkout_id as string;
    await simApprove(db, checkoutId);
    await call(db, "confirm_checkout", key, { checkout_id: checkoutId });
    return { worldId, key, agentId };
  }

  it("UNCLAIMED → cancel → RETURNED: the redemption fails and the position is untouched", async () => {
    const { worldId, key } = await fundedLender("unclaimed-lender@example.com", 8000);

    const redeem = await call(db, "redeem_notes", key, { amount_cents: 8000 });
    expect(redeem.envelope.status).toBe("PENDING");

    const [redeemTx] = await db
      .select()
      .from(noteTransactions)
      .where(and(eq(noteTransactions.worldId, worldId), eq(noteTransactions.kind, "redeem")));
    expect(redeemTx?.status).toBe("failed");

    const cancels = await db
      .select()
      .from(paypalOperations)
      .where(and(eq(paypalOperations.worldId, worldId), eq(paypalOperations.kind, "payout.cancel_item")));
    expect(cancels.map((row) => row.status)).toEqual(["succeeded"]);

    const [position] = await db.select().from(notePositions).where(eq(notePositions.worldId, worldId));
    expect(position?.units).toBe(8000n);
    expect(await availableLiquidity(db, worldId)).toBe(8000n);
  });

  it("live-shaped send (no item) stays pending; pollPayoutStatus settles it", async () => {
    const { pollPayoutStatus } = await import("@/server/services/payoutPolling");
    const { worldId, key } = await fundedLender("pending-lender@example.com", 6000);

    await call(db, "redeem_notes", key, { amount_cents: 6000 });
    const [pending] = await db
      .select()
      .from(noteTransactions)
      .where(and(eq(noteTransactions.worldId, worldId), eq(noteTransactions.kind, "redeem")));
    expect(pending?.status).toBe("pending");
    expect(await availableLiquidity(db, worldId)).toBe(0n);

    await pollPayoutStatus(db, pending!.opId!);
    const [settled] = await db.select().from(noteTransactions).where(eq(noteTransactions.id, pending!.id));
    expect(settled?.status).toBe("completed");
    const [position] = await db.select().from(notePositions).where(eq(notePositions.worldId, worldId));
    expect(position?.units).toBe(0n);
  });

  it("an observed webhook FAILED fails a pending redemption", async () => {
    const { applyRedemptionPayoutOutcome } = await import("@/server/services/notes");
    const { worldId, key } = await fundedLender("pending-lender@example.com", 6000);
    await call(db, "redeem_notes", key, { amount_cents: 6000 });
    const [pending] = await db
      .select()
      .from(noteTransactions)
      .where(and(eq(noteTransactions.worldId, worldId), eq(noteTransactions.kind, "redeem")));

    await applyRedemptionPayoutOutcome(db, pending!.opId!, { itemStatus: "FAILED", source: "webhook" });
    const [failed] = await db.select().from(noteTransactions).where(eq(noteTransactions.id, pending!.id));
    expect(failed?.status).toBe("failed");
    const [position] = await db.select().from(notePositions).where(eq(notePositions.worldId, worldId));
    expect(position?.units).toBe(6000n);
  });
});
