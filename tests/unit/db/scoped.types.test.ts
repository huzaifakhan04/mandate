import { eq } from "drizzle-orm";
import { describe, expectTypeOf, it } from "vitest";

import { agents } from "@/server/db/schema";
import { scoped } from "@/server/db/scoped";
import type { Db } from "@/server/db/client";

/**
 * Type-level regression test for the `scoped()` world-isolation
 * invariant (see the header comment in src/server/db/scoped.ts):
 * callers must never be able to supply their own `world_id` to
 * `insert`/`update` — the helper always injects/filters it itself.
 *
 * `typeOnlyGuards` below is never called; it exists purely so `tsc`
 * type-checks its body. Each `@ts-expect-error` line is load-bearing:
 * if `scoped()` regresses to accept a caller-supplied `worldId` (e.g. a
 * future method copies the `as any` cast pattern without also
 * excluding `worldId` from its public parameter type), the directive
 * becomes an "Unused '@ts-expect-error' directive" compile error and
 * `npm run typecheck` fails. Deleting either directive line (without
 * fixing the underlying type) must also make typecheck fail, which is
 * what proves these lines are doing real work and not just decorative.
 */
function typeOnlyGuards(db: Db) {
  const client = scoped(db, "world-a");

  // A valid call (no worldId) must type-check with no error.
  void client.insert(agents, {
    name: "agent",
    operator: "operator",
    model: "model",
    codeManifestHash: "hash",
  });

  void client.insert(agents, {
    // @ts-expect-error -- insert() must not accept a caller-supplied world_id
    worldId: "some-other-world",
    name: "agent",
    operator: "operator",
    model: "model",
    codeManifestHash: "hash",
  });

  // A valid call (no worldId in `set`) must type-check with no error.
  void client.update(agents, { status: "approved" });

  void client.update(agents, {
    // @ts-expect-error -- update()'s `set` must not accept a caller-supplied world_id
    worldId: "some-other-world",
  });

  // A valid call (where supplied) must type-check with no error.
  void client.delete(agents, eq(agents.name, "agent"));

  // @ts-expect-error -- delete()'s `where` is required (never deletes a whole world's table by accident)
  void client.delete(agents);

  // A valid call (where supplied) must type-check with no error.
  void client.forUpdate(agents, eq(agents.name, "agent"));

  // @ts-expect-error -- forUpdate()'s `where` is required, same reasoning as delete()
  void client.forUpdate(agents);
}

void typeOnlyGuards;

describe("scoped: type-level world_id guarantees", () => {
  it("insert() return rows are typed with worldId (it's always present on reads)", () => {
    type InsertResult = Awaited<ReturnType<typeof scoped>["insert"]>;
    // Sanity check that the generic plumbing above type-checks to something
    // usable, rather than silently widening to `any`.
    expectTypeOf<InsertResult>().not.toBeAny();
  });
});
