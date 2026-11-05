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

  it("insert() ignores a cast-forced caller-supplied worldId", async () => {
    const [world] = await db
      .insert(worlds)
      .values({ slug: "world-e", name: "World E", railMode: "sim" })
      .returning();
    const [otherWorld] = await db
      .insert(worlds)
      .values({ slug: "world-f", name: "World F", railMode: "sim" })
      .returning();

    if (!world || !otherWorld) {
      throw new Error("expected both worlds to be inserted");
    }

    // The public type of `insert` omits `worldId`, so a caller can only
    // reach this path by casting around the types (e.g. a copy-pasted
    // `as any`). Even then, the scope's worldId must win at runtime.
    const [inserted] = await scoped(db, world.id).insert(agents, {
      worldId: otherWorld.id,
      name: "Agent E",
      operator: "operator-e",
      model: "model-e",
      codeManifestHash: "hash-e",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    expect(inserted?.worldId).toBe(world.id);

    const scopedToWorld = await scoped(db, world.id).select(agents);
    const scopedToOtherWorld = await scoped(db, otherWorld.id).select(agents);

    expect(scopedToWorld.some((agent) => agent.name === "Agent E")).toBe(
      true,
    );
    expect(
      scopedToOtherWorld.some((agent) => agent.name === "Agent E"),
    ).toBe(false);
  });

  it("update() ignores a cast-forced caller-supplied worldId", async () => {
    const [world] = await db
      .insert(worlds)
      .values({ slug: "world-g", name: "World G", railMode: "sim" })
      .returning();
    const [otherWorld] = await db
      .insert(worlds)
      .values({ slug: "world-h", name: "World H", railMode: "sim" })
      .returning();

    if (!world || !otherWorld) {
      throw new Error("expected both worlds to be inserted");
    }

    await scoped(db, world.id).insert(agents, {
      name: "Agent G",
      operator: "operator-g",
      model: "model-g",
      codeManifestHash: "hash-g",
    });
    await scoped(db, otherWorld.id).insert(agents, {
      name: "Agent H",
      operator: "operator-h",
      model: "model-h",
      codeManifestHash: "hash-h",
    });

    // Same cast-forced attempt, but against `update`'s `set`: it must
    // neither move the row to another world nor let it escape the
    // `where world_id = <scope>` filter.
    await scoped(db, world.id).update(agents, {
      status: "approved",
      worldId: otherWorld.id,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const worldAgents = await scoped(db, world.id).select(agents);
    const otherWorldAgents = await scoped(db, otherWorld.id).select(agents);

    expect(worldAgents.find((agent) => agent.name === "Agent G")?.status).toBe(
      "approved",
    );
    expect(
      worldAgents.find((agent) => agent.name === "Agent G")?.worldId,
    ).toBe(world.id);
    expect(
      otherWorldAgents.find((agent) => agent.name === "Agent H")?.status,
    ).toBe("pending");
  });
});
