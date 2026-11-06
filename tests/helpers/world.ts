/**
 * Shared test helpers: a sim-rail world, agents with API keys, tool calls
 * through runTool, and a funded note pool. Used by unit and real-Postgres
 * suites alike.
 */
import { expect } from "vitest";

import { generateApiKey } from "@/server/auth/apiKeys";
import "@/server/contracts/tools";
import { findTool } from "@/server/contracts/registry";
import { runTool } from "@/server/contracts/runTool";
import type { Db } from "@/server/db/client";
import { agents, apiKeys } from "@/server/db/schema";
import { simApprove } from "@/server/rail/simHandler";
import { createWorld } from "@/server/services/worlds";
import { claimAndMandate, type TestKyaOptions } from "./kya";

export type Data = Record<string, unknown>;

export async function createSimWorld(db: Db): Promise<string> {
  const { worldId } = await createWorld(db, { name: "PG World", ownerPrincipalId: null, railMode: "sim" });
  return worldId;
}

export async function createTestAgent(
  db: Db,
  worldId: string,
  payoutReceiver = "agent@example.com",
  kya: TestKyaOptions = {},
) {
  const [agent] = await db
    .insert(agents)
    .values({
      worldId,
      name: "PG Agent",
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
  // P2: borrowing needs KYA tier 1 (claimed + signed mandate).
  const { principalId, mandateId } = await claimAndMandate(db, agent!.id, kya);
  return { agentId: agent!.id, key: generated.key, principalId, mandateId };
}

export async function call(
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

/** A lender buys `amountCents` of notes on the sim rail and confirms; returns the lender. */
export async function fundPool(db: Db, worldId: string, amountCents: number, receiver = "lender@example.com") {
  const lender = await createTestAgent(db, worldId, receiver);
  const buy = await call(db, "buy_notes", lender.key, { amount_cents: amountCents });
  const checkoutId = (buy.envelope.data as Data).checkout_id as string;
  await simApprove(db, checkoutId);
  const confirmed = await call(db, "confirm_checkout", lender.key, { checkout_id: checkoutId });
  expect(confirmed.envelope.status).toBe("COMPLETED");
  return lender;
}
