import { beforeAll, describe, expect, it } from "vitest";

import { createTestDb } from "@/server/db/testing";
import { agents, worlds } from "@/server/db/schema";
import { scoped } from "@/server/db/scoped";
import type { Db } from "@/server/db/client";

describe("scoped: world isolation", () => {
  let db: Db;

  beforeAll(async () => {
    db = await createTestDb();
  });

  it("only returns rows belonging to the scoped world", async () => {
    const [worldA] = await db
      .insert(worlds)
      .values({ slug: "world-a", name: "World A", railMode: "sim" })
      .returning();
    const [worldB] = await db
      .insert(worlds)
      .values({ slug: "world-b", name: "World B", railMode: "sim" })
      .returning();

    if (!worldA || !worldB) {
      throw new Error("expected both worlds to be inserted");
    }

    await scoped(db, worldA.id).insert(agents, {
      name: "Agent A",
      operator: "operator-a",
      model: "model-a",
      codeManifestHash: "hash-a",
    });

    await scoped(db, worldB.id).insert(agents, {
      name: "Agent B",
      operator: "operator-b",
      model: "model-b",
      codeManifestHash: "hash-b",
    });

    const worldAAgents = await scoped(db, worldA.id).select(agents);
    const worldBAgents = await scoped(db, worldB.id).select(agents);

    expect(worldAAgents).toHaveLength(1);
    expect(worldAAgents[0]?.name).toBe("Agent A");
    expect(worldAAgents[0]?.worldId).toBe(worldA.id);

    expect(worldBAgents).toHaveLength(1);
    expect(worldBAgents[0]?.name).toBe("Agent B");
    expect(worldBAgents[0]?.worldId).toBe(worldB.id);
  });

  it("update only mutates rows within the scoped world", async () => {
    const [world] = await db
      .insert(worlds)
      .values({ slug: "world-c", name: "World C", railMode: "sim" })
      .returning();
    const [otherWorld] = await db
      .insert(worlds)
      .values({ slug: "world-d", name: "World D", railMode: "sim" })
      .returning();

    if (!world || !otherWorld) {
      throw new Error("expected both worlds to be inserted");
    }

    await scoped(db, world.id).insert(agents, {
      name: "Agent C",
      operator: "operator-c",
      model: "model-c",
      codeManifestHash: "hash-c",
    });
    await scoped(db, otherWorld.id).insert(agents, {
      name: "Agent D",
      operator: "operator-d",
      model: "model-d",
      codeManifestHash: "hash-d",
    });

    await scoped(db, world.id).update(agents, { status: "approved" });

    const worldAgents = await scoped(db, world.id).select(agents);
    const otherWorldAgents = await scoped(db, otherWorld.id).select(agents);

    expect(worldAgents[0]?.status).toBe("approved");
    expect(otherWorldAgents[0]?.status).toBe("pending");
  });
});
