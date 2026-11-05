import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { generateApiKey, verifyApiKey } from "@/server/auth/apiKeys";
import { agents, apiKeys } from "@/server/db/schema";
import { createTestDb } from "@/server/db/testing";
import { ensureMainWorld } from "@/server/services/worlds";
import { eq } from "drizzle-orm";

async function createAgentWithKey(db: Awaited<ReturnType<typeof createTestDb>>) {
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

  return { worldId, agentId: agent!.id, key: generated.key, prefix: generated.prefix };
}

describe("apiKeys", () => {
  beforeEach(() => {
    process.env.API_KEY_PEPPER = "test-pepper";
  });

  afterEach(() => {
    delete process.env.API_KEY_PEPPER;
  });

  it("generates keys matching the mnd_<prefix8>_<secret32> base32 format", () => {
    const { key } = generateApiKey();
    expect(key).toMatch(/^mnd_[a-z2-7]{8}_[a-z2-7]{32}$/);
  });

  it("verify succeeds for the right key", async () => {
    const db = await createTestDb();
    const { worldId, agentId, key } = await createAgentWithKey(db);

    const result = await verifyApiKey(db, key);

    expect(result).not.toBeNull();
    expect(result?.agentId).toBe(agentId);
    expect(result?.worldId).toBe(worldId);
  });

  it("stamps last_used_at on a successful verify", async () => {
    const db = await createTestDb();
    const { key, prefix } = await createAgentWithKey(db);

    await verifyApiKey(db, key);

    const [row] = await db.select().from(apiKeys).where(eq(apiKeys.prefix, prefix)).limit(1);
    expect(row?.lastUsedAt).not.toBeNull();
  });

  it("verify fails for a tampered secret", async () => {
    const db = await createTestDb();
    const { key, prefix } = await createAgentWithKey(db);

    const tampered = `${key.slice(0, -1)}${key.at(-1) === "a" ? "b" : "a"}`;
    const result = await verifyApiKey(db, tampered);

    expect(result).toBeNull();
    const [row] = await db.select().from(apiKeys).where(eq(apiKeys.prefix, prefix)).limit(1);
    expect(row?.lastUsedAt).toBeNull();
  });

  it("verify fails for an unknown prefix", async () => {
    const db = await createTestDb();
    await createAgentWithKey(db);

    const result = await verifyApiKey(db, "mnd_zzzzzzzz_zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz");

    expect(result).toBeNull();
  });

  it("verify fails for a revoked key", async () => {
    const db = await createTestDb();
    const { key, prefix } = await createAgentWithKey(db);

    await db.update(apiKeys).set({ revokedAt: new Date() }).where(eq(apiKeys.prefix, prefix));

    const result = await verifyApiKey(db, key);

    expect(result).toBeNull();
  });

  it("verify fails for a malformed key", async () => {
    const db = await createTestDb();

    const result = await verifyApiKey(db, "not-a-valid-key");

    expect(result).toBeNull();
  });
});
