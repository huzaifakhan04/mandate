import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import type { Db } from "@/server/db/client";
import { ledgerAccounts, worlds } from "@/server/db/schema";
import { createTestDb } from "@/server/db/testing";
import {
  ACCOUNT_CODES,
  ensureChartOfAccounts,
  getOrCreateAccount,
} from "@/server/ledger/accounts";

describe("ensureChartOfAccounts / getOrCreateAccount", () => {
  let db: Db;
  let worldId: string;

  beforeEach(async () => {
    db = await createTestDb();
    const [world] = await db
      .insert(worlds)
      .values({
        slug: `world-accounts-${Date.now()}-${Math.random()}`,
        name: "World Accounts",
        railMode: "sim",
      })
      .returning();
    if (!world) {
      throw new Error("expected world to be inserted");
    }
    worldId = world.id;
  });

  it("is idempotent across repeated calls: no duplicate top-level accounts", async () => {
    await ensureChartOfAccounts(db, worldId);
    await ensureChartOfAccounts(db, worldId);
    await ensureChartOfAccounts(db, worldId);

    const rows = await db
      .select()
      .from(ledgerAccounts)
      .where(eq(ledgerAccounts.worldId, worldId));

    expect(rows).toHaveLength(ACCOUNT_CODES.length);
    const codes = rows.map((r) => r.code).sort();
    expect(codes).toEqual([...ACCOUNT_CODES].sort());
  });

  it("creating the same owner-ref sub-account repeatedly yields exactly one row", async () => {
    await ensureChartOfAccounts(db, worldId);

    const first = await getOrCreateAccount(
      db,
      worldId,
      "notes_payable",
      "agentX",
    );
    const second = await getOrCreateAccount(
      db,
      worldId,
      "notes_payable",
      "agentX",
    );
    const third = await getOrCreateAccount(
      db,
      worldId,
      "notes_payable",
      "agentX",
    );

    expect(second.id).toBe(first.id);
    expect(third.id).toBe(first.id);

    const rows = await db
      .select()
      .from(ledgerAccounts)
      .where(
        and(
          eq(ledgerAccounts.worldId, worldId),
          eq(ledgerAccounts.code, "notes_payable"),
          eq(ledgerAccounts.ownerRef, "agentX"),
        ),
      );
    expect(rows).toHaveLength(1);
  });

  it("getOrCreateAccount falls through the ON CONFLICT DO NOTHING branch when the row already exists", async () => {
    // Pre-insert the row directly, bypassing getOrCreateAccount, to
    // simulate a concurrent writer that already won the race.
    const [preExisting] = await db
      .insert(ledgerAccounts)
      .values({
        worldId,
        code: "payable_to_borrower",
        type: "liability",
        ownerRef: "agentY",
      })
      .returning();
    if (!preExisting) {
      throw new Error("expected the pre-existing account to be inserted");
    }

    const found = await getOrCreateAccount(
      db,
      worldId,
      "payable_to_borrower",
      "agentY",
    );

    expect(found.id).toBe(preExisting.id);

    const rows = await db
      .select()
      .from(ledgerAccounts)
      .where(
        and(
          eq(ledgerAccounts.worldId, worldId),
          eq(ledgerAccounts.code, "payable_to_borrower"),
          eq(ledgerAccounts.ownerRef, "agentY"),
        ),
      );
    expect(rows).toHaveLength(1);
  });
});
