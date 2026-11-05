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
 * Test-only mutating tool exercising `ToolDef.finalize` (Ruling K):
 * `handler` returns a `PENDING` placeholder; `finalize` counts how many
 * times it ran (via the module-level counter below) and returns the
 * "real" envelope. Letting `finalize` fail on demand exercises the
 * failure path (runTool must not crash the whole call).
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
    input: z.object({ shouldFailFinalize: z.boolean().optional() }),
    output: z.object({}),
    handler: async () => ok({ pending: true }, { status: "PENDING", summary: "pending" }),
    finalize: async (envelope) => {
      finalizeRunCount += 1;
      const input = (envelope.data as { pending?: boolean }) ?? {};
      if (!input.pending) {
        return envelope;
      }
      return ok({ finalized: true, runCount: finalizeRunCount }, { status: "OK", summary: "finalized" });
    },
    ...overrides,
  };
}

describe("runTool: ToolDef.finalize", () => {
  beforeEach(() => {
    process.env.API_KEY_PEPPER = "test-pepper";
    finalizeRunCount = 0;
  });

  afterEach(() => {
    delete process.env.API_KEY_PEPPER;
  });

  it("runs finalize after the transaction commits and uses its envelope as the result", async () => {
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

  it("falls back to an INTERNAL_ERROR envelope if finalize throws, without crashing the call", async () => {
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
    });

    expect(result.envelope.status).toBe("INTERNAL_ERROR");
    expect(result.httpStatus).toBe(500);
  });
});
