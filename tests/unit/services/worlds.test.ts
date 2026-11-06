import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Db } from "@/server/db/client";
import { clock, journalEntries, worlds } from "@/server/db/schema";
import { createTestDb } from "@/server/db/testing";
import { availableLiquidity } from "@/server/domain/liquidity";
import { getAccountBalance, trialBalance } from "@/server/ledger/trialBalance";
import { bankSeedCapitalCents, createWorld, ensureMainWorld } from "@/server/services/worlds";

/**
 * Ruling W: every world opens with the bank's own capital — Dr
 * `cash_paypal` / Cr `bank_equity`, `BANK_SEED_CAPITAL_CENTS` (default
 * 10000), once, keyed `bank_capital:seed:<worldId>` — so PayPal's fees (the
 * bank's expense) don't leave the pool owing holders more than it holds.
 */

async function seedEntries(db: Db, worldId: string) {
  return db
    .select()
    .from(journalEntries)
    .where(and(eq(journalEntries.worldId, worldId), eq(journalEntries.idempotencyKey, `bank_capital:seed:${worldId}`)));
}

describe("bank seed capital (Ruling W)", () => {
  let db: Db;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(() => {
    delete process.env.BANK_SEED_CAPITAL_CENTS;
  });

  it("createWorld seeds 10000 by default: cash and liquidity include it, balanced against bank_equity", async () => {
    const { worldId } = await createWorld(db, { name: "Seeded", ownerPrincipalId: null, railMode: "sim" });

    expect(await seedEntries(db, worldId)).toHaveLength(1);
    expect(await getAccountBalance(db, worldId, "cash_paypal", null)).toBe(10000n);
    expect(await getAccountBalance(db, worldId, "bank_equity", null)).toBe(-10000n);
    expect(await availableLiquidity(db, worldId)).toBe(10000n);
    expect((await trialBalance(db, worldId)).totalCents).toBe(0n);
  });

  it("BANK_SEED_CAPITAL_CENTS overrides the amount; 0 seeds nothing", async () => {
    process.env.BANK_SEED_CAPITAL_CENTS = "2500";
    const { worldId } = await createWorld(db, { name: "Custom", ownerPrincipalId: null, railMode: "sim" });
    expect(await getAccountBalance(db, worldId, "cash_paypal", null)).toBe(2500n);

    process.env.BANK_SEED_CAPITAL_CENTS = "0";
    const { worldId: empty } = await createWorld(db, { name: "Empty", ownerPrincipalId: null, railMode: "sim" });
    expect(await seedEntries(db, empty)).toHaveLength(0);
    expect(await availableLiquidity(db, empty)).toBe(0n);
  });

  it("rejects a malformed BANK_SEED_CAPITAL_CENTS with a clear message (parsed once per value, M4)", async () => {
    process.env.BANK_SEED_CAPITAL_CENTS = "12.5";
    expect(() => bankSeedCapitalCents()).toThrow(
      'BANK_SEED_CAPITAL_CENTS must be a non-negative integer number of cents (e.g. "10000"), got "12.5"',
    );
    // The cached failure is rethrown, not re-parsed into something else.
    expect(() => bankSeedCapitalCents()).toThrow(/got "12\.5"/);
    await expect(createWorld(db, { name: "Bad", ownerPrincipalId: null, railMode: "sim" })).rejects.toThrow(
      /BANK_SEED_CAPITAL_CENTS/,
    );
    process.env.BANK_SEED_CAPITAL_CENTS = "300";
    expect(bankSeedCapitalCents()).toBe(300n);
  });

  it("the seed journal's sim_at is the world's simulated now (M3)", async () => {
    const anchorSim = new Date("2020-01-01T00:00:00.000Z");
    const [world] = await db
      .insert(worlds)
      .values({ slug: "main", name: "Main", ownerPrincipalId: null, railMode: "paypal" })
      .returning();
    await db.insert(clock).values({ worldId: world!.id, anchorReal: new Date(), anchorSim, speed: "0", manualOffsetMs: 0n });

    const { worldId } = await ensureMainWorld(db);

    expect(worldId).toBe(world!.id);
    const [seed] = await seedEntries(db, worldId);
    expect(seed!.simAt.toISOString()).toBe(anchorSim.toISOString());
  });

  it("ensureMainWorld seeds the main world exactly once across repeated ensures", async () => {
    const { worldId } = await ensureMainWorld(db);
    await ensureMainWorld(db);
    await ensureMainWorld(db);

    expect(await seedEntries(db, worldId)).toHaveLength(1);
    expect(await getAccountBalance(db, worldId, "cash_paypal", null)).toBe(10000n);
  });
});
