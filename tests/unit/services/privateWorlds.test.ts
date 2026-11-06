/**
 * P2 Task 6: private sandbox worlds — sim rail only, seeded lender and
 * borrower bots, clock controls, reset.
 *
 * Review Focus 5: bots and private-world actions never use the PayPal
 * rail and never appear in main-world reads; every world's trial balance
 * is 0 after 30 simulated days of bots; the same seed gives the same
 * ledger.
 */
import { and, eq, inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { advanceClock } from "@/server/clock/clock";
import "@/server/contracts/tools";
import { findTool } from "@/server/contracts/registry";
import { runTool } from "@/server/contracts/runTool";
import type { Db } from "@/server/db/client";
import {
  aiRuns,
  applications,
  agents,
  events,
  journalEntries,
  ledgerAccounts,
  loans,
  notePositions,
  paypalOperations,
  postings,
  principals,
  worlds,
} from "@/server/db/schema";
import { createTestDb } from "@/server/db/testing";
import { trialBalance } from "@/server/ledger/trialBalance";
import { enqueueOperation } from "@/server/paypal/operations";
import { runTick } from "@/server/jobs/tick";
import { runBotsCatchUp } from "@/server/bots/runner";
import { ownerDashboard } from "@/server/services/dashboard";
import { registerOwnedAgent } from "@/server/services/owner";
import { lookupClaim, claimAgent, issueClaimToken } from "@/server/services/claims";
import {
  MAX_PRIVATE_WORLDS,
  advancePrivateWorld,
  createPrivateWorld,
  listPrivateWorlds,
  ownedPrivateWorld,
  privateWorldView,
  resetPrivateWorld,
  resolveDashboardWorld,
} from "@/server/services/privateWorlds";
import { ensureMainWorld, listActiveWorldIds, railForWorld } from "@/server/services/worlds";

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const DAY_MS = 86_400_000;

describe("private worlds (P2 Task 6)", () => {
  let db: Db;
  let owner: string;

  beforeEach(async () => {
    vi.stubEnv("SESSION_SECRET", "unit-test-session-secret-0123456789abcdef");
    vi.stubEnv("API_KEY_PEPPER", "test-pepper");
    db = await createTestDb();
    owner = await newPrincipal("OWNER");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function newPrincipal(name: string, verified = true): Promise<string> {
    const [row] = await db
      .insert(principals)
      .values({
        paypalPayerId: name,
        email: `${name.toLowerCase()}@example.com`,
        name,
        entityType: "individual",
        verifiedAt: verified ? new Date() : null,
      })
      .returning();
    return row!.id;
  }

  async function create(name = "Demo", seed?: string): Promise<string> {
    const created = await createPrivateWorld(db, owner, { name, seed });
    if (created.outcome !== "created") {
      throw new Error(`expected created, got ${created.outcome}`);
    }
    return created.worldId;
  }

  async function botsOf(worldId: string) {
    return db.select().from(agents).where(and(eq(agents.worldId, worldId), eq(agents.isBot, true)));
  }

  async function paypalRailOps(worldId: string) {
    return db
      .select({ id: paypalOperations.id })
      .from(paypalOperations)
      .where(and(eq(paypalOperations.worldId, worldId), eq(paypalOperations.rail, "paypal")));
  }

  /** Every journal entry as "day|memo|account:amount,…", ids stripped, sorted — the ledger's shape. */
  async function ledgerShape(worldId: string): Promise<string[]> {
    const [world] = await db.select().from(worlds).where(eq(worlds.id, worldId));
    const entries = await db.select().from(journalEntries).where(eq(journalEntries.worldId, worldId));
    const lines = await db
      .select({ entryId: postings.entryId, amount: postings.amountCents, code: ledgerAccounts.code })
      .from(postings)
      .innerJoin(ledgerAccounts, eq(ledgerAccounts.id, postings.accountId))
      .where(eq(postings.worldId, worldId));
    const anchor = world!.createdAt.getTime();
    return entries
      .map((entry) => {
        const day = Math.floor((entry.simAt.getTime() - anchor + 60_000) / DAY_MS);
        const parts = lines
          .filter((line) => line.entryId === entry.id)
          .map((line) => `${line.code}:${line.amount.toString()}`)
          .sort()
          .join(",");
        return `${day}|${(entry.memo ?? "").replace(UUID_RE, "<id>")}|${parts}`;
      })
      .sort();
  }

  it("creates a private sim world seeded with 4 lender bots (20000 + 15000 + 15000 + 10000 of notes) and 6 claimed borrower bots (P5 bots v2)", async () => {
    const worldId = await create("Judges' bank");
    const [world] = await db.select().from(worlds).where(eq(worlds.id, worldId));
    expect(world).toMatchObject({ kind: "private", railMode: "sim", ownerPrincipalId: owner, name: "Judges' bank", status: "active" });
    expect(world!.botPrincipalId).toBeTruthy();
    expect(world!.lastBotSimDay).toBe(0);
    expect(world!.botVersion).toBe(2);
    expect(await railForWorld(db, worldId)).toBe("sim");

    const bots = await botsOf(worldId);
    expect(bots).toHaveLength(10);
    for (const bot of bots) {
      expect(bot).toMatchObject({ operator: "Mandate bots", model: "simulated", status: "active", isBot: true });
    }
    const lenders = bots.filter((b) => b.name.startsWith("Lender bot"));
    const borrowers = bots.filter((b) => b.name.startsWith("Borrower bot"));
    expect(lenders).toHaveLength(4);
    expect(borrowers).toHaveLength(6);
    // Bots v2: each borrower bot is claimed by its own system principal.
    expect(new Set(borrowers.map((b) => b.principalId)).size).toBe(6);
    for (const borrower of borrowers) {
      expect(borrower.principalId).not.toBe(owner);
      expect(borrower.claimedAt).toBeTruthy();
      const [principal] = await db.select().from(principals).where(eq(principals.id, borrower.principalId!));
      expect(principal).toMatchObject({ entityType: "system" });
    }

    const positions = await db
      .select()
      .from(notePositions)
      .where(inArray(notePositions.agentId, lenders.map((l) => l.id)));
    expect(positions.map((p) => p.costCents).sort()).toEqual([10000n, 15000n, 15000n, 20000n]);

    // The bot principal is a system principal — never the owner.
    const [botPrincipal] = await db.select().from(principals).where(eq(principals.id, world!.botPrincipalId!));
    expect(botPrincipal).toMatchObject({ name: "Mandate bots", entityType: "system" });

    expect((await trialBalance(db, worldId)).totalCents).toBe(0n);
    expect(await paypalRailOps(worldId)).toEqual([]);
  });

  it("a principal may have at most 3 active private worlds; an unverified principal none", async () => {
    expect(MAX_PRIVATE_WORLDS).toBe(3);
    const ids = [await create("A"), await create("B"), await create("C")];
    expect(await createPrivateWorld(db, owner, { name: "D" })).toEqual({ outcome: "limit" });
    expect((await listPrivateWorlds(db, owner)).map((w) => w.id).sort()).toEqual([...ids].sort());

    const unverified = await newPrincipal("NOPE", false);
    expect(await createPrivateWorld(db, unverified, { name: "X" })).toEqual({ outcome: "unverified" });
    const other = await newPrincipal("OTHER");
    expect(await createPrivateWorld(db, other, { name: "  " })).toEqual({ outcome: "invalid" });
  });

  it("enqueueOperation refuses a PayPal-rail operation in a private world (and allows sim)", async () => {
    const worldId = await create();
    const request = {
      method: "POST" as const,
      path: "/v2/checkout/orders",
      body: { intent: "CAPTURE", purchase_units: [{ amount: { currency_code: "USD", value: "10.00" } }] },
    };
    await expect(
      enqueueOperation(db, {
        worldId,
        rail: "paypal",
        kind: "order.create",
        purpose: "note_purchase",
        sourceId: "00000000-0000-4000-8000-000000000001",
        request,
      }),
    ).rejects.toThrow(/private world/i);
    expect(await paypalRailOps(worldId)).toEqual([]);
  });

  it("30 simulated days of bots: loans are made and repaid, no PayPal-rail op, trial balance 0, main world untouched", async () => {
    const { worldId: mainId } = await ensureMainWorld(db);
    const mainEntriesBefore = (await db.select().from(journalEntries).where(eq(journalEntries.worldId, mainId))).length;
    const worldId = await create("Thirty days");

    for (let i = 0; i < 30; i += 7) {
      const advanced = await advancePrivateWorld(db, owner, worldId, Math.min(7, 30 - i));
      expect(advanced.outcome).toBe("advanced");
    }
    const [world] = await db.select().from(worlds).where(eq(worlds.id, worldId));
    expect(world!.lastBotSimDay).toBe(30);

    const worldLoans = await db.select().from(loans).where(eq(loans.worldId, worldId));
    expect(worldLoans.length).toBeGreaterThanOrEqual(2);
    expect(worldLoans.some((loan) => loan.status === "repaid")).toBe(true);
    // P3 Task 4: bots get the template narrative, never an LLM call (no ai_runs rows).
    const botApplications = await db.select().from(applications).where(eq(applications.worldId, worldId));
    expect(botApplications.every((application) => application.narrative !== null)).toBe(true);
    expect(await db.select().from(aiRuns).where(eq(aiRuns.worldId, worldId))).toEqual([]);

    expect(await paypalRailOps(worldId)).toEqual([]);
    expect((await trialBalance(db, worldId)).totalCents).toBe(0n);
    for (const account of (await trialBalance(db, worldId)).accounts) {
      if (account.code === "cash_paypal") {
        expect(account.balanceCents).toBeGreaterThanOrEqual(0n);
      }
    }

    // Nothing leaked into the main world.
    const mainEntriesAfter = (await db.select().from(journalEntries).where(eq(journalEntries.worldId, mainId))).length;
    expect(mainEntriesAfter).toBe(mainEntriesBefore);
    expect(await db.select().from(agents).where(and(eq(agents.worldId, mainId), eq(agents.isBot, true)))).toEqual([]);
    expect(await paypalRailOps(mainId)).toEqual([]);
  }, 180_000);

  it("is deterministic: two worlds with the same seed run the same ledger", async () => {
    const a = await create("Twin A", "same-seed");
    const b = await create("Twin B", "same-seed");
    await advancePrivateWorld(db, owner, a, 7);
    await advancePrivateWorld(db, owner, a, 5);
    await advancePrivateWorld(db, owner, b, 6);
    await advancePrivateWorld(db, owner, b, 6);
    const shapeA = await ledgerShape(a);
    expect(shapeA.length).toBeGreaterThan(5);
    expect(await ledgerShape(b)).toEqual(shapeA);
    expect((await trialBalance(db, b)).totalCents).toBe(0n);
  }, 120_000);

  it("bots act only when the world's sim day advanced: idle ticks change nothing, a day moved elsewhere is caught up by the tick", async () => {
    const worldId = await create();
    const before = (await db.select().from(journalEntries).where(eq(journalEntries.worldId, worldId))).length;
    await runTick(db);
    await runTick(db);
    expect((await db.select().from(journalEntries).where(eq(journalEntries.worldId, worldId))).length).toBe(before);
    expect(await runBotsCatchUp(db, worldId)).toBe(0);

    await advanceClock(db, worldId, 1);
    await runTick(db);
    const [world] = await db.select().from(worlds).where(eq(worlds.id, worldId));
    expect(world!.lastBotSimDay).toBe(1);
    expect(await runBotsCatchUp(db, worldId)).toBe(0);
  }, 60_000);

  it("advance: only the owner, only 1–7 days; reset archives the old world and makes a fresh one", async () => {
    const worldId = await create("Resettable");
    const intruder = await newPrincipal("INTRUDER");
    expect(await advancePrivateWorld(db, intruder, worldId, 1)).toEqual({ outcome: "not_found" });
    expect(await advancePrivateWorld(db, owner, worldId, 0)).toEqual({ outcome: "invalid" });
    expect(await advancePrivateWorld(db, owner, worldId, 8)).toEqual({ outcome: "invalid" });
    expect(await resetPrivateWorld(db, intruder, worldId)).toEqual({ outcome: "not_found" });
    expect(await ownedPrivateWorld(db, intruder, worldId)).toBeNull();

    // A path-B agent in the world keeps working until the reset.
    const registered = await registerOwnedAgent(
      db,
      owner,
      { name: "Mine", operator: "me", model: "claude", payoutEmail: "mine@example.com" },
      new Date(),
      { worldId },
    );
    expect(registered.outcome).toBe("registered");
    if (registered.outcome !== "registered") return;
    expect(registered.worldId).toBe(worldId);

    // Reconcile and the tick cover active private worlds (their sim ops still settle).
    expect(await listActiveWorldIds(db)).toContain(worldId);
    const reset = await resetPrivateWorld(db, owner, worldId);
    expect(reset.outcome).toBe("reset");
    if (reset.outcome !== "reset") return;
    const [old] = await db.select().from(worlds).where(eq(worlds.id, worldId));
    expect(old).toMatchObject({ status: "archived" });
    expect(old!.archivedAt).toBeTruthy();
    const [fresh] = await db.select().from(worlds).where(eq(worlds.id, reset.worldId));
    expect(fresh).toMatchObject({ kind: "private", name: "Resettable", status: "active", ownerPrincipalId: owner });
    expect(await listActiveWorldIds(db)).not.toContain(worldId);
    expect((await listPrivateWorlds(db, owner)).map((w) => w.id)).toEqual([reset.worldId]);
    expect(await ownedPrivateWorld(db, owner, worldId)).toBeNull();
    expect(await advancePrivateWorld(db, owner, worldId, 1)).toEqual({ outcome: "not_found" });

    // The archived world's agent can't act any more.
    const res = await runTool(findTool("get_status"), "get_status", {}, {
      getDb: async () => db,
      authorization: `Bearer ${registered.apiKey}`,
    });
    expect(res.envelope.status).toBe("WORLD_ARCHIVED");
  }, 60_000);

  it("M6: reset fails the archived world's unfinished sim ops (world_archived) in one go; finished ops and other worlds are untouched", async () => {
    const worldId = await create("Pending");
    const other = await create("Other");
    const request = {
      method: "POST" as const,
      path: "/v2/checkout/orders",
      body: { intent: "CAPTURE", purchase_units: [{ amount: { currency_code: "USD", value: "10.00" } }] },
    };
    const enqueue = async (world: string, n: number) => {
      const { operationId } = await enqueueOperation(db, {
        worldId: world,
        rail: "sim",
        kind: "order.create",
        purpose: "note_purchase",
        sourceId: `00000000-0000-4000-8000-00000000000${n}`,
        request,
      });
      return operationId;
    };
    const ids: Record<string, string> = {};
    for (const [n, status] of (["queued", "failed_retryable", "in_flight", "succeeded", "failed_terminal"] as const).entries()) {
      ids[status] = await enqueue(worldId, n + 1);
      await db
        .update(paypalOperations)
        .set({ status, claimedAt: status === "in_flight" ? new Date() : null, lastError: status === "failed_terminal" ? "earlier" : null })
        .where(eq(paypalOperations.id, ids[status]!));
    }
    const elsewhere = await enqueue(other, 9);

    expect((await resetPrivateWorld(db, owner, worldId)).outcome).toBe("reset");

    const rows = await db.select().from(paypalOperations).where(eq(paypalOperations.worldId, worldId));
    const byId = new Map(rows.map((row) => [row.id, row]));
    for (const status of ["queued", "failed_retryable", "in_flight"]) {
      expect(byId.get(ids[status]!), status).toMatchObject({
        status: "failed_terminal",
        lastError: "world_archived",
        claimedAt: null,
        nextAttemptAt: null,
      });
    }
    expect(byId.get(ids.succeeded!)!.status).toBe("succeeded");
    expect(byId.get(ids.failed_terminal!)).toMatchObject({ status: "failed_terminal", lastError: "earlier" });
    // Nothing of the archived world is left queued; the owner's other world keeps its queue.
    expect(rows.filter((row) => ["queued", "failed_retryable", "in_flight"].includes(row.status))).toEqual([]);
    const [kept] = await db.select().from(paypalOperations).where(eq(paypalOperations.id, elsewhere));
    expect(kept!.status).toBe("queued");
  }, 60_000);

  it("path B into a private world: only the owner's own active private world; the main dashboard excludes it", async () => {
    const worldId = await create();
    const intruder = await newPrincipal("INTRUDER");
    expect(
      await registerOwnedAgent(db, intruder, { name: "Sneaky", operator: "x", model: "y", payoutEmail: "s@example.com" }, new Date(), {
        worldId,
      }),
    ).toEqual({ outcome: "world_not_found" });

    const inMain = await registerOwnedAgent(db, owner, { name: "Main one", operator: "me", model: "m", payoutEmail: "a@example.com" });
    const inPrivate = await registerOwnedAgent(
      db,
      owner,
      { name: "Private one", operator: "me", model: "m", payoutEmail: "b@example.com" },
      new Date(),
      { worldId },
    );
    expect(inMain.outcome).toBe("registered");
    expect(inPrivate.outcome).toBe("registered");

    const mainView = await ownerDashboard(db, owner);
    expect(mainView.agents.map((a) => a.name)).toEqual(["Main one"]);
    const privateView = await ownerDashboard(db, owner, new Date(), { worldId });
    expect(privateView.agents.map((a) => a.name)).toEqual(["Private one"]);

    // Bots never show up on the owner's dashboard (they belong to the bot principal).
    expect(privateView.agents.some((a) => a.operator === "Mandate bots")).toBe(false);

    // The private agent's money moves on the sim rail.
    if (inPrivate.outcome !== "registered") return;
    const buy = await runTool(findTool("buy_notes"), "buy_notes", { amount_cents: 1000 }, {
      getDb: async () => db,
      authorization: `Bearer ${inPrivate.apiKey}`,
    });
    expect(buy.envelope.status).toBe("AWAITING_APPROVAL");
    expect(await paypalRailOps(worldId)).toEqual([]);
  }, 60_000);

  it("resolveDashboardWorld: main by default; the owner's private world when asked; anything else falls back to main", async () => {
    const worldId = await create("Mine");
    const { worldId: mainId } = await ensureMainWorld(db);
    expect(await resolveDashboardWorld(db, owner, undefined)).toMatchObject({ id: mainId, kind: "main" });
    expect(await resolveDashboardWorld(db, owner, worldId)).toMatchObject({ id: worldId, kind: "private", name: "Mine" });
    const intruder = await newPrincipal("INTRUDER");
    expect(await resolveDashboardWorld(db, intruder, worldId)).toMatchObject({ id: mainId, kind: "main" });
    expect(await resolveDashboardWorld(db, owner, "not-a-uuid")).toMatchObject({ id: mainId });
  });

  it("the world view shows the bots, the pool and the simulated date — only to the owner", async () => {
    const worldId = await create("Viewable");
    await advancePrivateWorld(db, owner, worldId, 3);
    const view = await privateWorldView(db, owner, worldId);
    expect(view).not.toBeNull();
    expect(view!.simDay).toBe(3);
    expect(view!.bots).toHaveLength(10);
    expect(view!.bots.filter((b) => b.role === "lender")).toHaveLength(4);
    expect(view!.bots.filter((b) => b.role === "borrower").every((b) => b.archetype !== null)).toBe(true);
    // P5 Task 4: the economy panel (the advance stepped days 1–3 and wrote template memos).
    expect(view!.economy).toMatchObject({ simDay: 3 });
    expect(view!.economy!.memo).toMatchObject({ sim_day: 3, source: "template" });
    expect(view!.stressEvents).toEqual([]);
    expect(view!.notesOutstandingCents).toBeGreaterThan(0n);
    expect(view!.recentDays.length).toBeGreaterThan(0);
    expect(view!.trialBalanceCents).toBe(0n);
    expect(await privateWorldView(db, await newPrincipal("INTRUDER"), worldId)).toBeNull();
  }, 60_000);

  it("bots can't be driven through an API key, and a non-bot can't be driven by the bot runner", async () => {
    const worldId = await create();
    const bots = await botsOf(worldId);
    // Bots have no API keys at all.
    const { apiKeys } = await import("@/server/db/schema");
    expect(await db.select().from(apiKeys).where(inArray(apiKeys.agentId, bots.map((b) => b.id)))).toEqual([]);

    const mine = await registerOwnedAgent(db, owner, { name: "Human's", operator: "me", model: "m", payoutEmail: "h@example.com" }, new Date(), {
      worldId,
    });
    if (mine.outcome !== "registered") throw new Error("expected registered");
    const res = await runTool(findTool("get_status"), "get_status", {}, { getDb: async () => db, actingBotId: mine.agentId });
    expect(res.envelope.status).toBe("UNAUTHORIZED");
  });

  it("claim links resolve in a private world too", async () => {
    const worldId = await create();
    const [agent] = await db
      .insert(agents)
      .values({ worldId, name: "Claimable", operator: "o", model: "m", codeManifestHash: "x", status: "active" })
      .returning();
    const issued = issueClaimToken(agent!.id);
    await db.update(agents).set(issued.columns).where(eq(agents.id, agent!.id));
    expect((await lookupClaim(db, issued.token)).state).toBe("claimable");
    expect((await claimAgent(db, owner, issued.token)).outcome).toBe("claimed");
    expect((await db.select().from(agents).where(eq(agents.id, agent!.id)))[0]!.principalId).toBe(owner);
  });

  it("bot events are recorded in the private world only", async () => {
    const worldId = await create();
    await advancePrivateWorld(db, owner, worldId, 2);
    const { worldId: mainId } = await ensureMainWorld(db);
    const botEvents = await db.select().from(events).where(eq(events.worldId, worldId));
    expect(botEvents.length).toBeGreaterThan(0);
    const mainBotEvents = (await db.select().from(events).where(eq(events.worldId, mainId))).filter((e) =>
      e.type.startsWith("bot."),
    );
    expect(mainBotEvents).toEqual([]);
  }, 60_000);
});
