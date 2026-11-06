/**
 * P2 Task 5: the owner dashboard read model. One principal sees exactly
 * their claimed agents (Review Focus 3: another principal's agent is
 * absent from the cards and its drawer is `null`), the summary strip
 * (owed across agents, mandate ceiling, agents active), and the drawer's
 * mandate / documents / keys / loans / notes / events.
 */
import { createHash } from "crypto";

import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Db } from "@/server/db/client";
import { agents, principals } from "@/server/db/schema";
import { createTestDb } from "@/server/db/testing";
import type { TierResult } from "@/server/domain/kya";
import { agentDetail, displayStatus, keyFingerprint, ownerDashboard } from "@/server/services/dashboard";
import { registerOwnedAgent, setAgentFrozen } from "@/server/services/owner";
import { revokeMandate } from "@/server/services/mandates";

import { upgradeToTier2 } from "../../helpers/signing";
import { call, createSimWorld, createTestAgent, type Data, fundPool } from "../../helpers/world";

const APPLY = { amount_cents: 10000, term_days: 7, purpose: "Working capital" };

describe("dashboard read model (P2 Task 5)", () => {
  let db: Db;
  let worldId: string;

  beforeEach(async () => {
    vi.stubEnv("SESSION_SECRET", "unit-test-session-secret-0123456789abcdef");
    vi.stubEnv("API_KEY_PEPPER", "test-pepper");
    db = await createTestDb();
    worldId = await createSimWorld(db);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function newPrincipal(name: string): Promise<string> {
    const [row] = await db
      .insert(principals)
      .values({ paypalPayerId: name, email: `${name}@example.com`, name, entityType: "individual", verifiedAt: new Date() })
      .returning();
    return row!.id;
  }

  it("a principal with no agents sees an empty dashboard", async () => {
    const nobody = await newPrincipal("NOBODY");
    expect(await ownerDashboard(db, nobody)).toEqual({
      summary: { owedCents: 0n, mandateCeilingCents: null, activeAgents: 0, totalAgents: 0 },
      agents: [],
    });
  });

  it("shows only the principal's own agents; another principal's agent has no drawer", async () => {
    const lender = await fundPool(db, worldId, 100000);
    const a = await createTestAgent(db, worldId, "a@example.com", { limits: { maxTotalOwedCents: 60000n } });
    const b = await createTestAgent(db, worldId, "b@example.com", { principalId: a.principalId });
    const stranger = await createTestAgent(db, worldId, "s@example.com");

    // a borrows; b's mandate is revoked (pending); stranger borrows too.
    const offer = (await call(db, "apply_for_loan", a.key, APPLY)).envelope.data as Data;
    expect((await call(db, "accept_offer", a.key, { offer_id: offer.offer_id, disclosure_hash: offer.disclosure_hash })).envelope.status).toBe(
      "ACTIVE",
    );
    await revokeMandate(db, { principalId: a.principalId, agentId: b.agentId });
    const sOffer = (await call(db, "apply_for_loan", stranger.key, APPLY)).envelope.data as Data;
    await call(db, "accept_offer", stranger.key, { offer_id: sOffer.offer_id, disclosure_hash: sOffer.disclosure_hash });

    const dash = await ownerDashboard(db, a.principalId);
    expect(dash.agents.map((card) => card.id).sort()).toEqual([a.agentId, b.agentId].sort());
    expect(dash.agents.map((card) => card.id)).not.toContain(stranger.agentId);
    expect(dash.agents.map((card) => card.id)).not.toContain(lender.agentId);
    // Owed = a's one loan at its outstanding (10000 + fee); the stranger's loan doesn't count.
    expect(dash.summary.owedCents).toBe(10150n);
    expect(dash.summary.mandateCeilingCents).toBe(60000n);
    expect(dash.summary).toMatchObject({ activeAgents: 1, totalAgents: 2 });

    const cardA = dash.agents.find((card) => card.id === a.agentId)!;
    expect(cardA).toMatchObject({ display: "active", perLoanCapCents: 25000n, hasSigningKey: false });
    expect(cardA.tier.tier).toBe(1);
    // P3 Task 1: the card carries the Agent Credit Score (ring + grade).
    expect(cardA.credit.components).toMatchObject({ identity: 10, history: 0, collateral: 0 });
    expect(cardA.credit.score).toBe(Object.values(cardA.credit.components).reduce((sum, points) => sum + points, 0));
    expect(cardA.credit.factors).toHaveLength(3);
    expect(cardA.openLoan).toMatchObject({ status: "active", principalCents: 10000n, termDays: 7, outstandingCents: 10150n });
    const cardB = dash.agents.find((card) => card.id === b.agentId)!;
    expect(cardB).toMatchObject({ display: "pending", perLoanCapCents: 0n, mandate: null, openLoan: null });

    // Review Focus 3: the drawer for someone else's agent, an unknown or a malformed id is null.
    expect(await agentDetail(db, a.principalId, stranger.agentId)).toBeNull();
    expect(await agentDetail(db, stranger.principalId, a.agentId)).toBeNull();
    expect(await agentDetail(db, a.principalId, crypto.randomUUID())).toBeNull();
    expect(await agentDetail(db, a.principalId, "x' or 1=1 --")).toBeNull();
  });

  it("the drawer carries the mandate, loans, events, documents, keys and notes", async () => {
    const lender = await fundPool(db, worldId, 100000);
    const a = await createTestAgent(db, worldId);
    const offer = (await call(db, "apply_for_loan", a.key, APPLY)).envelope.data as Data;
    await call(db, "accept_offer", a.key, { offer_id: offer.offer_id, disclosure_hash: offer.disclosure_hash });
    const signing = await upgradeToTier2(db, a.agentId, a.key);

    const detail = (await agentDetail(db, a.principalId, a.agentId))!;
    expect(detail.tier.tier).toBe(2);
    expect(detail.credit.components.identity).toBe(25);
    expect(detail.currentMandate).toMatchObject({ version: 1, status: "signed" });
    expect(detail.mandateHistory.map((m) => m.version)).toEqual([1]);
    expect(detail.documents).toHaveLength(1);
    expect(detail.documents[0]).toMatchObject({ reviewStatus: "approved", contentType: "application/pdf" });
    expect(detail.documents[0]).not.toHaveProperty("content");
    expect(detail.signingKey!.fingerprint).toBe(
      createHash("sha256").update(Buffer.from(signing.rawB64, "base64")).digest("hex").slice(0, 16),
    );
    expect(detail.apiKey!.prefix).toBe(a.key.split("_")[1]);
    expect(detail.loans).toHaveLength(1);
    expect(detail.loans[0]).toMatchObject({ principalCents: 10000n, feeCents: 150n, totalDueCents: 10150n, collateral: "none" });
    expect(detail.loans[0]!.dayOfTerm).toBe(0);
    const types = detail.events.map((event) => event.type);
    expect(types).toEqual(expect.arrayContaining(["mandate.signed", "loan.offered", "loan.accepted"]));
    // Newest first.
    expect(types.indexOf("loan.accepted")).toBeLessThan(types.indexOf("loan.offered"));
    expect(detail.payoutMasked).toBe("a***@example.com");

    // A lender's drawer lists its note position.
    const [lenderRow] = await db.select().from(agents).where(eq(agents.id, lender.agentId));
    const lenderDetail = (await agentDetail(db, lenderRow!.principalId!, lender.agentId))!;
    expect(lenderDetail.notes).toHaveLength(1);
    expect(lenderDetail.notes[0]).toMatchObject({ costCents: 100000n, seriesName: "Mandate Pool A" });
  });

  it("path B agents appear (main world) alongside sim-world ones; frozen shows as frozen", async () => {
    const owner = await createTestAgent(db, worldId);
    const registered = await registerOwnedAgent(db, owner.principalId, {
      name: "Nova",
      operator: "Studio",
      model: "Claude",
      payoutEmail: "nova@example.com",
    });
    expect(registered.worldId).not.toBe(worldId);
    let dash = await ownerDashboard(db, owner.principalId);
    expect(dash.agents.map((card) => card.name)).toEqual(["PG Agent", "Nova"]);
    expect(dash.agents[1]).toMatchObject({ display: "pending", worldId: registered.worldId });

    expect(await setAgentFrozen(db, { principalId: owner.principalId, agentId: owner.agentId, frozen: true })).toBe("frozen");
    dash = await ownerDashboard(db, owner.principalId);
    expect(dash.agents[0]).toMatchObject({ display: "frozen" });
    expect(dash.summary.activeAgents).toBe(0);
  });

  it("displayStatus and keyFingerprint", () => {
    const tier = (hasCurrentMandate: boolean): TierResult => ({
      tier: hasCurrentMandate ? 1 : 0,
      claimed: true,
      hasCurrentMandate,
      borrowBlockers: [],
      nextTierRequirements: [],
      maxPerLoanCents: 0,
    });
    expect(displayStatus("active", tier(true))).toBe("active");
    expect(displayStatus("active", tier(false))).toBe("pending");
    expect(displayStatus("frozen", tier(true))).toBe("frozen");
    expect(displayStatus("revoked", tier(true))).toBe("revoked");
    expect(displayStatus("restricted", tier(true))).toBe("restricted");
    expect(keyFingerprint(Buffer.alloc(32, 1).toString("base64"))).toMatch(/^[0-9a-f]{16}$/);
  });
});
