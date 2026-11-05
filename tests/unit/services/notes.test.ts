import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { generateApiKey } from "@/server/auth/apiKeys";
import "@/server/contracts/tools";
import { findTool } from "@/server/contracts/registry";
import { runTool } from "@/server/contracts/runTool";
import type { Db } from "@/server/db/client";
import { agents, apiKeys, notePositions } from "@/server/db/schema";
import { createTestDb } from "@/server/db/testing";
import { availableLiquidity } from "@/server/domain/liquidity";
import { trialBalance } from "@/server/ledger/trialBalance";
import { simApprove } from "@/server/rail/simHandler";
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
  });
});
