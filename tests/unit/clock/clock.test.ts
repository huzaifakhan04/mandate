import { describe, expect, it, vi } from "vitest";

import type { Db } from "@/server/db/client";
import { clock, worlds } from "@/server/db/schema";
import { createTestDb } from "@/server/db/testing";
import { advanceClock, getSimNow, simNow } from "@/server/clock/clock";
import { createWorld, ensureMainWorld } from "@/server/services/worlds";
import * as accountsModule from "@/server/ledger/accounts";
import { trialBalance } from "@/server/ledger/trialBalance";
import { eq } from "drizzle-orm";

describe("simNow", () => {
  it("with speed 0 returns anchorSim + offset", () => {
    const anchorReal = new Date("2026-01-01T00:00:00Z");
    const anchorSim = new Date("2030-01-01T00:00:00Z");
    const realNow = new Date("2026-06-01T00:00:00Z");

    const result = simNow(
      { anchorReal, anchorSim, speed: 0, manualOffsetMs: 5_000n },
      realNow,
    );

    expect(result.getTime()).toBe(anchorSim.getTime() + 5_000);
  });

  it("with speed 1440, 60s of real time advances 1 sim day", () => {
    const anchorReal = new Date("2026-01-01T00:00:00Z");
    const anchorSim = new Date("2026-01-01T00:00:00Z");
    const realNow = new Date(anchorReal.getTime() + 60_000);

    const result = simNow(
      { anchorReal, anchorSim, speed: 1440, manualOffsetMs: 0n },
      realNow,
    );

    expect(result.getTime()).toBe(anchorSim.getTime() + 86_400_000);
  });
});

describe("advanceClock / getSimNow", () => {
  let db: Db;
  let worldId: string;

  async function setupWorld(): Promise<void> {
    db = await createTestDb();
    const { worldId: id } = await ensureMainWorld(db);
    worldId = id;
  }

  it("advanceClock(…, 7) moves getSimNow forward by exactly 7 days", async () => {
    await setupWorld();

    const before = await getSimNow(db, worldId);
    await advanceClock(db, worldId, 7);
    const after = await getSimNow(db, worldId, before);

    expect(after.getTime() - before.getTime()).toBe(7 * 86_400_000);
  });

  it("advanceClock(…, 0) throws", async () => {
    await setupWorld();
    await expect(advanceClock(db, worldId, 0)).rejects.toThrow();
  });

  it("advanceClock(…, 366) throws", async () => {
    await setupWorld();
    await expect(advanceClock(db, worldId, 366)).rejects.toThrow();
  });

  it("advanceClock(…, -1) throws", async () => {
    await setupWorld();
    await expect(advanceClock(db, worldId, -1)).rejects.toThrow();
  });

  it("advanceClock(…, 2.5) throws (non-integer days)", async () => {
    await setupWorld();
    await expect(advanceClock(db, worldId, 2.5)).rejects.toThrow();
  });

  it("advanceClock(…, NaN) throws", async () => {
    await setupWorld();
    await expect(advanceClock(db, worldId, NaN)).rejects.toThrow();
  });

  it("advanceClock throws a clear error when no clock row exists for the world", async () => {
    await setupWorld();
    const missingWorldId = "00000000-0000-0000-0000-000000000000";

    await expect(advanceClock(db, missingWorldId, 7)).rejects.toThrow(
      /no clock row found for world/i,
    );
  });
});

describe("ensureMainWorld", () => {
  it("called twice returns the same id", async () => {
    const db = await createTestDb();
    const first = await ensureMainWorld(db);
    const second = await ensureMainWorld(db);

    expect(second.worldId).toBe(first.worldId);
  });

  it("seeds a clock row with speed 0 and anchors set to now", async () => {
    const db = await createTestDb();
    const { worldId } = await ensureMainWorld(db);

    const [row] = await db.select().from(clock).where(eq(clock.worldId, worldId));
    expect(row).toBeDefined();
    expect(row?.speed).toBe("0.0000");
  });

  it("seeds the chart of accounts for the main world", async () => {
    const db = await createTestDb();
    const { worldId } = await ensureMainWorld(db);

    const { accounts } = await trialBalance(db, worldId);
    expect(accounts.length).toBeGreaterThan(0);
  });
});

describe("createWorld", () => {
  it("seeds the chart of accounts, so trialBalance lists 0 accounts with non-zero balances", async () => {
    const db = await createTestDb();
    const { worldId, slug } = await createWorld(db, {
      name: "Test World",
      ownerPrincipalId: null,
      railMode: "sim",
    });

    expect(worldId).toBeTruthy();
    expect(slug).toBeTruthy();

    const { accounts, totalCents } = await trialBalance(db, worldId);
    expect(accounts.length).toBeGreaterThan(0);
    const nonZero = accounts.filter((a) => a.balanceCents !== 0n);
    expect(nonZero).toHaveLength(0);
    expect(totalCents).toBe(0n);
  });

  it("rolls back the world and clock rows if a later step throws", async () => {
    const db = await createTestDb();

    const spy = vi
      .spyOn(accountsModule, "ensureChartOfAccounts")
      .mockRejectedValueOnce(new Error("boom: forced failure after world insert"));

    await expect(
      createWorld(db, {
        name: "Doomed World",
        ownerPrincipalId: null,
        railMode: "sim",
      }),
    ).rejects.toThrow("boom");

    spy.mockRestore();

    const worldRows = await db
      .select()
      .from(worlds)
      .where(eq(worlds.name, "Doomed World"));
    expect(worldRows).toHaveLength(0);

    const clockRows = await db.select().from(clock);
    expect(clockRows).toHaveLength(0);
  });
});
