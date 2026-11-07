/**
 * P7 Task 1 — the Elastic outbox (`elastic/ship.ts`) against a fake
 * Elasticsearch (msw): the right documents go to the right index, no PII
 * leaves the bank (no emails, payer ids, payout receivers, principal ids,
 * API keys, raw PayPal bodies), the per-world watermark only moves past
 * accepted documents, the 500-per-world budget holds, and with Elastic
 * unconfigured nothing is sent at all.
 */
import { eq } from "drizzle-orm";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { Db } from "@/server/db/client";
import {
  agents,
  applications,
  elasticCursors,
  events,
  loans,
  offers,
  paypalOperations,
  principals,
  repaymentLinks,
} from "@/server/db/schema";
import { createTestDb } from "@/server/db/testing";
import { hashId } from "@/server/elastic/config";
import { shipWorld } from "@/server/elastic/ship";
import { createWorld } from "@/server/services/worlds";

import { captureBulk, stubElastic, unstubElastic } from "../../helpers/elastic";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const OWNER_PAYER = "QX7PAYER9KZ2M";
const RECEIVER = "secret.receiver@example.com";
const LATER = new Date(Date.now() + 120_000);

async function seed(db: Db) {
  const { worldId } = await createWorld(db, { name: "Ship World", ownerPrincipalId: null, railMode: "sim" });
  const [principal] = await db
    .insert(principals)
    .values({ email: "owner.private@example.com", name: "Owner Person", entityType: "individual", paypalPayerId: OWNER_PAYER })
    .returning();
  const [agent] = await db
    .insert(agents)
    .values({
      worldId,
      principalId: principal!.id,
      name: "Ship Agent owner.private@example.com",
      operator: "op",
      model: "m",
      codeManifestHash: "x",
      status: "active",
      payoutReceiver: RECEIVER,
      payoutReceiverType: "email",
      claimedAt: new Date(),
    })
    .returning();
  const [app] = await db
    .insert(applications)
    .values({
      worldId,
      agentId: agent!.id,
      amountCents: 5000n,
      termDays: 14,
      purpose: `GPU credits; invoice to client@example.com, key mnd_live_abc123, payer ${OWNER_PAYER}, see https://evil.example/x`,
      invoiceRef: { client_email: "client@example.com", amount_cents: 9000 },
      status: "declined",
      decision: "declined",
      reasonCodes: ["score_too_low", "not_a_code"],
      adverseAction: { score: 30, grade: "E" },
    })
    .returning();
  await db.insert(events).values({
    worldId,
    type: "loan.declined",
    aggregateType: "application",
    aggregateId: app!.id,
    payload: { reasons: ["score_too_low"], primary: "score_too_low", score: 30, grade: "E", email: "leak@example.com" },
    occurredSimAt: new Date("2026-03-01T10:00:00Z"),
  });
  const [offer] = await db
    .insert(offers)
    .values({
      worldId,
      applicationId: app!.id,
      principalCents: 5000n,
      feeCents: 100n,
      aprBps: 1000,
      termDays: 14,
      dueSimAt: new Date(),
      disclosureHash: "h",
      expiresSimAt: new Date(),
    })
    .returning();
  const [loan] = await db
    .insert(loans)
    .values({ worldId, offerId: offer!.id, agentId: agent!.id, principalId: principal!.id, principalCents: 5000n, feeCents: 100n, outstandingCents: 5100n, dueSimAt: new Date() })
    .returning();
  const orderId = "SIMORDER-1";
  await db.insert(paypalOperations).values({
    worldId,
    rail: "sim",
    kind: "order.create",
    requestId: "req-1",
    paypalId: orderId,
    status: "succeeded",
    purpose: "repayment_link",
    sourceId: loan!.id,
    request: { body: { purchase_units: [{ amount: { currency_code: "USD", value: "90.00" } }], payer: { email_address: "client@example.com" } } },
    response: { orderId, status: "APPROVED", approveUrl: "https://sim/approve" },
    simState: { orderId, status: "APPROVED", payer: { payerId: OWNER_PAYER, email: "client@example.com", givenName: "A", surname: "B" } },
  });
  await db.insert(repaymentLinks).values({ worldId, loanId: loan!.id, kind: "invoice", amountCents: 9000n, paypalOrderId: orderId });
  return { worldId, principalId: principal!.id, agentId: agent!.id, appId: app!.id, loanId: loan!.id };
}

describe("Elastic outbox (P7 Task 1)", () => {
  let db: Db;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    unstubElastic();
  });

  it("is a no-op (no request at all) when Elastic is not configured", async () => {
    unstubElastic();
    const { worldId } = await seed(db);
    // onUnhandledFrame: 'error' — any request would fail the test.
    expect(await shipWorld(db, worldId, { now: LATER })).toBeNull();
  });

  it("ships every stream to its index with hashed identities and no PII", async () => {
    stubElastic();
    const bulk = captureBulk(server);
    const seeded = await seed(db);
    const report = await shipWorld(db, seeded.worldId, { now: LATER });
    expect(report?.errors).toEqual([]);
    const docs = bulk.docs();
    const byIndex = (index: string) => docs.filter((d) => d.index === index);

    const app = byIndex("mandate-applications")[0]!.doc;
    expect(app.purpose).toBe(app.purpose_text);
    expect(app.purpose).toContain("GPU credits");
    expect(app.reasons).toEqual(["score_too_low"]);
    expect(app.decision).toBe("declined");
    expect(app.has_invoice).toBe(true);
    expect(app.sim_at).toBe("2026-03-01T10:00:00.000Z"); // the decision's exact sim time (its event)
    expect(app.principal_hash).toBe(hashId(seeded.principalId));

    const declined = byIndex("mandate-events").find((d) => d.doc.type === "loan.declined")!.doc;
    expect(declined.agent_id).toBe(seeded.agentId);
    expect(declined.reasons).toEqual(["score_too_low"]);
    expect(byIndex("mandate-events").some((d) => d.doc.type === "agent.registered")).toBe(true);

    const op = byIndex("mandate-paypal-ops")[0]!.doc;
    expect(op.loan_id).toBe(seeded.loanId);
    expect(op.agent_id).toBe(seeded.agentId);
    expect(op.amount_cents).toBe(9000);
    // Self-dealing is visible only as equal hashes.
    expect(op.payer_hash).toBe(hashId(OWNER_PAYER));
    expect(op.borrower_payer_hash).toBe(op.payer_hash);

    const wire = JSON.stringify(bulk.requests);
    expect(wire).not.toContain("@");
    expect(wire).not.toContain(OWNER_PAYER);
    expect(wire).not.toContain(RECEIVER);
    expect(wire).not.toContain(seeded.principalId);
    expect(wire).not.toContain("mnd_live");
    expect(wire).not.toContain("evil.example");
    expect(wire).not.toContain("approve");
    expect(wire).not.toContain("purchase_units");
  });

  it("advances the watermark only past accepted documents and never re-ships", async () => {
    stubElastic();
    const seeded = await seed(db);
    // A whole-bulk failure: nothing accepted, cursor stays, error recorded.
    captureBulk(server, { status: 503 });
    const failed = await shipWorld(db, seeded.worldId, { now: LATER });
    expect(failed?.total).toBe(0);
    expect(failed?.errors[0]).toMatch(/^agents:/);
    const [cursor] = await db.select().from(elasticCursors).where(eq(elasticCursors.worldId, seeded.worldId));
    expect(cursor?.cursorAt).toBeNull();
    expect(cursor?.lastError).toMatch(/503/);

    server.resetHandlers();
    const bulk = captureBulk(server);
    const first = await shipWorld(db, seeded.worldId, { now: LATER });
    expect(first?.total).toBe(4); // agent, event, application, paypal op
    const again = await shipWorld(db, seeded.worldId, { now: LATER });
    expect(again?.total).toBe(0);
    expect(bulk.requests.length).toBe(4);
  });

  it("a rejected item stops the stream at that item", async () => {
    stubElastic();
    const seeded = await seed(db);
    // Two more agents so the agents stream has 3 docs; the second is rejected.
    for (const name of ["b", "c"]) {
      await db.insert(agents).values({ worldId: seeded.worldId, name, operator: "o", model: "m", codeManifestHash: "x" });
    }
    captureBulk(server, { failAt: 1 });
    const report = await shipWorld(db, seeded.worldId, { now: LATER });
    expect(report?.shipped.agents).toBe(1);
    expect(report?.errors[0]).toContain("document_parsing_exception");
  });

  it("ships at most the budget per world per tick, oldest first, and resumes after it", async () => {
    stubElastic();
    const bulk = captureBulk(server);
    const seeded = await seed(db);
    const first = await shipWorld(db, seeded.worldId, { now: LATER, budget: 2 });
    expect(first?.total).toBe(2);
    const second = await shipWorld(db, seeded.worldId, { now: LATER, budget: 2 });
    expect(second?.total).toBe(2);
    const ids = bulk.docs().map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("waits for rows younger than the settle window", async () => {
    stubElastic();
    captureBulk(server);
    const seeded = await seed(db);
    const report = await shipWorld(db, seeded.worldId, { now: new Date() });
    expect(report?.total).toBe(0);
  });
});
