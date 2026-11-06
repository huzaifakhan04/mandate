import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Db } from "@/server/db/client";
import { noteTransactions, paypalOperations } from "@/server/db/schema";
import { createTestDb } from "@/server/db/testing";
import { runReconcile } from "@/server/jobs/reconcile";

import { call, createSimWorld, createTestAgent, later, type Data } from "../jobs/fixtures";

/**
 * Task 10b fix round 3 (I1): a note purchase whose `order.create` ended
 * `failed_terminal` (e.g. given up on by the retry cap) can never get an
 * order — `confirm_checkout` fails the checkout (note tx `failed`,
 * CHECKOUT_FAILED with a `buy_notes` retry), and the reconcile cron fails
 * such pending buys too, instead of leaving them pending forever.
 */

async function buyWithTerminalCreate(db: Db, worldId: string, amountCents: number, name: string) {
  const lender = await createTestAgent(db, worldId, "lender@example.com", name);
  await call(db, "buy_notes", lender.key, { amount_cents: amountCents });
  const [buy] = (
    await db
      .select()
      .from(noteTransactions)
      .where(and(eq(noteTransactions.worldId, worldId), eq(noteTransactions.kind, "buy")))
  ).filter((row) => row.amountCents === BigInt(amountCents));
  expect(buy?.opId).toBeTruthy();
  // The create was given up on (Ruling V: order.create is the one capped kind).
  await db
    .update(paypalOperations)
    .set({
      status: "failed_terminal",
      paypalId: null,
      lastError: "retry_cap_exceeded",
      response: {
        error: { name: "INTERNAL_SERVER_ERROR", issue: "retry_cap_exceeded", message: null, debugId: null, details: null },
      },
    })
    .where(eq(paypalOperations.id, buy!.opId!));
  return { ...lender, noteTxId: buy!.id };
}

async function noteTxStatus(db: Db, id: string) {
  const [row] = await db.select().from(noteTransactions).where(eq(noteTransactions.id, id));
  return row?.status;
}

describe("note purchase whose order.create failed terminally", () => {
  let db: Db;

  beforeEach(async () => {
    process.env.API_KEY_PEPPER = "test-pepper";
    db = await createTestDb();
  });

  afterEach(() => {
    delete process.env.API_KEY_PEPPER;
  });

  it("confirm_checkout → CHECKOUT_FAILED with a buy_notes retry; the note tx is failed", async () => {
    const worldId = await createSimWorld(db);
    const buyer = await buyWithTerminalCreate(db, worldId, 2000, "Capped Buyer");

    const result = await call(db, "confirm_checkout", buyer.key, { checkout_id: buyer.noteTxId });

    expect(result.envelope.status).toBe("CHECKOUT_FAILED");
    expect(result.envelope.reason_codes).toContain("checkout_failed");
    expect(result.envelope.next_actions).toEqual([{ tool: "buy_notes", args: { amount_cents: 2000 } }]);
    expect(await noteTxStatus(db, buyer.noteTxId)).toBe("failed");
    expect((result.envelope.data as Data).checkout_id).toBe(buyer.noteTxId);
  });

  it("the reconcile cron fails a pending buy whose create is failed_terminal", async () => {
    const worldId = await createSimWorld(db);
    const buyer = await buyWithTerminalCreate(db, worldId, 3000, "Abandoned Buyer");

    await runReconcile(db, { now: later() });

    expect(await noteTxStatus(db, buyer.noteTxId)).toBe("failed");
  });
});
