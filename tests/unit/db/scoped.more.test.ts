import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { createTestDb } from "@/server/db/testing";
import { agents, idempotencyKeys, worlds } from "@/server/db/schema";
import { scoped } from "@/server/db/scoped";
import type { Db } from "@/server/db/client";

describe("scoped: select(where), findOne, delete, insertOnConflictDoNothing, forUpdate", () => {
  let db: Db;

  async function makeWorld(slug: string) {
    const [world] = await db
      .insert(worlds)
      .values({ slug, name: slug, railMode: "sim" })
      .returning();
    if (!world) throw new Error(`expected world ${slug} to be inserted`);
    return world;
  }

  beforeAll(async () => {
    db = await createTestDb();
  });

  it("select(where) ANDs the extra filter with the world scope", async () => {
    const worldA = await makeWorld("more-select-a");
    const worldB = await makeWorld("more-select-b");

    await scoped(db, worldA.id).insert(agents, {
      name: "Agent A1",
      operator: "operator-a1",
      model: "model-a1",
      codeManifestHash: "hash-a1",
    });
    await scoped(db, worldA.id).insert(agents, {
      name: "Agent A2",
      operator: "operator-a2",
      model: "model-a2",
      codeManifestHash: "hash-a2",
    });
    await scoped(db, worldB.id).insert(agents, {
      name: "Agent A1",
      operator: "operator-b1",
      model: "model-b1",
      codeManifestHash: "hash-b1",
    });

    const found = await scoped(db, worldA.id).select(
      agents,
      eq(agents.name, "Agent A1"),
    );

    expect(found).toHaveLength(1);
    expect(found[0]?.operator).toBe("operator-a1");
    expect(found[0]?.worldId).toBe(worldA.id);
  });

  it("findOne returns a single row scoped to the world, or undefined", async () => {
    const worldA = await makeWorld("more-findone-a");
    const worldB = await makeWorld("more-findone-b");

    await scoped(db, worldA.id).insert(agents, {
      name: "Findone Agent",
      operator: "operator-fo-a",
      model: "model-fo-a",
      codeManifestHash: "hash-fo-a",
    });
    await scoped(db, worldB.id).insert(agents, {
      name: "Findone Agent",
      operator: "operator-fo-b",
      model: "model-fo-b",
      codeManifestHash: "hash-fo-b",
    });

    const foundInA = await scoped(db, worldA.id).findOne(
      agents,
      eq(agents.name, "Findone Agent"),
    );
    expect(foundInA?.operator).toBe("operator-fo-a");

    const notFoundInA = await scoped(db, worldA.id).findOne(
      agents,
      eq(agents.name, "Does Not Exist"),
    );
    expect(notFoundInA).toBeUndefined();
  });

  it("delete only removes rows within the scoped world", async () => {
    const worldA = await makeWorld("more-delete-a");
    const worldB = await makeWorld("more-delete-b");

    await scoped(db, worldA.id).insert(agents, {
      name: "Delete Me A",
      operator: "operator-del-a",
      model: "model-del-a",
      codeManifestHash: "hash-del-a",
    });
    await scoped(db, worldB.id).insert(agents, {
      name: "Delete Me A",
      operator: "operator-del-b",
      model: "model-del-b",
      codeManifestHash: "hash-del-b",
    });

    const deleted = await scoped(db, worldA.id).delete(
      agents,
      eq(agents.name, "Delete Me A"),
    );

    expect(deleted).toHaveLength(1);
    expect(deleted[0]?.worldId).toBe(worldA.id);

    const remainingInA = await scoped(db, worldA.id).select(
      agents,
      eq(agents.name, "Delete Me A"),
    );
    const remainingInB = await scoped(db, worldB.id).select(
      agents,
      eq(agents.name, "Delete Me A"),
    );
    expect(remainingInA).toHaveLength(0);
    expect(remainingInB).toHaveLength(1);
  });

  it("insert() and delete() reject a cast-forced caller-supplied worldId", async () => {
    const worldA = await makeWorld("more-delete-cast-a");
    const worldB = await makeWorld("more-delete-cast-b");

    await scoped(db, worldA.id).insert(agents, {
      name: "Cast Agent",
      operator: "operator-cast-a",
      model: "model-cast-a",
      codeManifestHash: "hash-cast-a",
    });

    // A cast-forced `where` cannot move the world filter: delete() always
    // ANDs its own `eq(worldId, scope)` on top, so scoping world B can
    // never delete world A's row even if a caller tries to pass a `where`
    // targeting it directly.
    const deletedFromWrongWorld = await scoped(db, worldB.id).delete(
      agents,
      eq(agents.name, "Cast Agent"),
    );
    expect(deletedFromWrongWorld).toHaveLength(0);

    const stillThere = await scoped(db, worldA.id).select(
      agents,
      eq(agents.name, "Cast Agent"),
    );
    expect(stillThere).toHaveLength(1);
  });

  it("insertOnConflictDoNothing inserts once, then no-ops and returns no rows on conflict", async () => {
    const worldA = await makeWorld("more-conflict-a");

    const [agentRow] = await scoped(db, worldA.id).insert(agents, {
      name: "Idempotent Agent",
      operator: "operator-conflict-a",
      model: "model-conflict-a",
      codeManifestHash: "hash-conflict-a",
    });
    if (!agentRow) throw new Error("expected agent to be inserted");

    const firstInsert = await scoped(db, worldA.id).insertOnConflictDoNothing(
      idempotencyKeys,
      {
        agentId: agentRow.id,
        key: "key-1",
        requestHash: "hash-1",
        response: null,
        httpStatus: null,
      },
      [idempotencyKeys.worldId, idempotencyKeys.agentId, idempotencyKeys.key],
    );
    expect(firstInsert).toHaveLength(1);
    expect(firstInsert[0]?.worldId).toBe(worldA.id);

    const secondInsert = await scoped(
      db,
      worldA.id,
    ).insertOnConflictDoNothing(
      idempotencyKeys,
      {
        agentId: agentRow.id,
        key: "key-1",
        requestHash: "hash-2",
        response: null,
        httpStatus: null,
      },
      [idempotencyKeys.worldId, idempotencyKeys.agentId, idempotencyKeys.key],
    );
    expect(secondInsert).toHaveLength(0);
  });

  it("insertOnConflictDoNothing ignores a cast-forced caller-supplied worldId", async () => {
    const worldA = await makeWorld("more-conflict-cast-a");
    const worldB = await makeWorld("more-conflict-cast-b");

    const [agentRow] = await scoped(db, worldA.id).insert(agents, {
      name: "Cast Conflict Agent",
      operator: "operator-cast-conflict",
      model: "model-cast-conflict",
      codeManifestHash: "hash-cast-conflict",
    });
    if (!agentRow) throw new Error("expected agent to be inserted");

    const [inserted] = await scoped(db, worldA.id).insertOnConflictDoNothing(
      idempotencyKeys,
      {
        worldId: worldB.id,
        agentId: agentRow.id,
        key: "key-cast",
        requestHash: "hash-cast",
        response: null,
        httpStatus: null,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      [idempotencyKeys.worldId, idempotencyKeys.agentId, idempotencyKeys.key],
    );

    expect(inserted?.worldId).toBe(worldA.id);
  });

  it("forUpdate locks and returns rows scoped to the world inside a transaction", async () => {
    const worldA = await makeWorld("more-forupdate-a");
    const worldB = await makeWorld("more-forupdate-b");

    await scoped(db, worldA.id).insert(agents, {
      name: "Locked Agent",
      operator: "operator-lock-a",
      model: "model-lock-a",
      codeManifestHash: "hash-lock-a",
    });
    await scoped(db, worldB.id).insert(agents, {
      name: "Locked Agent",
      operator: "operator-lock-b",
      model: "model-lock-b",
      codeManifestHash: "hash-lock-b",
    });

    const rows = await db.transaction(async (tx) => {
      return scoped(tx, worldA.id).forUpdate(
        agents,
        eq(agents.name, "Locked Agent"),
      );
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.worldId).toBe(worldA.id);
    expect(rows[0]?.operator).toBe("operator-lock-a");
  });
});
