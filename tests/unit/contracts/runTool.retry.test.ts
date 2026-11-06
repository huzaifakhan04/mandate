import { randomUUID } from "crypto";

import { eq } from "drizzle-orm";
import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { generateApiKey } from "@/server/auth/apiKeys";
import { ok } from "@/server/contracts/envelope";
import type { ToolDef } from "@/server/contracts/registry";
import { runTool } from "@/server/contracts/runTool";
import type { Db } from "@/server/db/client";
import { describeError, isRetryableTransactionError, safeErrorMessage } from "@/server/db/errors";
import { agents, apiKeys, events, idempotencyKeys } from "@/server/db/schema";
import { createTestDb } from "@/server/db/testing";
import { ensureMainWorld } from "@/server/services/worlds";

/** A Postgres-driver-shaped error (SQLSTATE on `.code`), wrapped the way Drizzle wraps a failed query. */
function drizzleQueryError(code: string, message: string): Error {
  const cause = Object.assign(new Error(message), { name: "error", code });
  const wrapper = new Error(`Failed query: select * from api_keys where key_hash = $1\nparams: secret-hash-value`);
  wrapper.name = "DrizzleQueryError";
  (wrapper as Error & { cause: unknown }).cause = cause;
  return wrapper;
}

async function createTestAgent(db: Db) {
  const { worldId } = await ensureMainWorld(db);
  const [agent] = await db
    .insert(agents)
    .values({ worldId, name: "A", operator: "o", model: "m", codeManifestHash: "h", status: "active" })
    .returning();
  const generated = generateApiKey();
  await db.insert(apiKeys).values({ worldId, agentId: agent!.id, prefix: generated.prefix, keyHash: generated.hash });
  return { worldId, key: generated.key };
}

/** Mutating test tool: writes an event, registers an afterCommit, then throws `failures` times before succeeding. */
function flakyTool(failures: Error[], afterCommitRuns: string[]): ToolDef & { runs: () => number } {
  let runs = 0;
  return {
    name: "flaky_tool",
    title: "Flaky Tool",
    description: "Test-only mutating tool that fails with injected errors.",
    auth: "agent",
    mutating: true,
    readOnly: false,
    input: z.object({}),
    output: z.object({}),
    handler: async (_input, ctx) => {
      runs += 1;
      const attempt = runs;
      await ctx.tx.insert(events).values({
        worldId: ctx.worldId,
        type: "test.event",
        aggregateType: "test",
        aggregateId: randomUUID(),
        occurredSimAt: ctx.simNow,
      });
      ctx.afterCommit(() => {
        afterCommitRuns.push(`attempt-${attempt}`);
      });
      const failure = failures.shift();
      if (failure) {
        throw failure;
      }
      return ok({ attempt }, { status: "OK", summary: "done" });
    },
    runs: () => runs,
  };
}

describe("M8: runTool retries a deadlocked/serialization-failed transaction once", () => {
  let db: Db;
  let worldId: string;
  let key: string;

  beforeEach(async () => {
    process.env.API_KEY_PEPPER = "test-pepper";
    db = await createTestDb();
    ({ worldId, key } = await createTestAgent(db));
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    delete process.env.API_KEY_PEPPER;
    vi.restoreAllMocks();
  });

  const countEvents = async () => (await db.select().from(events).where(eq(events.worldId, worldId))).length;

  for (const code of ["40P01", "40001"]) {
    it(`${code} on the first attempt → a fresh transaction succeeds; only its effects and callbacks survive`, async () => {
      const callbacks: string[] = [];
      const tool = flakyTool([drizzleQueryError(code, "deadlock detected")], callbacks);
      const result = await runTool(tool, tool.name, {}, {
        getDb: async () => db,
        authorization: `Bearer ${key}`,
        idempotencyKey: `retry-${code}`,
      });

      expect(result.envelope.status).toBe("OK");
      expect(result.envelope.data).toEqual({ attempt: 2 });
      expect(tool.runs()).toBe(2);
      expect(await countEvents()).toBe(1); // the first attempt rolled back
      expect(callbacks).toEqual(["attempt-2"]);
      const rows = await db.select().from(idempotencyKeys).where(eq(idempotencyKeys.worldId, worldId));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.httpStatus).toBe(200);
    });
  }

  it("retries without an idempotency key too", async () => {
    const tool = flakyTool([drizzleQueryError("40P01", "deadlock detected")], []);
    const result = await runTool(tool, tool.name, {}, { getDb: async () => db, authorization: `Bearer ${key}` });
    expect(result.envelope.status).toBe("OK");
    expect(tool.runs()).toBe(2);
  });

  it("a second retryable failure → INTERNAL_ERROR (exactly one retry)", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const tool = flakyTool(
      [drizzleQueryError("40P01", "deadlock detected"), drizzleQueryError("40P01", "deadlock detected")],
      [],
    );
    const result = await runTool(tool, tool.name, {}, { getDb: async () => db, authorization: `Bearer ${key}` });
    expect(result.httpStatus).toBe(500);
    expect(result.envelope.status).toBe("INTERNAL_ERROR");
    expect(tool.runs()).toBe(2);
    expect(await countEvents()).toBe(0);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("a non-retryable error is not retried", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const tool = flakyTool([drizzleQueryError("23505", "duplicate key value violates unique constraint")], []);
    const result = await runTool(tool, tool.name, {}, { getDb: async () => db, authorization: `Bearer ${key}` });
    expect(result.envelope.status).toBe("INTERNAL_ERROR");
    expect(tool.runs()).toBe(1);
  });
});

describe("M12: runTool logs name/code/message only — never query text or params", () => {
  afterEach(() => {
    delete process.env.API_KEY_PEPPER;
    vi.restoreAllMocks();
  });

  it("an INTERNAL_ERROR log line carries the SQLSTATE and driver message but not the query or params", async () => {
    process.env.API_KEY_PEPPER = "test-pepper";
    const db = await createTestDb();
    const { key } = await createTestAgent(db);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const tool = flakyTool([drizzleQueryError("23505", "duplicate key value violates unique constraint")], []);

    await runTool(tool, tool.name, {}, { getDb: async () => db, authorization: `Bearer ${key}`, requestId: "req-1" });

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const logged = errorSpy.mock.calls[0]!.map(String).join(" ");
    expect(logged).toContain("req-1");
    expect(logged).toContain("23505");
    expect(logged).toContain("duplicate key value violates unique constraint");
    expect(logged).not.toContain("secret-hash-value");
    expect(logged).not.toContain("select * from");
    expect(errorSpy.mock.calls[0]).toHaveLength(1); // a string, not the raw error object
  });

  it("helpers", () => {
    const err = drizzleQueryError("40P01", "deadlock detected");
    expect(isRetryableTransactionError(err)).toBe(true);
    expect(isRetryableTransactionError(new Error("x"))).toBe(false);
    expect(describeError(err)).toBe("error (40P01): deadlock detected");
    expect(safeErrorMessage(new Error("Failed query: select 1\nparams: a"))).toBe(
      "Failed query (query text and parameters omitted)",
    );
    expect(safeErrorMessage("plain")).toBe("plain");
  });
});
