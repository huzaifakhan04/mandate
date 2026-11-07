import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { generateApiKey } from "@/server/auth/apiKeys";
import { ok } from "@/server/contracts/envelope";
import type { ToolDef } from "@/server/contracts/registry";
import { runTool } from "@/server/contracts/runTool";
import type { Db } from "@/server/db/client";
import { agents, apiKeys } from "@/server/db/schema";
import { createTestDb } from "@/server/db/testing";
import { ensureMainWorld } from "@/server/services/worlds";

function makeTool(overrides: Partial<ToolDef> = {}): ToolDef {
  return {
    name: "echo_tool",
    title: "Echo Tool",
    description: "A test-only tool that echoes its input back for runTool unit tests.",
    auth: "none",
    mutating: false,
    readOnly: true,
    input: z.object({ value: z.string().optional() }),
    output: z.object({ value: z.string().optional() }),
    handler: async (input) => ok(input, { status: "OK", summary: "echoed" }),
    ...overrides,
  };
}

/** Creates an agent + API key in `db`, returning the full key and its ids. */
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

describe("runTool", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.API_KEY_PEPPER = "test-pepper";
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    delete process.env.API_KEY_PEPPER;
  });

  it("runs the handler and returns 200 for valid input", async () => {
    const tool = makeTool();
    const result = await runTool(tool, "echo_tool", { value: "hi" }, { getDb: createTestDb });

    expect(result.httpStatus).toBe(200);
    expect(result.envelope.status).toBe("OK");
    expect(result.envelope.data).toEqual({ value: "hi" });
  });

  it("returns 404 NOT_FOUND for an unregistered tool, without calling getDb", async () => {
    const getDb = vi.fn(createTestDb);
    const result = await runTool(undefined, "nope", {}, { getDb });

    expect(result.httpStatus).toBe(404);
    expect(result.envelope.status).toBe("NOT_FOUND");
    expect(getDb).not.toHaveBeenCalled();
  });

  it("returns 400 INVALID_REQUEST with reason_codes for input that fails validation", async () => {
    const tool = makeTool();
    const result = await runTool(tool, "echo_tool", { value: 42 }, { getDb: createTestDb });

    expect(result.httpStatus).toBe(400);
    expect(result.envelope.status).toBe("INVALID_REQUEST");
    expect(result.envelope.reason_codes.length).toBeGreaterThan(0);
  });

  it("returns 500 INTERNAL_ERROR with no stack/message leak when the handler throws", async () => {
    const secretError = new Error("password=super-secret connection refused at 10.0.0.5");
    const tool = makeTool({
      handler: async () => {
        throw secretError;
      },
    });

    const result = await runTool(tool, "echo_tool", {}, { getDb: createTestDb, requestId: "req-123" });

    expect(result.httpStatus).toBe(500);
    expect(result.envelope.status).toBe("INTERNAL_ERROR");
    expect(JSON.stringify(result.envelope)).not.toContain("super-secret");
    expect(JSON.stringify(result.envelope)).not.toContain("10.0.0.5");
    expect(result.envelope.summary).toContain("req-123");
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it("returns 500 INTERNAL_ERROR with no stack/message leak when getDb throws", async () => {
    const tool = makeTool();
    const getDb = vi.fn(async () => {
      throw new Error("ECONNREFUSED 10.1.2.3:5432");
    });

    const result = await runTool(tool, "echo_tool", {}, { getDb, requestId: "req-456" });

    expect(result.httpStatus).toBe(500);
    expect(result.envelope.status).toBe("INTERNAL_ERROR");
    expect(JSON.stringify(result.envelope)).not.toContain("ECONNREFUSED");
    expect(JSON.stringify(result.envelope)).not.toContain("10.1.2.3");
    expect(result.envelope.summary).toContain("req-456");
  });

  it("resolves ctx.agent/ctx.agentId from a valid Authorization header", async () => {
    const db = await createTestDb();
    const { agentId, worldId, key } = await createTestAgent(db);

    let seenAgentId: string | null = null;
    let seenAgent: unknown = null;
    const tool = makeTool({
      auth: "agent",
      handler: async (_input, ctx) => {
        seenAgentId = ctx.agentId;
        seenAgent = ctx.agent;
        return ok({}, { status: "OK", summary: "ok" });
      },
    });

    await runTool(tool, "echo_tool", {}, { getDb: async () => db, authorization: `Bearer ${key}` });

    expect(seenAgentId).toBe(agentId);
    expect(seenAgent).toEqual({ agentId, worldId, status: "active", scope: "full" });
  });

  it("returns 401 UNAUTHORIZED with missing_api_key when auth: 'agent' has no Authorization header", async () => {
    const tool = makeTool({ auth: "agent" });

    const result = await runTool(tool, "echo_tool", {}, { getDb: createTestDb });

    expect(result.httpStatus).toBe(401);
    expect(result.envelope.status).toBe("UNAUTHORIZED");
    expect(result.envelope.reason_codes).toContain("missing_api_key");
  });

  it("returns 401 UNAUTHORIZED with invalid_api_key for a wrong key", async () => {
    const db = await createTestDb();
    await createTestAgent(db);
    const tool = makeTool({ auth: "agent" });

    const result = await runTool(tool, "echo_tool", {}, {
      getDb: async () => db,
      authorization: "Bearer mnd_aaaaaaaa_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });

    expect(result.httpStatus).toBe(401);
    expect(result.envelope.status).toBe("UNAUTHORIZED");
    expect(result.envelope.reason_codes).toContain("invalid_api_key");
  });
});
