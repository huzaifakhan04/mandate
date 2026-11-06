/** P2 Task 3: the reconcile cron prunes signature nonces older than the 10-minute replay window. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Db } from "@/server/db/client";
import { agentSignatureNonces } from "@/server/db/schema";
import { createTestDb } from "@/server/db/testing";
import { runReconcile } from "@/server/jobs/reconcile";

import { createSimWorld, createTestAgent } from "../../helpers/world";

describe("signature nonce retention", () => {
  let db: Db;

  beforeEach(async () => {
    vi.stubEnv("API_KEY_PEPPER", "test-pepper");
    db = await createTestDb();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("runReconcile deletes nonces seen more than 10 minutes ago and keeps newer ones", async () => {
    const worldId = await createSimWorld(db);
    const { agentId } = await createTestAgent(db, worldId);
    const now = new Date("2026-11-06T12:00:00Z");
    await db.insert(agentSignatureNonces).values([
      { worldId, agentId, signature: "old", seenAt: new Date(now.getTime() - 10 * 60_000 - 1000) },
      { worldId, agentId, signature: "edge", seenAt: new Date(now.getTime() - 10 * 60_000 + 1000) },
      { worldId, agentId, signature: "new", seenAt: now },
    ]);

    const report = await runReconcile(db, { now });

    const left = await db.select().from(agentSignatureNonces);
    expect(left.map((n) => n.signature).sort()).toEqual(["edge", "new"]);
    expect(report.noncesPruned).toBe(1);
  });
});
