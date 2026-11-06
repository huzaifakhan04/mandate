/**
 * P2 Task 4: standing mandates (Ruling P2-C). Versioned signing, revoking,
 * every mandate reason code at check/apply, the tier per-loan caps, the
 * mandate id + version in the hashed disclosure, and the accept-time
 * re-check (revoked, superseded, exposure risen across a principal's
 * agents — the sequential half of Review Focus 2; tests/pg has the
 * concurrent one).
 */
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Db } from "@/server/db/client";
import { agents, events, loans, mandates, principals } from "@/server/db/schema";
import { createTestDb } from "@/server/db/testing";
import { advanceClock } from "@/server/clock/clock";
import { disclosureHash } from "@/server/domain/disclosure";
import { agreementTextHash } from "@/server/domain/mandate";
import { hashIp, principalExposure, revokeMandate, signMandate } from "@/server/services/mandates";
import type { TestClaimOptions } from "@/server/services/testClaim";

import { signedCall, upgradeToTier2 } from "../../helpers/signing";
import { call, createSimWorld, createTestAgent, type Data, fundPool } from "../../helpers/world";

const SIGN_INPUT = {
  max_per_loan_cents: 20000,
  max_total_owed_cents: 40000,
  max_fee_bps: 1000,
  max_term_days: 30,
  eligible_collateral: ["none", "invoice_link"],
  typed_name: "Ada Lovelace",
  agree: true,
};

const APPLY = { amount_cents: 10000, term_days: 7, purpose: "Working capital" };

describe("mandates (P2 Task 4)", () => {
  let db: Db;
  let worldId: string;

  beforeEach(async () => {
    vi.stubEnv("SESSION_SECRET", "unit-test-session-secret-0123456789abcdef");
    vi.stubEnv("API_KEY_PEPPER", "test-pepper");
    db = await createTestDb();
    worldId = await createSimWorld(db);
    await fundPool(db, worldId, 100000);
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

  async function mandateRows(agentId: string) {
    return (await db.select().from(mandates).where(eq(mandates.agentId, agentId))).sort((a, b) => a.version - b.version);
  }

  describe("signing and revoking", () => {
    it("signing a new version supersedes the old one in the same transaction and records hash, name and IP hash", async () => {
      const agent = await createTestAgent(db, worldId);
      const signed = await signMandate(db, {
        principalId: agent.principalId,
        agentId: agent.agentId,
        input: SIGN_INPUT,
        ip: "203.0.113.9",
      });
      expect(signed.outcome).toBe("signed");

      const [v1, v2] = await mandateRows(agent.agentId);
      expect(v1).toMatchObject({ version: 1, status: "superseded" });
      expect(v1!.supersededAt).not.toBeNull();
      expect(v2).toMatchObject({
        version: 2,
        status: "signed",
        signerName: "Ada Lovelace",
        maxPerLoanCents: 20000n,
        maxTotalOwedCents: 40000n,
        maxFeeBps: 1000,
        maxTermDays: 30,
        eligibleCollateral: ["invoice_link", "none"],
        guaranteeTextHash: agreementTextHash(),
        ipHash: hashIp("203.0.113.9"),
      });
      expect(v2!.ipHash).not.toContain("203.0.113.9");
      expect(v2!.termsHash).toMatch(/^[0-9a-f]{64}$/);
      expect(v2!.signedAt).not.toBeNull();
      const signedEvents = await db.select().from(events).where(eq(events.type, "mandate.signed"));
      expect(signedEvents.map((e) => e.aggregateId)).toContain(v2!.id);
    });

    it("only the principal who claimed the agent can sign or revoke (others → not_found)", async () => {
      const agent = await createTestAgent(db, worldId);
      const stranger = await newPrincipal("STRANGER");
      expect(await signMandate(db, { principalId: stranger, agentId: agent.agentId, input: SIGN_INPUT, ip: null })).toEqual({
        outcome: "not_found",
      });
      expect(await revokeMandate(db, { principalId: stranger, agentId: agent.agentId })).toEqual({ outcome: "not_found" });
      expect(await mandateRows(agent.agentId)).toHaveLength(1);
    });

    it("invalid fields are rejected with every error", async () => {
      const agent = await createTestAgent(db, worldId);
      const result = await signMandate(db, {
        principalId: agent.principalId,
        agentId: agent.agentId,
        input: { ...SIGN_INPUT, max_fee_bps: -1, typed_name: "", agree: false },
        ip: null,
      });
      expect(result).toEqual({ outcome: "invalid", errors: ["max_fee_bps", "typed_name", "agree"] });
    });

    it("(agent_id, version) is unique", async () => {
      const agent = await createTestAgent(db, worldId);
      const [v1] = await mandateRows(agent.agentId);
      const copy: Partial<typeof v1> = { ...v1! };
      delete copy.id;
      delete copy.createdAt;
      await expect(
        db.insert(mandates).values({ ...(copy as typeof mandates.$inferInsert), status: "superseded" }),
      ).rejects.toThrow();
    });

    it("revoking stops borrowing (tier back to mandate_missing) but leaves existing loans untouched", async () => {
      const agent = await createTestAgent(db, worldId);
      const offer = (await call(db, "apply_for_loan", agent.key, APPLY)).envelope.data as Data;
      const accepted = await call(db, "accept_offer", agent.key, {
        offer_id: offer.offer_id,
        disclosure_hash: offer.disclosure_hash,
      });
      expect(accepted.envelope.status).toBe("ACTIVE");

      const revoked = await revokeMandate(db, { principalId: agent.principalId, agentId: agent.agentId });
      expect(revoked.outcome).toBe("revoked");
      expect(await revokeMandate(db, { principalId: agent.principalId, agentId: agent.agentId })).toEqual({
        outcome: "no_mandate",
      });
      const [row] = await mandateRows(agent.agentId);
      expect(row).toMatchObject({ status: "revoked" });

      const status = await call(db, "get_status", agent.key, {});
      expect(status.envelope.data).toMatchObject({ kya: { tier: 0, can_borrow: false, borrow_blockers: ["mandate_missing"] } });
      const [loan] = await db.select().from(loans).where(eq(loans.agentId, agent.agentId));
      expect(loan).toMatchObject({ status: "active", outstandingCents: 10150n });
    });
  });

  describe("enforcement at check_eligibility and apply_for_loan", () => {
    async function expectDeclined(
      limits: TestClaimOptions["limits"],
      input: Record<string, unknown>,
      reasons: string[],
    ) {
      const agent = await createTestAgent(db, worldId, "agent@example.com", { limits });
      const applied = await call(db, "apply_for_loan", agent.key, { ...APPLY, ...input });
      expect(applied.envelope.status).toBe("DECLINED");
      expect(applied.envelope.reason_codes).toEqual(reasons);
      return agent;
    }

    it("mandate_per_loan", async () => {
      const agent = await expectDeclined({ maxPerLoanCents: 5000n }, { amount_cents: 6000 }, ["mandate_per_loan"]);
      const check = await call(db, "check_eligibility", agent.key, { amount_cents: 6000, term_days: 7 });
      expect(check.envelope.data).toMatchObject({ eligible: false, reasons: ["mandate_per_loan"] });
    });

    it("mandate_total_owed (principal + fee counts)", async () => {
      await expectDeclined({ maxTotalOwedCents: 10000n }, {}, ["mandate_total_owed"]);
    });

    it("mandate_fee (fee as bps of the principal)", async () => {
      // 10000 for 7 days → fee 150 = 150 bps.
      await expectDeclined({ maxFeeBps: 149 }, {}, ["mandate_fee"]);
      const ok = await createTestAgent(db, worldId, "ok@example.com", { limits: { maxFeeBps: 150 } });
      expect((await call(db, "apply_for_loan", ok.key, APPLY)).envelope.status).toBe("OFFERED");
    });

    it("mandate_term", async () => {
      await expectDeclined({ maxTermDays: 7 }, { term_days: 14 }, ["mandate_term"]);
    });

    it("mandate_collateral (invoice-backed when only unsecured is eligible, and vice versa)", async () => {
      await expectDeclined(
        { eligibleCollateral: ["none"] },
        { invoice: { client_email: "client@example.com", amount_cents: 20000, due_in_days: 14, description: "Work" } },
        ["mandate_collateral"],
      );
      await expectDeclined({ eligibleCollateral: ["invoice_link"] }, {}, ["mandate_collateral"]);
    });

    it("mandate_missing: a claimed agent without a mandate is refused before any application", async () => {
      const agent = await createTestAgent(db, worldId);
      await revokeMandate(db, { principalId: agent.principalId, agentId: agent.agentId });
      const check = await call(db, "check_eligibility", agent.key, { amount_cents: 1000, term_days: 7 });
      expect((check.envelope.data as Data).reasons).toContain("mandate_missing");
      const applied = await call(db, "apply_for_loan", agent.key, APPLY);
      expect(applied.envelope).toMatchObject({ status: "MANDATE_REQUIRED", reason_codes: ["mandate_missing"] });
    });

    it("an expired mandate (real calendar time) → MANDATE_REQUIRED at apply, mandate_missing at check", async () => {
      const agent = await createTestAgent(db, worldId, "agent@example.com", {
        limits: { expiresAt: new Date(Date.now() - 1_000) },
      });
      const check = await call(db, "check_eligibility", agent.key, { amount_cents: 1000, term_days: 7 });
      expect((check.envelope.data as Data).reasons).toContain("mandate_missing");
      const applied = await call(db, "apply_for_loan", agent.key, APPLY);
      expect(applied.envelope).toMatchObject({ status: "MANDATE_REQUIRED", reason_codes: ["mandate_missing"] });
    });

    it("Ruling P2-D: mandate expiry follows the real calendar, not the world's simulated clock", async () => {
      const agent = await createTestAgent(db, worldId, "agent@example.com", {
        limits: { expiresAt: new Date(Date.now() + 2 * 86_400_000) },
      });
      // Seven simulated days later the mandate is still in force: two real days haven't passed.
      await advanceClock(db, worldId, 7);
      const applied = await call(db, "apply_for_loan", agent.key, APPLY);
      expect(applied.envelope.status).toBe("OFFERED");
    });

    it("tier caps: T1 may borrow ≤ 25000 per loan, T2 ≤ 50000 (min with the mandate's max_per_loan)", async () => {
      const t1 = await createTestAgent(db, worldId, "t1@example.com");
      expect((await call(db, "apply_for_loan", t1.key, { ...APPLY, amount_cents: 25000 })).envelope.status).toBe("OFFERED");
      const over = await call(db, "apply_for_loan", t1.key, { ...APPLY, amount_cents: 25001 });
      expect(over.envelope).toMatchObject({ status: "DECLINED", reason_codes: ["tier_per_loan"] });
      const check = await call(db, "check_eligibility", t1.key, { amount_cents: 30000, term_days: 7 });
      expect(check.envelope.data).toMatchObject({ eligible: false, reasons: ["tier_per_loan"], tier: 1 });

      const t2 = await createTestAgent(db, worldId, "t2@example.com");
      const key = await upgradeToTier2(db, t2.agentId, t2.key);
      const offered = await signedCall(db, "apply_for_loan", t2.key, { ...APPLY, amount_cents: 40000 }, key.privateKey);
      expect(offered.envelope.status).toBe("OFFERED");

      // The mandate's own cap still binds at T2.
      const capped = await createTestAgent(db, worldId, "t2b@example.com", { limits: { maxPerLoanCents: 30000n } });
      const cappedKey = await upgradeToTier2(db, capped.agentId, capped.key);
      const declined = await signedCall(db, "apply_for_loan", capped.key, { ...APPLY, amount_cents: 40000 }, cappedKey.privateKey);
      expect(declined.envelope).toMatchObject({ status: "DECLINED", reason_codes: ["mandate_per_loan"] });
    });

    it("check_eligibility shows the mandate limits and the principal's remaining headroom across their agents", async () => {
      const a = await createTestAgent(db, worldId, "a@example.com", { limits: { maxTotalOwedCents: 30000n } });
      const b = await createTestAgent(db, worldId, "b@example.com", {
        principalId: a.principalId,
        limits: { maxTotalOwedCents: 30000n, maxPerLoanCents: 20000n },
      });
      const offer = (await call(db, "apply_for_loan", a.key, APPLY)).envelope.data as Data;
      await call(db, "accept_offer", a.key, { offer_id: offer.offer_id, disclosure_hash: offer.disclosure_hash });
      expect(await principalExposure(db, worldId, a.principalId)).toBe(10150n);

      const check = await call(db, "check_eligibility", b.key, { amount_cents: 20000, term_days: 7 });
      expect(check.envelope.data).toMatchObject({
        eligible: false,
        reasons: ["mandate_total_owed"],
        mandate: {
          mandate_id: b.mandateId,
          version: 1,
          max_per_loan_cents: 20000,
          max_total_owed_cents: 30000,
          max_fee_bps: 10000,
          max_term_days: 365,
          eligible_collateral: ["invoice_link", "none"],
          expires_at: null,
          principal_total_owed_cents: 10150,
          total_owed_headroom_cents: 19850,
          per_loan_cap_cents: 20000,
        },
      });
      const fits = await call(db, "check_eligibility", b.key, { amount_cents: 19000, term_days: 7 });
      expect(fits.envelope.data).toMatchObject({ eligible: true, reasons: [] });
    });

    it("the offer's disclosure carries mandate_id + version, covered by the hash", async () => {
      const agent = await createTestAgent(db, worldId);
      const offer = (await call(db, "apply_for_loan", agent.key, APPLY)).envelope.data as Data;
      const disclosure = offer.disclosure as Data;
      expect(disclosure).toMatchObject({ mandate_id: agent.mandateId, mandate_version: 1 });
      expect(offer.disclosure_hash).toBe(disclosureHash(disclosure));
      expect(disclosureHash({ ...disclosure, mandate_version: 2 })).not.toBe(offer.disclosure_hash);
    });
  });

  describe("accept_offer re-checks the mandate under the series lock", () => {
    it("revoked after the offer → 409 MANDATE_REVOKED, no loan", async () => {
      const agent = await createTestAgent(db, worldId);
      const offer = (await call(db, "apply_for_loan", agent.key, APPLY)).envelope.data as Data;
      await revokeMandate(db, { principalId: agent.principalId, agentId: agent.agentId });
      const accepted = await call(db, "accept_offer", agent.key, {
        offer_id: offer.offer_id,
        disclosure_hash: offer.disclosure_hash,
      });
      expect(accepted.httpStatus).toBe(409);
      expect(accepted.envelope).toMatchObject({ status: "MANDATE_REVOKED", reason_codes: ["mandate_revoked"] });
      expect(await db.select().from(loans).where(eq(loans.agentId, agent.agentId))).toEqual([]);
    });

    it("superseded by a new version after the offer → 409 MANDATE_REVOKED (mandate_superseded); a fresh apply works", async () => {
      const agent = await createTestAgent(db, worldId);
      const offer = (await call(db, "apply_for_loan", agent.key, APPLY)).envelope.data as Data;
      await signMandate(db, { principalId: agent.principalId, agentId: agent.agentId, input: SIGN_INPUT, ip: null });
      const accepted = await call(db, "accept_offer", agent.key, {
        offer_id: offer.offer_id,
        disclosure_hash: offer.disclosure_hash,
      });
      expect(accepted.httpStatus).toBe(409);
      expect(accepted.envelope).toMatchObject({ status: "MANDATE_REVOKED", reason_codes: ["mandate_superseded"] });

      const fresh = (await call(db, "apply_for_loan", agent.key, APPLY)).envelope.data as Data;
      expect((fresh.disclosure as Data).mandate_version).toBe(2);
      const ok = await call(db, "accept_offer", agent.key, { offer_id: fresh.offer_id, disclosure_hash: fresh.disclosure_hash });
      expect(ok.envelope.status).toBe("ACTIVE");
    });

    it("exposure rose since the offer (another agent of the same principal borrowed) → 400 MANDATE_LIMIT", async () => {
      const a = await createTestAgent(db, worldId, "a@example.com", { limits: { maxTotalOwedCents: 15000n } });
      const b = await createTestAgent(db, worldId, "b@example.com", {
        principalId: a.principalId,
        limits: { maxTotalOwedCents: 15000n },
      });
      // Both offers fit on their own (10150 ≤ 15000); together they don't.
      const offerA = (await call(db, "apply_for_loan", a.key, APPLY)).envelope.data as Data;
      const offerB = (await call(db, "apply_for_loan", b.key, APPLY)).envelope.data as Data;
      expect(offerB.offer_id).toBeDefined();

      const acceptA = await call(db, "accept_offer", a.key, { offer_id: offerA.offer_id, disclosure_hash: offerA.disclosure_hash });
      expect(acceptA.envelope.status).toBe("ACTIVE");
      const acceptB = await call(db, "accept_offer", b.key, { offer_id: offerB.offer_id, disclosure_hash: offerB.disclosure_hash });
      expect(acceptB.httpStatus).toBe(400);
      expect(acceptB.envelope).toMatchObject({ status: "MANDATE_LIMIT", reason_codes: ["mandate_total_owed"] });
      expect(acceptB.envelope.data).toMatchObject({ principal_total_owed_cents: 10150, max_total_owed_cents: 15000 });
      expect(await db.select().from(loans).where(eq(loans.agentId, b.agentId))).toEqual([]);
    });

    it("a mandate that expired (real calendar time) after the offer → 409 MANDATE_REVOKED, no loan", async () => {
      const agent = await createTestAgent(db, worldId, "agent@example.com", {
        limits: { expiresAt: new Date(Date.now() + 60 * 60_000) },
      });
      const offer = (await call(db, "apply_for_loan", agent.key, APPLY)).envelope.data as Data;
      expect(offer.offer_id).toBeDefined();
      // Real time passes the mandate's expires_at (simulated by moving it into the past).
      await db
        .update(mandates)
        .set({ expiresAt: new Date(Date.now() - 1_000) })
        .where(eq(mandates.id, agent.mandateId));
      const accepted = await call(db, "accept_offer", agent.key, {
        offer_id: offer.offer_id,
        disclosure_hash: offer.disclosure_hash,
      });
      expect(accepted.httpStatus).toBe(409);
      expect(accepted.envelope).toMatchObject({ status: "MANDATE_REVOKED", reason_codes: ["mandate_revoked"] });
      expect(await db.select().from(loans).where(eq(loans.agentId, agent.agentId))).toEqual([]);
    });

    it("principalExposure counts a DISBURSING loan at principal + fee (nothing outstanding yet)", async () => {
      // A "pending" receiver gets a live-shaped payout response, so the loan stays DISBURSING.
      const a = await createTestAgent(db, worldId, "pending@example.com", { limits: { maxTotalOwedCents: 15000n } });
      const offer = (await call(db, "apply_for_loan", a.key, APPLY)).envelope.data as Data;
      const accepted = await call(db, "accept_offer", a.key, { offer_id: offer.offer_id, disclosure_hash: offer.disclosure_hash });
      expect(accepted.envelope.status).toBe("DISBURSING");
      const [loan] = await db.select().from(loans).where(eq(loans.agentId, a.agentId));
      expect(loan).toMatchObject({ status: "disbursing", outstandingCents: 0n });
      expect(await principalExposure(db, worldId, a.principalId)).toBe(10150n);

      // …and it counts against the principal's other agents.
      const b = await createTestAgent(db, worldId, "b@example.com", {
        principalId: a.principalId,
        limits: { maxTotalOwedCents: 15000n },
      });
      const applied = await call(db, "apply_for_loan", b.key, APPLY);
      expect(applied.envelope).toMatchObject({ status: "DECLINED", reason_codes: ["mandate_total_owed"] });
    });

    it("exposure is per principal: another principal's loans don't count", async () => {
      const a = await createTestAgent(db, worldId, "a@example.com", { limits: { maxTotalOwedCents: 15000n } });
      const c = await createTestAgent(db, worldId, "c@example.com", { limits: { maxTotalOwedCents: 15000n } });
      const offerA = (await call(db, "apply_for_loan", a.key, APPLY)).envelope.data as Data;
      const offerC = (await call(db, "apply_for_loan", c.key, APPLY)).envelope.data as Data;
      await call(db, "accept_offer", a.key, { offer_id: offerA.offer_id, disclosure_hash: offerA.disclosure_hash });
      const acceptC = await call(db, "accept_offer", c.key, { offer_id: offerC.offer_id, disclosure_hash: offerC.disclosure_hash });
      expect(acceptC.envelope.status).toBe("ACTIVE");
      const [owner] = await db.select().from(agents).where(and(eq(agents.id, c.agentId))!);
      expect(owner!.principalId).not.toBe(a.principalId);
    });
  });
});
