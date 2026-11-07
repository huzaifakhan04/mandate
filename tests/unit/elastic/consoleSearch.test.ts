/**
 * P7 Task 4/5 — the console's Risk Desk: the snapshot's Risk panel (open
 * flags by kind; a note when Elastic is off) and `GET /api/console/search`
 * (hybrid: semantic over application purposes + keyword over events) —
 * world-scoped like the snapshot, no-store, rate limited, scrubbed. And the
 * tick: with Elastic configured it ships and runs the detectors; without,
 * nothing touches the network.
 */
import { eq } from "drizzle-orm";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createConsoleHandlers, SEARCH_BURST } from "@/server/auth/consoleRoutes";
import { SESSION_COOKIE_NAME, createSession } from "@/server/auth/session";
import { getSimNow } from "@/server/clock/clock";
import type { Db } from "@/server/db/client";
import { agents, elasticCursors, principals, riskFlags } from "@/server/db/schema";
import { createTestDb } from "@/server/db/testing";
import { createTokenBucket } from "@/server/http/rateLimit";
import { runTick } from "@/server/jobs/tick";
import { consoleSnapshot, resolveConsoleWorld } from "@/server/services/console";
import { createPrivateWorld } from "@/server/services/privateWorlds";
import { recordRiskHit } from "@/server/services/riskFlags";
import { ensureMainWorld } from "@/server/services/worlds";

import { captureBulk, fakeEsql, fakeSearch, stubElastic, unstubElastic } from "../../helpers/elastic";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("console Risk Desk (P7)", () => {
  let db: Db;
  let mainWorldId: string;
  let agentId: string;

  beforeEach(async () => {
    vi.stubEnv("SESSION_SECRET", "unit-test-session-secret-0123456789abcdef");
    vi.stubEnv("API_KEY_PEPPER", "test-pepper");
    db = await createTestDb();
    mainWorldId = (await ensureMainWorld(db)).worldId;
    const [agent] = await db
      .insert(agents)
      .values({ worldId: mainWorldId, name: "Probe bob@corp.example", operator: "o", model: "m", codeManifestHash: "x" })
      .returning();
    agentId = agent!.id;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    unstubElastic();
  });

  function handlers() {
    return createConsoleHandlers({ getDb: async () => db });
  }

  it("snapshot: the Risk panel counts open flags by kind; without Elastic it says the desk is offline", async () => {
    unstubElastic();
    const simNow = await getSimNow(db, mainWorldId);
    await recordRiskHit(db, mainWorldId, { agentId, kind: "probing", evidence: { secret: "x@y.z" }, evidenceSimAt: simNow }, simNow);
    const world = await resolveConsoleWorld(db, null, "main");
    const snapshot = await consoleSnapshot(db, world!);
    expect(snapshot.risk.enabled).toBe(false);
    expect(snapshot.risk.note).toMatch(/Elastic is not configured/);
    expect(snapshot.risk.open).toBe(1);
    expect(snapshot.risk.byKind.find((k) => k.kind === "probing")!.open).toBe(1);
    expect(snapshot.risk.recent[0]).toMatchObject({ kind: "probing", status: "open", recommendation: null, agent: "Probe [redacted]" });
    expect(JSON.stringify(snapshot.risk)).not.toContain("@");
  });

  it("search without Elastic: a disabled note, no network", async () => {
    unstubElastic();
    const res = await handlers().search(new Request("http://localhost/api/console/search?world=main&q=gpu"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { result: { enabled: boolean; note: string } };
    expect(body.result).toMatchObject({ enabled: false });
    expect(body.result.note).toMatch(/offline/);
  });

  it("search: semantic over applications (with the Jina reranker) + keyword over events, world-filtered and scrubbed", async () => {
    stubElastic();
    const appSearches = fakeSearch(server, "mandate-applications", [
      { application_id: "11111111-1111-4111-8111-111111111111", agent_id: agentId, decision: "declined", amount_cents: 50000, term_days: 14, reasons: ["score_too_low"], purpose_text: "GPU credits for a client", sim_at: "2026-01-02T00:00:00Z" },
    ]);
    const eventSearches = fakeSearch(server, "mandate-events", [{ type: "loan.declined", agent_id: agentId, amount_cents: null, reasons: ["score_too_low"], sim_at: "2026-01-02T00:00:00Z" }]);
    const res = await handlers().search(new Request("http://localhost/api/console/search?world=main&q=gpu%20compute%20bob%40corp.example"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { applications: Array<Record<string, unknown>>; events: Array<Record<string, unknown>>; query: string } };
    expect(body.result.applications[0]).toMatchObject({ agent: "Probe [redacted]", decision: "declined", purpose: "GPU credits for a client", label: "A-111111" });
    expect(body.result.events[0]).toMatchObject({ type: "loan.declined", agent: "Probe [redacted]" });
    // The query itself is scrubbed before it leaves the bank.
    expect(body.result.query).not.toContain("@");
    const appQuery = JSON.stringify(appSearches[0]);
    expect(appQuery).toContain(".jina-reranker-v3");
    expect(appQuery).toContain(`"world_id":"${mainWorldId}"`);
    expect(appQuery).not.toContain("corp.example");
    expect(JSON.stringify(eventSearches[0])).toContain(`"world_id":"${mainWorldId}"`);
    expect(JSON.stringify(body)).not.toContain("@");
    expect(JSON.stringify(body)).not.toContain(agentId);
  });

  it("search: private worlds only for their owner (404 otherwise), long queries 400, rate limited 429", async () => {
    stubElastic();
    const [owner] = await db
      .insert(principals)
      .values({ email: "o@example.com", name: "O", entityType: "individual", verifiedAt: new Date(), kycStatus: "verified" })
      .returning();
    const created = await createPrivateWorld(db, owner!.id, { name: "Sandbox" });
    const worldId = (created as { worldId: string }).worldId;
    const h = createConsoleHandlers({ getDb: async () => db, searchLimiter: createTokenBucket({ capacity: SEARCH_BURST, refillPerSecond: 0.0001 }) });
    expect((await h.search(new Request(`http://localhost/api/console/search?world=${worldId}&q=a`))).status).toBe(404);
    const cookie = `${SESSION_COOKIE_NAME}=${encodeURIComponent(createSession(owner!.id))}`;
    const ok = await h.search(new Request(`http://localhost/api/console/search?world=${worldId}&q=a`, { headers: { cookie } }));
    expect(ok.status).toBe(200); // q shorter than 2 chars: no Elastic call
    expect((await h.search(new Request(`http://localhost/api/console/search?world=main&q=${"x".repeat(201)}`))).status).toBe(400);
    let last = 200;
    for (let i = 0; i < SEARCH_BURST + 1; i += 1) {
      last = (await h.search(new Request("http://localhost/api/console/search?world=main&q=a"))).status;
    }
    expect(last).toBe(429);
  });

  it("tick: with Elastic it ships, runs the detectors hourly and investigates new flags; without, no network", async () => {
    unstubElastic();
    const quiet = await runTick(db);
    expect(quiet.riskShipped).toBe(0);

    stubElastic();
    vi.stubEnv("OPENAI_API_KEY", "");
    const bulk = captureBulk(server);
    fakeEsql(server, [{ includes: "cycle_minutes < 1440", rows: [{ cycles: 3, loans: [], last_at: new Date(0).toISOString(), agent_id: agentId }] }]);
    const later = new Date(Date.now() + 120_000);
    const report = await runTick(db, { now: later });
    expect(report.riskShipped).toBeGreaterThan(0);
    expect(bulk.docs().some((d) => d.doc.type === "agent.registered")).toBe(true);
    // Evidence from sim time 0 is far older than 7 sim days → no flag.
    expect(report.riskFlags).toBe(0);
    const [detectorCursor] = (await db.select().from(elasticCursors).where(eq(elasticCursors.worldId, mainWorldId))).filter((c) => c.stream === "detectors");
    expect(detectorCursor?.cursorAt).not.toBeNull();

    // Within the hour the detectors don't run again; once it has passed they do.
    server.resetHandlers();
    captureBulk(server);
    const simNow = await getSimNow(db, mainWorldId, new Date(later.getTime() + 61 * 60_000));
    const esql = fakeEsql(server, [{ includes: "cycle_minutes < 1440", rows: [{ cycles: 3, loans: [], last_at: simNow.toISOString(), agent_id: agentId }] }]);
    await runTick(db, { now: new Date(later.getTime() + 60_000) });
    expect(esql).toHaveLength(0);
    const hourLater = await runTick(db, { now: new Date(later.getTime() + 61 * 60_000) });
    expect(esql.length).toBeGreaterThan(0);
    expect(hourLater.riskFlags).toBe(1);
    expect(hourLater.riskInvestigated).toBe(1);
    const [flag] = await db.select().from(riskFlags).where(eq(riskFlags.worldId, mainWorldId));
    expect(flag!.caseFile).not.toBeNull();
  });
});
