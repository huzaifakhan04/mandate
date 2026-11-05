import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ok } from "@/server/contracts/envelope";
import type { ToolDef } from "@/server/contracts/registry";
import { runTool } from "@/server/contracts/runTool";
import { createTestDb } from "@/server/db/testing";

function makeTool(overrides: Partial<ToolDef> = {}): ToolDef {
  return {
    name: "echo_tool",
    title: "Echo Tool",
    description: "A test-only tool that echoes its input back for runTool unit tests.",
    auth: "none",
    mutating: false,
    input: z.object({ value: z.string().optional() }),
    output: z.object({ value: z.string().optional() }),
    handler: async (input) => ok(input, { status: "OK", summary: "echoed" }),
    ...overrides,
  };
}

describe("runTool", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
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

  it("passes agentId through to the handler's ctx", async () => {
    let seenAgentId: string | null = null;
    const tool = makeTool({
      handler: async (_input, ctx) => {
        seenAgentId = ctx.agentId;
        return ok({}, { status: "OK", summary: "ok" });
      },
    });

    await runTool(tool, "echo_tool", {}, { getDb: createTestDb, agentId: "agent-1" });

    expect(seenAgentId).toBe("agent-1");
  });
});
