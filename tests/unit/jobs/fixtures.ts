import { and, eq, like } from "drizzle-orm";
import { expect } from "vitest";

import { generateApiKey } from "@/server/auth/apiKeys";
import "@/server/contracts/tools";
import { findTool } from "@/server/contracts/registry";
import { runTool } from "@/server/contracts/runTool";
import type { Db } from "@/server/db/client";
import { agents, apiKeys, journalEntries, loans, repaymentLinks } from "@/server/db/schema";
import { simApprove } from "@/server/rail/simHandler";
import { createWorld } from "@/server/services/worlds";
import { claimAndMandate } from "../../helpers/kya";
import { withAlaDefaults } from "../../helpers/world";

/**
 * Shared Task 8 fixtures (sim rail): worlds, agents, a funded pool, and
 * loans with or without an invoice link. Mirrors the helpers in
 * tests/unit/services/{loans,repayments}.test.ts.
 */

export type Data = Record<string, unknown>;

export async function createSimWorld(db: Db, name = "Jobs World"): Promise<string> {
  const { worldId } = await createWorld(db, { name, ownerPrincipalId: null, railMode: "sim" });
  return worldId;
}

export async function createTestAgent(
  db: Db,
  worldId: string,
  payoutReceiver: string | null,
  name = "Test Agent",
): Promise<{ agentId: string; key: string }> {
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
      payoutReceiverType: payoutReceiver ? "email" : null,
    })
    .returning();
  const generated = generateApiKey();
  await db.insert(apiKeys).values({ worldId, agentId: agent!.id, prefix: generated.prefix, keyHash: generated.hash });
  // P2: borrowing needs KYA tier 1 (claimed + signed mandate).
  await claimAndMandate(db, agent!.id);
  return { agentId: agent!.id, key: generated.key };
}

export async function call(db: Db, toolName: string, key: string, input: Record<string, unknown>) {
  return runTool(findTool(toolName), toolName, withAlaDefaults(toolName, input), { getDb: async () => db, authorization: `Bearer ${key}` });
}

/** A lender buys `amountCents` of notes and confirms it (the pool is funded). */
export async function fundPool(db: Db, worldId: string, amountCents: number, receiver = "lender@example.com") {
  const lender = await createTestAgent(db, worldId, receiver, "Lender");
  const buy = await call(db, "buy_notes", lender.key, { amount_cents: amountCents });
  const checkoutId = (buy.envelope.data as Data).checkout_id as string;
  await simApprove(db, checkoutId);
  const confirmed = await call(db, "confirm_checkout", lender.key, { checkout_id: checkoutId });
  expect(confirmed.envelope.status).toBe("COMPLETED");
  return lender;
}

/** A note purchase left pending (the lender approved nothing yet); returns its order id. */
export async function pendingNoteBuy(db: Db, worldId: string, amountCents: number, name = "Pending Lender") {
  const lender = await createTestAgent(db, worldId, "lender@example.com", name);
  const buy = await call(db, "buy_notes", lender.key, { amount_cents: amountCents });
  expect(buy.envelope.status).toBe("AWAITING_APPROVAL");
  return { ...lender, orderId: (buy.envelope.data as Data).checkout_id as string };
}

export const INVOICE = {
  client_email: "client@example.com",
  amount_cents: 40000,
  due_in_days: 14,
  description: "Website build",
};

/**
 * Borrower takes 25000 for 14 days (P3 pricing v2, grade A: fee 270 with the
 * 40000 invoice, 333 without), with or without the 40000 invoice. A receiver containing "pending" leaves the loan DISBURSING
 * (live-shaped payout: no item in the send response).
 */
export async function borrow(
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
  const loanId = (accepted.envelope.data as Data).loan_id as string;
  const [loan] = await db.select().from(loans).where(eq(loans.id, loanId));
  return { ...borrower, loanId, sendOpId: loan!.disbursementOpId!, accepted };
}

export async function getLoan(db: Db, loanId: string) {
  const [loan] = await db.select().from(loans).where(eq(loans.id, loanId));
  return loan!;
}

export async function invoiceLink(db: Db, loanId: string) {
  const [link] = await db
    .select()
    .from(repaymentLinks)
    .where(and(eq(repaymentLinks.loanId, loanId), eq(repaymentLinks.kind, "invoice")));
  return link;
}

/** Journal entries in `worldId` whose idempotency key starts with `prefix`. */
export async function journalsWithKeyPrefix(db: Db, worldId: string, prefix: string) {
  return db
    .select()
    .from(journalEntries)
    .where(and(eq(journalEntries.worldId, worldId), like(journalEntries.idempotencyKey, `${prefix}%`)));
}

/** A time safely past the 30-second "leave fresh checkouts alone" window. */
export function later(ms = 31_000): Date {
  return new Date(Date.now() + ms);
}
