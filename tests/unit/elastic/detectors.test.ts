/**
 * P7 Task 2 — the deterministic detectors (`elastic/detectors.ts`) against
 * a fake ES|QL endpoint (msw), and the flags' deterministic effect:
 *
 * - each detector's template is world-scoped and its hits become one
 *   risk_flags row per (agent, kind, window) — re-running is idempotent and
 *   only refreshes evidence; bots are excluded by the templates;
 * - sliding windows / medians / probing sequences are computed exactly;
 * - an open flag declines apply_for_loan with risk_review (next action
 *   get_status), refuses accept_offer, shows in get_status; lending is
 *   unaffected; the flag expires 7 sim days after its latest evidence;
 * - "Request review" and owner clearing (private worlds only).
 */
import { and, eq } from "drizzle-orm";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { advanceClock, getSimNow } from "@/server/clock/clock";
import type { Db } from "@/server/db/client";
import { agents, events, principals, riskFlags } from "@/server/db/schema";
import { createTestDb } from "@/server/db/testing";
import { densestWindow, median, probingHits, runDetectors } from "@/server/elastic/detectors";
import { ESQL_TEMPLATES, EsqlParamError, validateParams } from "@/server/elastic/esql";
import { REASON_PRIORITY } from "@/server/domain/reasons";
import {
  clearRiskFlag,
  expireStaleRiskFlags,
  hasActiveRiskFlag,
  recordRiskHit,
  requestRiskReview,
  windowKeyFor,
} from "@/server/services/riskFlags";
import { createPrivateWorld } from "@/server/services/privateWorlds";

import { fakeEsql, stubElastic, unstubElastic } from "../../helpers/elastic";
import { call, createSimWorld, createTestAgent, type Data, fundPool } from "../../helpers/world";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe("detector pure parts", () => {
  it("densestWindow finds the largest group inside a sliding window", () => {
    const t0 = Date.parse("2026-01-01T00:00:00Z");
    const at = (min: number) => ({ at: new Date(t0 + min * 60_000) });
    // 4 within 9 minutes, straddling a 10-minute bucket boundary (minutes 7..16).
    expect(densestWindow([at(0), at(7), at(9), at(12), at(16), at(40)], 10 * 60_000)).toHaveLength(4);
    expect(densestWindow([at(0), at(11), at(22), at(33)], 10 * 60_000)).toHaveLength(1);
  });

  it("median counts idle days", () => {
    expect(median([0, 0, 0, 1, 2, 0, 0])).toBe(0);
    expect(median([2, 4])).toBe(3);
    expect(median([])).toBe(0);
  });

  it("probingHits: three declines then a smaller application within one sim day", () => {
    const t = (h: number) => new Date(Date.parse("2026-02-01T00:00:00Z") + h * HOUR);
    const rows = [
      { agentId: "a", applicationId: "1", decision: "declined", amountCents: 50000, simAt: t(0) },
      { agentId: "a", applicationId: "2", decision: "declined", amountCents: 40000, simAt: t(2) },
      { agentId: "a", applicationId: "3", decision: "declined", amountCents: 30000, simAt: t(4) },
      { agentId: "a", applicationId: "4", decision: "approved", amountCents: 20000, simAt: t(6) },
      // b: the smaller application comes > 1 sim day after the declines.
      { agentId: "b", applicationId: "5", decision: "declined", amountCents: 50000, simAt: t(0) },
      { agentId: "b", applicationId: "6", decision: "declined", amountCents: 40000, simAt: t(1) },
      { agentId: "b", applicationId: "7", decision: "declined", amountCents: 30000, simAt: t(2) },
      { agentId: "b", applicationId: "8", decision: "approved", amountCents: 20000, simAt: t(30) },
    ];
    const hits = probingHits(rows);
    expect(hits.map((h) => h.agentId)).toEqual(["a"]);
    expect(hits[0]!.probe.applicationId).toBe("4");
  });

  it("every template is world-scoped and params are validated (no extras, well-formed)", () => {
    for (const template of Object.values(ESQL_TEMPLATES)) {
      expect(template.query).toContain("world_id == ?world_id");
      expect(template.params.world_id).toBe("world");
    }
    const t = ESQL_TEMPLATES.score_farming!;
    expect(() => validateParams(t, { world_id: "not-a-uuid", since: "2026-01-01T00:00:00.000Z", min_cycles: 3 })).toThrow(EsqlParamError);
    expect(() =>
      validateParams(t, { world_id: "00000000-0000-4000-8000-000000000000", since: "2026-01-01T00:00:00.000Z", min_cycles: 3, x: 1 }),
    ).toThrow(EsqlParamError);
    expect(() =>
      validateParams(t, { world_id: "00000000-0000-4000-8000-000000000000", since: "yesterday; DROP", min_cycles: 3 }),
    ).toThrow(EsqlParamError);
  });

  it("risk_review is a reason code right after the tier check", () => {
    expect(REASON_PRIORITY.indexOf("risk_review")).toBe(REASON_PRIORITY.indexOf("tier_per_loan") + 1);
  });
});

describe("detectors → risk flags (P7 Task 2)", () => {
  let db: Db;
  let worldId: string;

  beforeEach(async () => {
    vi.stubEnv("API_KEY_PEPPER", "test-pepper");
    db = await createTestDb();
    worldId = await createSimWorld(db);
    stubElastic();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    unstubElastic();
  });

  async function plainAgent(name: string) {
    const [row] = await db.insert(agents).values({ worldId, name, operator: "o", model: "m", codeManifestHash: "x" }).returning();
    return row!.id;
  }

  it("each detector's hits become flags, idempotently, with world-scoped queries", async () => {
    const [a, b, c, d, e, f, g] = await Promise.all(["a", "b", "c", "d", "e", "f", "g"].map(plainAgent));
    const simNow = await getSimNow(db, worldId);
    const now = new Date();
    const regAt = (min: number) => new Date(now.getTime() - HOUR + min * 60_000).toISOString();
    const today = new Date(Math.floor(now.getTime() / DAY) * DAY).toISOString();
    const calls = fakeEsql(server, [
      { includes: "payer_hash == borrower_payer_hash\n", rows: [{ orders: 2, loans: ["l1", "l2"], last_at: now.toISOString(), agent_id: a }] },
      { includes: "COUNT_DISTINCT(borrower_principal_hash)", rows: [] },
      { includes: 'cycle_minutes < 1440', rows: [{ cycles: 3, loans: ["x", "y", "z"], last_at: simNow.toISOString(), agent_id: b }] },
      { includes: "STATS agents = COUNT(*) BY principal_hash", rows: [{ agents: 4, principal_hash: "h_0123456789abcdef01234567" }] },
      {
        includes: "principal_hash == ?principal_hash",
        rows: [
          { agent_id: c, created_at: regAt(0), sim_at: simNow.toISOString() },
          { agent_id: d, created_at: regAt(3), sim_at: simNow.toISOString() },
          { agent_id: e, created_at: regAt(6), sim_at: simNow.toISOString() },
          { agent_id: f, created_at: regAt(9), sim_at: simNow.toISOString() },
        ],
      },
      {
        includes: "INLINE STATS",
        rows: [
          { agent_id: g, application_id: "p1", decision: "declined", amount_cents: 50000, sim_at: new Date(simNow.getTime() - 5 * HOUR).toISOString() },
          { agent_id: g, application_id: "p2", decision: "declined", amount_cents: 40000, sim_at: new Date(simNow.getTime() - 4 * HOUR).toISOString() },
          { agent_id: g, application_id: "p3", decision: "declined", amount_cents: 30000, sim_at: new Date(simNow.getTime() - 3 * HOUR).toISOString() },
          { agent_id: g, application_id: "p4", decision: "declined", amount_cents: 10000, sim_at: new Date(simNow.getTime() - 2 * HOUR).toISOString() },
        ],
      },
      { includes: "note.redemption_requested", rows: [{ requests: 5, amount_cents: 500, agent_id: a, day: today }] },
    ]);

    const report = await runDetectors(db, { worldId, simNow, now });
    expect(report.errors).toEqual([]);
    expect(report.hits).toEqual({ self_dealing: 1, score_farming: 1, sybil_burst: 4, probing: 1, velocity: 1 });
    expect(report.newFlagIds).toHaveLength(8);
    for (const c of calls) expect(c.params.world_id).toBe(worldId);

    const flags = await db.select().from(riskFlags).where(eq(riskFlags.worldId, worldId));
    expect(flags.map((x) => `${x.kind}`).sort()).toEqual(
      ["probing", "score_farming", "self_dealing", "sybil_burst", "sybil_burst", "sybil_burst", "sybil_burst", "velocity"].sort(),
    );
    const sybil = flags.find((x) => x.kind === "sybil_burst")!;
    expect((sybil.evidence as Data).agents_in_burst).toBe(4);
    expect(sybil.windowKey).toBe(windowKeyFor(sybil.lastEvidenceSimAt));
    const flaggedEvent = await db.select().from(events).where(and(eq(events.worldId, worldId), eq(events.type, "agent.risk_flagged"))!);
    expect(flaggedEvent).toHaveLength(8);

    // Idempotent: the same evidence again opens nothing new.
    const again = await runDetectors(db, { worldId, simNow, now });
    expect(again.newFlagIds).toEqual([]);
    expect(await db.select().from(riskFlags).where(eq(riskFlags.worldId, worldId))).toHaveLength(8);
  });

  it("a detector failing (Elastic down) is reported and doesn't stop the others", async () => {
    const a = await plainAgent("a");
    const simNow = await getSimNow(db, worldId);
    fakeEsql(server, [{ includes: 'cycle_minutes < 1440', rows: [{ cycles: 4, loans: [], last_at: simNow.toISOString(), agent_id: a }] }]);
    const { http, HttpResponse } = await import("msw");
    server.use(
      http.post("http://elastic.test:9200/_query", async ({ request }) => {
        const body = (await request.json()) as { query: string };
        if (body.query.includes("mandate-paypal-ops")) {
          return HttpResponse.json({ error: { type: "x" } }, { status: 500, headers: { "x-elastic-product": "Elasticsearch" } });
        }
        return HttpResponse.json(
          body.query.includes("cycle_minutes")
            ? { columns: [{ name: "agent_id", type: "keyword" }, { name: "cycles", type: "long" }, { name: "last_at", type: "date" }], values: [[a, 4, simNow.toISOString()]] }
            : { columns: [{ name: "none", type: "keyword" }], values: [] },
          { headers: { "x-elastic-product": "Elasticsearch" } },
        );
      }),
    );
    const report = await runDetectors(db, { worldId, simNow, now: new Date() });
    expect(report.errors.some((e) => e.startsWith("self_dealing:"))).toBe(true);
    expect(report.hits.score_farming).toBe(1);
    expect(report.newFlagIds).toHaveLength(1);
  });
});

describe("risk flag effect (deterministic)", () => {
  let db: Db;
  let worldId: string;

  beforeEach(async () => {
    vi.stubEnv("API_KEY_PEPPER", "test-pepper");
    db = await createTestDb();
    worldId = await createSimWorld(db);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("an open flag caps borrowing at T0 (risk_review → get_status), lending is unaffected, and it expires after 7 sim days", async () => {
    await fundPool(db, worldId, 100_000);
    const borrower = await createTestAgent(db, worldId, "b@example.com");
    const simNow = await getSimNow(db, worldId);
    const flagId = await recordRiskHit(
      db,
      worldId,
      { agentId: borrower.agentId, kind: "score_farming", evidence: { cycles_under_one_day: 3 }, evidenceSimAt: simNow },
      simNow,
    );
    expect(flagId).not.toBeNull();
    expect(await hasActiveRiskFlag(db, worldId, borrower.agentId)).toBe(true);

    const declined = await call(db, "apply_for_loan", borrower.key, { amount_cents: 2000, term_days: 14, purpose: "inventory" });
    expect(declined.envelope.status).toBe("DECLINED");
    expect(declined.envelope.reason_codes).toContain("risk_review");
    expect(declined.envelope.reason_codes).not.toContain("tier_per_loan");
    expect(declined.envelope.next_actions).toEqual([{ tool: "get_status", args: {} }]);

    const status = await call(db, "get_status", borrower.key, {});
    const risk = (status.envelope.data as Data).risk_review as { open: boolean; flags: Array<{ kind: string }> };
    expect(risk.open).toBe(true);
    expect(risk.flags[0]!.kind).toBe("score_farming");
    expect(status.envelope.summary).toContain("risk review");

    // Lending is unaffected.
    const buy = await call(db, "buy_notes", borrower.key, { amount_cents: 1000 });
    expect(buy.envelope.status).not.toBe("RISK_REVIEW");
    expect(buy.envelope.reason_codes ?? []).not.toContain("risk_review");

    // 7 sim days without new evidence → the flag no longer counts, and the tick clears it.
    await advanceClock(db, worldId, 8);
    const later = await getSimNow(db, worldId);
    expect(await hasActiveRiskFlag(db, worldId, borrower.agentId, later)).toBe(false);
    expect(await expireStaleRiskFlags(db, worldId, later)).toBe(1);
    const [flag] = await db.select().from(riskFlags).where(eq(riskFlags.id, flagId!));
    expect(flag!.status).toBe("cleared");
    expect(flag!.clearedBy).toBe("expired");
  });

  it("a flag raised after an offer blocks accepting it", async () => {
    await fundPool(db, worldId, 100_000);
    const borrower = await createTestAgent(db, worldId, "b@example.com");
    const applied = await call(db, "apply_for_loan", borrower.key, { amount_cents: 2000, term_days: 14, purpose: "inventory" });
    expect(applied.envelope.status).toBe("OFFERED");
    const data = applied.envelope.data as Data;
    const simNow = await getSimNow(db, worldId);
    await recordRiskHit(db, worldId, { agentId: borrower.agentId, kind: "probing", evidence: {}, evidenceSimAt: simNow }, simNow);
    const accepted = await call(db, "accept_offer", borrower.key, { offer_id: data.offer_id, disclosure_hash: data.disclosure_hash });
    expect(accepted.envelope.status).toBe("RISK_REVIEW");
    expect(accepted.envelope.next_actions).toEqual([{ tool: "get_status", args: {} }]);
  });

  it("owner: Request review on any world; clearing only in their own private world", async () => {
    const [owner] = await db
      .insert(principals)
      .values({ email: "o@example.com", name: "O", entityType: "individual", verifiedAt: new Date(), kycStatus: "verified" })
      .returning();
    const created = await createPrivateWorld(db, owner!.id, { name: "Sandbox" });
    expect(created.outcome).toBe("created");
    const privateWorldId = (created as { worldId: string }).worldId;
    const mk = async (wid: string) => {
      const [row] = await db
        .insert(agents)
        .values({ worldId: wid, principalId: owner!.id, name: "Mine", operator: "o", model: "m", codeManifestHash: "x", claimedAt: new Date() })
        .returning();
      const simNow = await getSimNow(db, wid);
      const flagId = await recordRiskHit(db, wid, { agentId: row!.id, kind: "velocity", evidence: {}, evidenceSimAt: simNow }, simNow);
      return { agentId: row!.id, flagId: flagId! };
    };
    const main = await mk(worldId);
    const sandbox = await mk(privateWorldId);

    expect(await requestRiskReview(db, { principalId: owner!.id, ...main, note: "  legit   payroll  " })).toBe("requested");
    const [noted] = await db.select().from(riskFlags).where(eq(riskFlags.id, main.flagId));
    expect(noted!.ownerNote).toBe("legit payroll");
    expect(noted!.status).toBe("open");

    expect(await clearRiskFlag(db, { by: "owner", principalId: owner!.id, ...main })).toBe("forbidden");
    expect(await clearRiskFlag(db, { by: "owner", principalId: owner!.id, ...sandbox })).toBe("cleared");
    expect(await clearRiskFlag(db, { by: "admin", worldId, flagId: main.flagId })).toBe("cleared");

    // Someone else's agent → not found.
    const [stranger] = await db.insert(principals).values({ email: "s@example.com", name: "S", entityType: "individual" }).returning();
    expect(await requestRiskReview(db, { principalId: stranger!.id, ...sandbox, note: "x" })).toBe("not_found");
  });
});
