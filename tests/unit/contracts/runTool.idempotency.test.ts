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
  input: z.object({ note: z.string().optional(), shouldThrow: z.boolean().optional() }),
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
});
