import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { generateApiKey } from "@/server/auth/apiKeys";
import { ok } from "@/server/contracts/envelope";
import type { ToolDef } from "@/server/contracts/registry";
import { runTool } from "@/server/contracts/runTool";
import type { Db } from "@/server/db/client";
import { agents, apiKeys, idempotencyKeys } from "@/server/db/schema";
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
 * Test-only mutating tool exercising `ToolDef.finalize` (Ruling K) and
 * `ctx.setFinalizeState` (Fix round 1, I2b): `handler` returns a clean
 * `PENDING` fallback envelope (no internal fields) and separately stashes
 * bookkeeping via `setFinalizeState`; `finalize` reads that state, counts
 * how many times it ran (via the module-level counter below), and
 * returns the "real" envelope. Letting `finalize` fail on demand
 * exercises the failure path (Fix round 1, I2c: fall back to handler's
 * envelope, don't crash, don't touch the stored row).
 */
let finalizeRunCount = 0;

function makeFinalizeTool(overrides: Partial<ToolDef> = {}): ToolDef {
  return {
    name: "finalize_tool",
    title: "Finalize Tool",
    description: "Test-only mutating tool exercising ToolDef.finalize.",
    auth: "agent",
    mutating: true,
    readOnly: false,
    input: z.object({}),
    output: z.object({}),
    handler: async (_input, ctx) => {
      ctx.setFinalizeState({ pending: true });
      return ok({ fallback: true }, { status: "PENDING", summary: "pending" });
    },
    finalize: async (_envelope, _ctx, state) => {
      finalizeRunCount += 1;
      if (!(state as { pending?: boolean } | undefined)?.pending) {
        return _envelope;
      }
      return ok({ finalized: true, runCount: finalizeRunCount }, { status: "OK", summary: "finalized" });
    },
    ...overrides,
  };
}

describe("runTool: ToolDef.finalize / ctx.setFinalizeState", () => {
  beforeEach(() => {
    process.env.API_KEY_PEPPER = "test-pepper";
    finalizeRunCount = 0;
  });

  afterEach(() => {
    delete process.env.API_KEY_PEPPER;
  });

  it("runs finalize after the transaction commits, with handler's setFinalizeState value, and uses its envelope as the result", async () => {
    const db = await createTestDb();
    const { key } = await createTestAgent(db);

    const result = await runTool(makeFinalizeTool(), "finalize_tool", {}, {
      getDb: async () => db,
      authorization: `Bearer ${key}`,
    });

    expect(result.envelope.status).toBe("OK");
    expect((result.envelope.data as Record<string, unknown>).finalized).toBe(true);
    expect(finalizeRunCount).toBe(1);
  });

  it("finalize's state is undefined when handler never calls setFinalizeState", async () => {
    const db = await createTestDb();
    const { key } = await createTestAgent(db);

    const tool = makeFinalizeTool({
      handler: async () => ok({ fallback: true }, { status: "PENDING", summary: "pending" }),
    });

    const result = await runTool(tool, "finalize_tool", {}, {
      getDb: async () => db,
      authorization: `Bearer ${key}`,
    });

    // finalize's own logic treats a falsy/missing `pending` as "nothing
    // to finalize" and returns the envelope unchanged.
    expect(result.envelope.status).toBe("PENDING");
    expect((result.envelope.data as Record<string, unknown>).fallback).toBe(true);
  });

  it("stores the finalized envelope (not the handler's) under an idempotency key, and replays it verbatim without re-running finalize", async () => {
    const db = await createTestDb();
    const { worldId, agentId, key } = await createTestAgent(db);

    const first = await runTool(makeFinalizeTool(), "finalize_tool", {}, {
      getDb: async () => db,
      authorization: `Bearer ${key}`,
      idempotencyKey: "idem-1",
    });
    expect(first.envelope.status).toBe("OK");
    expect(finalizeRunCount).toBe(1);

    const [stored] = await db
      .select()
      .from(idempotencyKeys)
      .where(eq(idempotencyKeys.key, "idem-1"));
    expect(stored?.response).toMatchObject({ status: "OK", data: { finalized: true } });
    expect(stored?.httpStatus).toBe(200);

    const second = await runTool(makeFinalizeTool(), "finalize_tool", {}, {
      getDb: async () => db,
      authorization: `Bearer ${key}`,
      idempotencyKey: "idem-1",
    });

    // Replay: identical finalized envelope, and finalize did NOT run again.
    expect(second.envelope).toEqual(first.envelope);
    expect(finalizeRunCount).toBe(1);
    expect(agentId).toBeTruthy();
    expect(worldId).toBeTruthy();
  });

  it("Fix round 1 (I2c): falls back to handler's own envelope if finalize throws, without crashing the call or touching the stored row", async () => {
    const db = await createTestDb();
    const { key } = await createTestAgent(db);

    const throwingTool = makeFinalizeTool({
      finalize: async () => {
        throw new Error("boom in finalize");
      },
    });

    const result = await runTool(throwingTool, "finalize_tool", {}, {
      getDb: async () => db,
      authorization: `Bearer ${key}`,
      idempotencyKey: "idem-throw",
    });

    // Not INTERNAL_ERROR: the pre-finalize (handler's) envelope, which is
    // itself a safe, usable fallback.
    expect(result.envelope.status).toBe("PENDING");
    expect((result.envelope.data as Record<string, unknown>).fallback).toBe(true);
    expect(result.httpStatus).toBe(200);

    const [stored] = await db
      .select()
      .from(idempotencyKeys)
      .where(eq(idempotencyKeys.key, "idem-throw"));
    // The stored row holds exactly what the handler's own transaction
    // wrote — finalize's throw never touched it.
    expect(stored?.response).toMatchObject({ status: "PENDING", data: { fallback: true } });
  });

  it("Ruling L: idempotent: false ignores an Idempotency-Key entirely — handler (and finalize) run on every call", async () => {
    const db = await createTestDb();
    const { key } = await createTestAgent(db);

    const nonIdempotentTool = makeFinalizeTool({ idempotent: false });

    const first = await runTool(nonIdempotentTool, "finalize_tool", {}, {
      getDb: async () => db,
      authorization: `Bearer ${key}`,
      idempotencyKey: "idem-non-idempotent",
    });
    const second = await runTool(nonIdempotentTool, "finalize_tool", {}, {
      getDb: async () => db,
      authorization: `Bearer ${key}`,
      idempotencyKey: "idem-non-idempotent",
    });

    expect(first.envelope.status).toBe("OK");
    expect(second.envelope.status).toBe("OK");
    // finalize ran twice (once per call) — not replayed from storage.
    expect(finalizeRunCount).toBe(2);
    expect((first.envelope.data as Record<string, unknown>).runCount).toBe(1);
    expect((second.envelope.data as Record<string, unknown>).runCount).toBe(2);

    const stored = await db
      .select()
      .from(idempotencyKeys)
      .where(eq(idempotencyKeys.key, "idem-non-idempotent"));
    expect(stored).toHaveLength(0);
  });
});
