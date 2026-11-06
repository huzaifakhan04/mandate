import { sql } from "drizzle-orm";
import { expect } from "vitest";

import { generateApiKey } from "@/server/auth/apiKeys";
import "@/server/contracts/tools";
import { findTool } from "@/server/contracts/registry";
import { runTool } from "@/server/contracts/runTool";
import type { Db } from "@/server/db/client";
import { agents, apiKeys } from "@/server/db/schema";
import { simApprove } from "@/server/rail/simHandler";
import { createWorld } from "@/server/services/worlds";

export type Data = Record<string, unknown>;

export async function createSimWorld(db: Db): Promise<string> {
  const { worldId } = await createWorld(db, { name: "PG World", ownerPrincipalId: null, railMode: "sim" });
  return worldId;
}

export async function createTestAgent(db: Db, worldId: string, payoutReceiver = "agent@example.com") {
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
  return { agentId: agent!.id, key: generated.key };
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

export interface Gate {
  promise: Promise<void>;
  open: () => void;
}

export function gate(): Gate {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/**
 * Opens a transaction on its own pool connection that runs `lockSql`
 * (e.g. `SELECT … FOR UPDATE`) and then holds it until `release()` — so
 * the calls under test pile up behind the same row lock and are released
 * together, i.e. they genuinely overlap instead of running back to back.
 */
export async function holdLock(db: Db, lockSql: ReturnType<typeof sql>) {
  const locked = gate();
  const released = gate();
  const done = db.transaction(async (tx) => {
    await tx.execute(lockSql);
    locked.open();
    await released.promise;
  });
  await locked.promise;
  return {
    release: async () => {
      released.open();
      await done;
    },
  };
}

/** Number of backends in this database currently blocked on a heavyweight lock. */
export async function lockWaiters(db: Db): Promise<number> {
  const result = await db.execute(
    sql`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`,
  );
  return (result.rows[0] as { n: number }).n;
}

/** Polls until at least `n` backends wait on a lock (or fails after `timeoutMs`). */
export async function waitForLockWaiters(db: Db, n: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const waiting = await lockWaiters(db);
    if (waiting >= n) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`expected ${n} lock waiters, saw ${waiting}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
