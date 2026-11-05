import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import type { Db } from "@/server/db/client";
import { ledgerAccounts, worlds } from "@/server/db/schema";
import { createTestDb } from "@/server/db/testing";

/**
 * Proves that `ledger_accounts_world_code_owner_idx` is a NULLS NOT
 * DISTINCT constraint in the actual migrated database (drizzle/0001_*),
 * not just in the TypeScript schema. Without NULLS NOT DISTINCT,
 * Postgres treats every NULL `owner_ref` as distinct from every other,
 * so a second top-level (owner_ref = NULL) account for the same
 * `(world_id, code)` would insert successfully instead of conflicting —
 * this test would then fail, catching a regression to the old plain
 * `uniqueIndex`.
 */
describe("ledger_accounts: NULLS NOT DISTINCT unique constraint", () => {
  it("rejects a second (world_id, code, NULL owner_ref) row with a unique violation", async () => {
    const db: Db = await createTestDb();
    const [world] = await db
      .insert(worlds)
      .values({
        slug: `world-unique-${Date.now()}-${Math.random()}`,
        name: "World Unique",
        railMode: "sim",
      })
      .returning();
    if (!world) {
      throw new Error("expected world to be inserted");
    }

    await db.insert(ledgerAccounts).values({
      worldId: world.id,
      code: "cash_paypal",
      type: "asset",
      ownerRef: null,
    });

    // Drizzle wraps the driver's error in a `DrizzleQueryError`; the
    // Postgres `code` (23505 = unique_violation) is on `.cause`, not on
    // the wrapper itself.
    await expect(
      db.insert(ledgerAccounts).values({
        worldId: world.id,
        code: "cash_paypal",
        type: "asset",
        ownerRef: null,
      }),
    ).rejects.toMatchObject({ cause: { code: "23505" } });
  });

  it("still allows the same (world_id, code) with different non-null owner_refs", async () => {
    const db: Db = await createTestDb();
    const [world] = await db
      .insert(worlds)
      .values({
        slug: `world-unique-owned-${Date.now()}-${Math.random()}`,
        name: "World Unique Owned",
        railMode: "sim",
      })
      .returning();
    if (!world) {
      throw new Error("expected world to be inserted");
    }

    await db.insert(ledgerAccounts).values({
      worldId: world.id,
      code: "notes_payable",
      type: "liability",
      ownerRef: "agentA",
    });
    await db.insert(ledgerAccounts).values({
      worldId: world.id,
      code: "notes_payable",
      type: "liability",
      ownerRef: "agentB",
    });

    const rows = await db
      .select()
      .from(ledgerAccounts)
      .where(eq(ledgerAccounts.worldId, world.id));

    expect(rows).toHaveLength(2);
  });
});
