import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { generateApiKey } from "@/server/auth/apiKeys";
import { ok } from "@/server/contracts/envelope";
import type { ToolCtx, ToolDef } from "@/server/contracts/registry";
import { runTool } from "@/server/contracts/runTool";
import type { Db } from "@/server/db/client";
import { agents, apiKeys } from "@/server/db/schema";
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

function makeAfterCommitTool(
  register: (ctx: ToolCtx) => void,
  overrides: Partial<ToolDef> = {},
): ToolDef {
  return {
    name: "after_commit_tool",
    title: "After Commit Tool",
    description: "Test-only mutating tool used to exercise ctx.afterCommit ordering/skip semantics.",
    auth: "agent",
    mutating: true,
    readOnly: false,
    input: z.object({ shouldThrow: z.boolean().optional() }),
    output: z.object({}),
    handler: async (input, ctx) => {
      register(ctx);
      if (input.shouldThrow) {
        throw new Error("boom");
      }
      return ok({}, { status: "OK", summary: "ok" });
    },
    ...overrides,
  };
}

describe("runTool: ctx.afterCommit", () => {
  beforeEach(() => {
    process.env.API_KEY_PEPPER = "test-pepper";
  });

  afterEach(() => {
    delete process.env.API_KEY_PEPPER;
  });

  it("runs every registered callback, in registration order, after the transaction commits", async () => {
    const db = await createTestDb();
    const { key } = await createTestAgent(db);
    const order: string[] = [];

    const tool = makeAfterCommitTool((ctx) => {
      ctx.afterCommit(() => {
        order.push("first");
      });
      ctx.afterCommit(() => {
        order.push("second");
      });
    });

    const result = await runTool(tool, tool.name, {}, { getDb: async () => db, authorization: `Bearer ${key}` });

    expect(result.httpStatus).toBe(200);
    expect(order).toEqual(["first", "second"]);
  });

  it("does not run afterCommit callbacks when the transaction rolls back", async () => {
    const db = await createTestDb();
    const { key } = await createTestAgent(db);
    let ran = false;

    const tool = makeAfterCommitTool((ctx) => {
      ctx.afterCommit(() => {
        ran = true;
      });
    });

    const result = await runTool(tool, tool.name, { shouldThrow: true }, {
      getDb: async () => db,
      authorization: `Bearer ${key}`,
    });

    expect(result.httpStatus).toBe(500);
    expect(ran).toBe(false);
  });

  it("does not run afterCommit callbacks on an idempotent replay", async () => {
    const db = await createTestDb();
    const { key } = await createTestAgent(db);
    let runs = 0;

    const tool = makeAfterCommitTool((ctx) => {
      ctx.afterCommit(() => {
        runs += 1;
      });
    });

    await runTool(tool, tool.name, {}, {
      getDb: async () => db,
      authorization: `Bearer ${key}`,
      idempotencyKey: "idem-after-commit",
    });
    await runTool(tool, tool.name, {}, {
      getDb: async () => db,
      authorization: `Bearer ${key}`,
      idempotencyKey: "idem-after-commit",
    });

    // The handler (and so the afterCommit registration) only ran once —
    // the second call was a replay.
    expect(runs).toBe(1);
  });

  it("an afterCommit callback that throws is logged and leaves the envelope intact", async () => {
    const db = await createTestDb();
    const { key } = await createTestAgent(db);
    let secondRan = false;

    const tool = makeAfterCommitTool((ctx) => {
      ctx.afterCommit(() => {
        throw new Error("afterCommit boom");
      });
      ctx.afterCommit(() => {
        secondRan = true;
      });
    });

    const result = await runTool(tool, tool.name, {}, { getDb: async () => db, authorization: `Bearer ${key}` });

    expect(result.httpStatus).toBe(200);
    expect(result.envelope.status).toBe("OK");
    // A throwing callback doesn't stop later callbacks from running either.
    expect(secondRan).toBe(true);
  });

  it("ctx.tx === ctx.db for readOnly tools (no transaction is opened)", async () => {
    const db = await createTestDb();
    let sameReference = false;

    const readOnlyTool: ToolDef = {
      name: "read_only_identity_tool",
      title: "Read Only Identity Tool",
      description: "Test-only readOnly tool asserting ctx.tx === ctx.db, for runTool afterCommit tests.",
      auth: "none",
      mutating: false,
      readOnly: true,
      input: z.object({}),
      output: z.object({}),
      handler: async (_input, ctx) => {
        sameReference = ctx.tx === ctx.db;
        return ok({}, { status: "OK", summary: "ok" });
      },
    };

    const result = await runTool(readOnlyTool, readOnlyTool.name, {}, { getDb: async () => db });

    expect(result.httpStatus).toBe(200);
    expect(sameReference).toBe(true);
  });
});
