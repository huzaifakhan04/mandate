import { randomUUID } from "crypto";

import { eq } from "drizzle-orm";
import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { generateApiKey } from "@/server/auth/apiKeys";
import { ok } from "@/server/contracts/envelope";
import type { ToolDef } from "@/server/contracts/registry";
import { runTool } from "@/server/contracts/runTool";
import type { Db } from "@/server/db/client";
import { agents, apiKeys, events, idempotencyKeys } from "@/server/db/schema";
import { createTestDb } from "@/server/db/testing";
import { ensureMainWorld } from "@/server/services/worlds";

async function createTestAgent(db: Db) {
  const { worldId } = await ensureMainWorld(db);
  const [agent] = await db
    .insert(agents)
    .values({
      worldId,
      name: "Test Agent",
      operator: "test-operator",
      model: "test-model",
      codeManifestHash: "deadbeef",
      status: "active",
    })
    .returning();

  const generated = generateApiKey();
  await db.insert(apiKeys).values({
    worldId,
    agentId: agent!.id,
    prefix: generated.prefix,
    keyHash: generated.hash,
  });

  return { worldId, agentId: agent!.id, key: generated.key };
}

/**
 * Test-only mutating tool: inserts one `events` row per invocation, and
 * optionally throws right after the insert (to exercise the
 * transaction-rollback path).
 */
const insertEventTool: ToolDef = {
  name: "insert_event_tool",
  title: "Insert Event Tool",
  description: "Test-only mutating tool that inserts an events row, for runTool idempotency tests.",
  auth: "agent",
  mutating: true,
  readOnly: false,
  input: z.object({
    note: z.string().optional(),
    shouldThrow: z.boolean().optional(),
    amountCents: z.bigint().optional(),
  }),
  output: z.object({}),
  handler: async (input, ctx) => {
    await ctx.tx.insert(events).values({
      worldId: ctx.worldId,
      type: "test.event",
      aggregateType: "test",
      aggregateId: randomUUID(),
      occurredSimAt: ctx.simNow,
    });

    if (input.shouldThrow) {
      throw new Error("boom after insert");
    }

    return ok({}, { status: "OK", summary: "inserted" });
  },
};

/**
 * Test-only mutating tool with `auth: 'none'` (like Task 4's
 * `register_agent`): no agent, so idempotency must be ignored entirely for
 * it, while still running the handler inside a transaction.
 */
const insertEventNoAuthTool: ToolDef = {
  ...insertEventTool,
  name: "insert_event_no_auth_tool",
  auth: "none",
};

async function countEvents(db: Db, worldId: string): Promise<number> {
  const rows = await db.select().from(events).where(eq(events.worldId, worldId));
  return rows.length;
}

async function countIdempotencyRows(db: Db, worldId: string): Promise<number> {
  const rows = await db.select().from(idempotencyKeys).where(eq(idempotencyKeys.worldId, worldId));
  return rows.length;
}

describe("runTool idempotency + per-call transaction", () => {
  beforeEach(() => {
    process.env.API_KEY_PEPPER = "test-pepper";
  });

  afterEach(() => {
    delete process.env.API_KEY_PEPPER;
  });

  it("a second call with the same key returns the same envelope and still writes only 1 row", async () => {
    const db = await createTestDb();
    const { worldId, key } = await createTestAgent(db);

    const first = await runTool(insertEventTool, insertEventTool.name, { note: "a" }, {
      getDb: async () => db,
      authorization: `Bearer ${key}`,
      idempotencyKey: "idem-1",
    });
    const second = await runTool(insertEventTool, insertEventTool.name, { note: "a" }, {
      getDb: async () => db,
      authorization: `Bearer ${key}`,
      idempotencyKey: "idem-1",
    });

    expect(first.httpStatus).toBe(200);
    expect(second.httpStatus).toBe(200);
    expect(second.envelope).toEqual(first.envelope);
    expect(await countEvents(db, worldId)).toBe(1);
  });

  it("the same key with different input returns 409 IDEMPOTENCY_CONFLICT", async () => {
    const db = await createTestDb();
    const { worldId, key } = await createTestAgent(db);

    const first = await runTool(insertEventTool, insertEventTool.name, { note: "a" }, {
      getDb: async () => db,
      authorization: `Bearer ${key}`,
      idempotencyKey: "idem-2",
    });
    const second = await runTool(insertEventTool, insertEventTool.name, { note: "b" }, {
      getDb: async () => db,
      authorization: `Bearer ${key}`,
      idempotencyKey: "idem-2",
    });

    expect(first.httpStatus).toBe(200);
    expect(second.httpStatus).toBe(409);
    expect(second.envelope.status).toBe("IDEMPOTENCY_CONFLICT");
    expect(await countEvents(db, worldId)).toBe(1);
  });

  it("no idempotency key: two calls run twice and write 2 rows, with nothing stored", async () => {
    const db = await createTestDb();
    const { worldId, key } = await createTestAgent(db);

    await runTool(insertEventTool, insertEventTool.name, {}, {
      getDb: async () => db,
      authorization: `Bearer ${key}`,
    });
    await runTool(insertEventTool, insertEventTool.name, {}, {
      getDb: async () => db,
      authorization: `Bearer ${key}`,
    });

    expect(await countEvents(db, worldId)).toBe(2);
    expect(await countIdempotencyRows(db, worldId)).toBe(0);
  });

  it("a handler that throws after inserting rolls back: 0 rows, no idempotency row stored", async () => {
    const db = await createTestDb();
    const { worldId, key } = await createTestAgent(db);

    const result = await runTool(insertEventTool, insertEventTool.name, { shouldThrow: true }, {
      getDb: async () => db,
      authorization: `Bearer ${key}`,
      idempotencyKey: "idem-3",
    });

    expect(result.httpStatus).toBe(500);
    expect(await countEvents(db, worldId)).toBe(0);
    expect(await countIdempotencyRows(db, worldId)).toBe(0);
  });

  it("accepts the idempotency key from the idempotency_key arg as well as the header", async () => {
    const db = await createTestDb();
    const { worldId, key } = await createTestAgent(db);

    const first = await runTool(
      insertEventTool,
      insertEventTool.name,
      { note: "a", idempotency_key: "idem-4" },
      { getDb: async () => db, authorization: `Bearer ${key}` },
    );
    const second = await runTool(
      insertEventTool,
      insertEventTool.name,
      { note: "a", idempotency_key: "idem-4" },
      { getDb: async () => db, authorization: `Bearer ${key}` },
    );

    expect(first.httpStatus).toBe(200);
    expect(second.envelope).toEqual(first.envelope);
    expect(await countEvents(db, worldId)).toBe(1);
  });

  it("hashes a bigint field in the input without throwing, and still detects a conflict", async () => {
    const db = await createTestDb();
    const { worldId, key } = await createTestAgent(db);

    const first = await runTool(insertEventTool, insertEventTool.name, { amountCents: 500n }, {
      getDb: async () => db,
      authorization: `Bearer ${key}`,
      idempotencyKey: "idem-bigint",
    });
    const replay = await runTool(insertEventTool, insertEventTool.name, { amountCents: 500n }, {
      getDb: async () => db,
      authorization: `Bearer ${key}`,
      idempotencyKey: "idem-bigint",
    });
    const conflict = await runTool(insertEventTool, insertEventTool.name, { amountCents: 600n }, {
      getDb: async () => db,
      authorization: `Bearer ${key}`,
      idempotencyKey: "idem-bigint",
    });

    expect(first.httpStatus).toBe(200);
    expect(replay.envelope).toEqual(first.envelope);
    expect(conflict.httpStatus).toBe(409);
    expect(await countEvents(db, worldId)).toBe(1);
  });

  it("header and idempotency_key arg disagreeing returns 400 INVALID_REQUEST idempotency_key_mismatch", async () => {
    const db = await createTestDb();
    const { key } = await createTestAgent(db);

    const result = await runTool(
      insertEventTool,
      insertEventTool.name,
      { note: "a", idempotency_key: "from-arg" },
      { getDb: async () => db, authorization: `Bearer ${key}`, idempotencyKey: "from-header" },
    );

    expect(result.httpStatus).toBe(400);
    expect(result.envelope.status).toBe("INVALID_REQUEST");
    expect(result.envelope.reason_codes).toContain("idempotency_key_mismatch");
  });

  it("a mutating tool with an inactive agent returns 403 AGENT_NOT_ACTIVE", async () => {
    const db = await createTestDb();
    const { worldId, key } = await createTestAgent(db);
    await db.update(agents).set({ status: "suspended" }).where(eq(agents.worldId, worldId));

    const result = await runTool(insertEventTool, insertEventTool.name, {}, {
      getDb: async () => db,
      authorization: `Bearer ${key}`,
    });

    expect(result.httpStatus).toBe(403);
    expect(result.envelope.status).toBe("AGENT_NOT_ACTIVE");
    expect(result.envelope.reason_codes).toContain("agent_not_active");
    expect(await countEvents(db, worldId)).toBe(0);
  });

  it("auth: 'none' mutating tool: idempotency is ignored entirely, key or no key", async () => {
    const db = await createTestDb();
    const { worldId } = await ensureMainWorld(db);

    const first = await runTool(insertEventNoAuthTool, insertEventNoAuthTool.name, { note: "a" }, {
      getDb: async () => db,
      idempotencyKey: "idem-noauth",
    });
    const second = await runTool(insertEventNoAuthTool, insertEventNoAuthTool.name, { note: "a" }, {
      getDb: async () => db,
      idempotencyKey: "idem-noauth",
    });

    expect(first.httpStatus).toBe(200);
    expect(second.httpStatus).toBe(200);
    // Not a replay: the handler ran twice (no agent to attribute a stored
    // idempotency row to), so two events rows were written.
    expect(await countEvents(db, worldId)).toBe(2);
    expect(await countIdempotencyRows(db, worldId)).toBe(0);
  });

  it("auth: 'none' mutating tool still runs inside a transaction (throw rolls back)", async () => {
    const db = await createTestDb();
    const { worldId } = await ensureMainWorld(db);

    const result = await runTool(
      insertEventNoAuthTool,
      insertEventNoAuthTool.name,
      { shouldThrow: true },
      { getDb: async () => db },
    );

    expect(result.httpStatus).toBe(500);
    expect(await countEvents(db, worldId)).toBe(0);
  });

  it("concurrent calls sharing a fresh idempotency key never 500 and only run the handler once", async () => {
    const db = await createTestDb();
    const { worldId, key } = await createTestAgent(db);

    const [first, second] = await Promise.all([
      runTool(insertEventTool, insertEventTool.name, { note: "concurrent" }, {
        getDb: async () => db,
        authorization: `Bearer ${key}`,
        idempotencyKey: "idem-concurrent",
      }),
      runTool(insertEventTool, insertEventTool.name, { note: "concurrent" }, {
        getDb: async () => db,
        authorization: `Bearer ${key}`,
        idempotencyKey: "idem-concurrent",
      }),
    ]);

    for (const result of [first, second]) {
      expect(result.httpStatus).not.toBe(500);
      expect(["OK", "IDEMPOTENCY_CONFLICT", "IDEMPOTENCY_IN_PROGRESS"]).toContain(result.envelope.status);
    }
    // Same input on both calls, so a 409 here (if any) must be a transient
    // IN_PROGRESS read, never a hash CONFLICT.
    expect([first.envelope.status, second.envelope.status]).not.toContain("IDEMPOTENCY_CONFLICT");
    expect(await countEvents(db, worldId)).toBe(1);
    expect(await countIdempotencyRows(db, worldId)).toBe(1);
  });
});
