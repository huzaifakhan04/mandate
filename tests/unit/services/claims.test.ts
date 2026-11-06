import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Db } from "@/server/db/client";
import { agents, idempotencyKeys, principals, worlds } from "@/server/db/schema";
import { createTestDb } from "@/server/db/testing";
import { CLAIM_TTL_MS, claimAgent, claimView, hashClaimToken, lookupClaim } from "@/server/services/claims";
import { revokeMandate, signMandate as signMandateService } from "@/server/services/mandates";
import { ensureMainWorldOnce } from "@/server/services/worlds";

import { claimAndMandate } from "../../helpers/kya";
import { call, fundPool, type Data } from "../../helpers/world";

const BASE = "https://mandate.test";

async function verifiedPrincipal(db: Db, payerId: string, verified = true): Promise<string> {
  const [row] = await db
    .insert(principals)
    .values({
      paypalPayerId: payerId,
      email: `${payerId.toLowerCase()}@example.com`,
      name: payerId,
      entityType: "individual",
      verifiedAt: verified ? new Date() : null,
    })
    .returning();
  return row!.id;
}

/** Registers through the real tool; returns its key, id and claim token. */
async function register(db: Db, name = "Claimable Agent") {
  const result = await call(db, "register_agent", "", { name, operator: "Acme", model: "m-1", payout_email: "a@example.com" });
  expect(result.envelope.status).toBe("OK");
  const data = result.envelope.data as Data;
  const claimUrl = data.claim_url as string;
  return {
    agentId: data.agent_id as string,
    key: data.api_key as string,
    claimUrl,
    token: claimUrl.slice(`${BASE}/claim/`.length),
    data,
    envelope: result.envelope,
  };
}

/** Signs a mandate for a claimed agent through the real service (Task 4). */
async function signMandate(db: Db, agentId: string) {
  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
  const result = await signMandateService(db, {
    principalId: agent!.principalId!,
    agentId,
    input: {
      max_per_loan_cents: 50000,
      max_total_owed_cents: 100000,
      max_fee_bps: 10000,
      max_term_days: 30,
      eligible_collateral: ["invoice_link", "none"],
      typed_name: "Owner A",
      agree: true,
    },
    ip: "127.0.0.1",
  });
  if (result.outcome !== "signed") {
    throw new Error(`signMandate: ${result.outcome}`);
  }
  return result.mandate;
}

describe("claim flow (path A) and KYA tiers", () => {
  let db: Db;
  let mainWorldId: string;

  beforeEach(async () => {
    vi.stubEnv("SESSION_SECRET", "unit-test-session-secret-0123456789abcdef");
    vi.stubEnv("API_KEY_PEPPER", "test-pepper");
    vi.stubEnv("PUBLIC_BASE_URL", `${BASE}/`);
    db = await createTestDb();
    ({ worldId: mainWorldId } = await ensureMainWorldOnce(db));
    await db.update(worlds).set({ railMode: "sim" }).where(eq(worlds.id, mainWorldId));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("register_agent: active at tier 0 with a 7-day claim_url; only the token's sha256 is stored", async () => {
    const before = Date.now();
    const { agentId, token, data, envelope } = await register(db);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 bytes, base64url
    expect(data).toMatchObject({ status: "ACTIVE", tier: 0 });
    const expires = Date.parse(data.claim_expires_at as string);
    expect(expires).toBeGreaterThanOrEqual(before + CLAIM_TTL_MS);
    expect(expires).toBeLessThanOrEqual(Date.now() + CLAIM_TTL_MS);
    expect(envelope.summary).toContain(data.claim_url as string);
    expect(envelope.next_actions[0]).toMatchObject({ tool: "human_approval", args: { url: data.claim_url, who: "owner" } });

    const [row] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(row).toMatchObject({ status: "active", principalId: null, claimTokenHash: hashClaimToken(token) });
    expect(JSON.stringify(row)).not.toContain(token);
  });

  it("ignores ALLOW_INSTANT_ACTIVATION (every self-registered agent is active at tier 0)", async () => {
    vi.stubEnv("ALLOW_INSTANT_ACTIVATION", "false");
    const { data } = await register(db);
    expect(data).toMatchObject({ status: "ACTIVE", tier: 0 });
  });

  it("get_status keeps showing the same claim URL until claimed, with next steps for the human", async () => {
    const { key, claimUrl, token } = await register(db);
    for (let i = 0; i < 2; i += 1) {
      const status = await call(db, "get_status", key, {});
      expect(status.envelope.data).toMatchObject({
        kya: { tier: 0, claimed: false, claim_url: claimUrl, can_borrow: false, borrow_blockers: ["claim_required"] },
      });
      expect(status.envelope.summary).toContain(`Ask your human to open ${claimUrl}`);
      expect(status.envelope.next_actions[0]).toMatchObject({ tool: "human_approval", args: { url: claimUrl, who: "owner" } });
    }

    const principalId = await verifiedPrincipal(db, "OWNERA");
    expect(await claimAgent(db, principalId, token)).toMatchObject({ outcome: "claimed" });
    const after = await call(db, "get_status", key, {});
    expect(after.envelope.data).toMatchObject({
      kya: { tier: 0, claimed: true, claim_url: null, borrow_blockers: ["mandate_missing"] },
    });
    expect(after.envelope.summary).toContain("mandate");
  });

  it("an expired claim token is rotated when the agent asks for its link again", async () => {
    const { agentId, key, token, claimUrl } = await register(db);
    await db.update(agents).set({ claimExpiresAt: new Date(Date.now() - 1000) }).where(eq(agents.id, agentId));
    expect(await lookupClaim(db, token)).toMatchObject({ state: "expired" });

    const status = await call(db, "get_status", key, {});
    const fresh = (status.envelope.data as { kya: { claim_url: string } }).kya.claim_url;
    expect(fresh).not.toBe(claimUrl);
    expect(await lookupClaim(db, token)).toEqual({ state: "invalid" });
    const freshToken = fresh.slice(`${BASE}/claim/`.length);
    expect(await lookupClaim(db, freshToken)).toMatchObject({ state: "claimable", agent: { id: agentId } });
  });

  describe("claimAgent (Review Focus 1)", () => {
    it("claims once; the token is single-use and never claims for another principal", async () => {
      const { agentId, token } = await register(db, "Solo");
      const owner = await verifiedPrincipal(db, "OWNERA");
      const thief = await verifiedPrincipal(db, "THIEF");

      expect(await lookupClaim(db, token)).toMatchObject({ state: "claimable", agent: { name: "Solo", operator: "Acme", model: "m-1" } });
      expect(await claimAgent(db, owner, token)).toMatchObject({ outcome: "claimed", agent: { id: agentId } });
      expect(await claimAgent(db, owner, token)).toMatchObject({ outcome: "already_yours" });
      expect(await claimAgent(db, thief, token)).toEqual({ outcome: "claimed_by_other" });
      expect(await lookupClaim(db, token)).toMatchObject({ state: "claimed", principalId: owner });

      const [row] = await db.select().from(agents).where(eq(agents.id, agentId));
      expect(row).toMatchObject({ principalId: owner, claimTokenSeed: null });
      expect(row!.claimedAt).toBeInstanceOf(Date);
    });

    it("concurrent claims by two principals: exactly one wins", async () => {
      const { agentId, token } = await register(db);
      const a = await verifiedPrincipal(db, "OWNERA");
      const b = await verifiedPrincipal(db, "OWNERB");
      const outcomes = await Promise.all([claimAgent(db, a, token), claimAgent(db, b, token)]);
      expect(outcomes.map((o) => o.outcome).sort()).toEqual(["claimed", "claimed_by_other"]);
      const [row] = await db.select().from(agents).where(eq(agents.id, agentId));
      const winner = outcomes[0]!.outcome === "claimed" ? a : b;
      expect(row!.principalId).toBe(winner);
    });

    it("an expired token cannot claim", async () => {
      const { agentId, token } = await register(db);
      const owner = await verifiedPrincipal(db, "OWNERA");
      const later = new Date(Date.now() + CLAIM_TTL_MS + 1000);
      expect(await claimAgent(db, owner, token, { now: later })).toEqual({ outcome: "expired" });
      const [row] = await db.select().from(agents).where(eq(agents.id, agentId));
      expect(row!.principalId).toBeNull();
    });

    it("unknown / malformed tokens and unverified principals are refused", async () => {
      const { token } = await register(db);
      const owner = await verifiedPrincipal(db, "OWNERA");
      const unverified = await verifiedPrincipal(db, "NOPE", false);
      expect(await claimAgent(db, owner, "A".repeat(43))).toEqual({ outcome: "invalid" });
      expect(await claimAgent(db, owner, "not a token")).toEqual({ outcome: "invalid" });
      expect(await claimAgent(db, unverified, token)).toEqual({ outcome: "principal_unverified" });
      expect(await claimAgent(db, "00000000-0000-0000-0000-000000000000", token)).toEqual({
        outcome: "principal_unverified",
      });
      expect(await lookupClaim(db, "../etc/passwd")).toEqual({ state: "invalid" });
    });
  });

  it("claimView: the claim page's states", async () => {
    const { token } = await register(db, "Viewed");
    const owner = await verifiedPrincipal(db, "OWNERA");
    const other = await verifiedPrincipal(db, "OWNERB");
    expect(await claimView(db, "bogus", null)).toEqual({ view: "invalid" });
    expect(await claimView(db, token, null)).toMatchObject({ view: "sign_in", agent: { name: "Viewed" } });
    expect(await claimView(db, token, owner)).toMatchObject({ view: "confirm" });
    expect(await claimView(db, token, owner, new Date(Date.now() + CLAIM_TTL_MS + 1))).toMatchObject({ view: "expired" });
    await claimAgent(db, owner, token);
    expect(await claimView(db, token, owner)).toMatchObject({ view: "yours" });
    expect(await claimView(db, token, other)).toMatchObject({ view: "taken" });
    expect(await claimView(db, token, null)).toMatchObject({ view: "taken" });
  });

  describe("borrow gate", () => {
    it("T0 cannot borrow: check_eligibility says claim_required with the claim_url; apply_for_loan → 403 CLAIM_REQUIRED", async () => {
      await fundPool(db, mainWorldId, 30000);
      const { key, claimUrl } = await register(db);

      const eligibility = await call(db, "check_eligibility", key, { amount_cents: 1000, term_days: 7 });
      expect(eligibility.envelope.data).toMatchObject({ eligible: false, claim_url: claimUrl, tier: 0 });
      expect((eligibility.envelope.data as Data).reasons).toContain("claim_required");
      expect(eligibility.envelope.next_actions[0]).toMatchObject({ tool: "human_approval", args: { url: claimUrl } });

      const applied = await call(db, "apply_for_loan", key, { amount_cents: 1000, term_days: 7, purpose: "Buy tools" });
      expect(applied.httpStatus).toBe(403);
      expect(applied.envelope).toMatchObject({
        status: "CLAIM_REQUIRED",
        reason_codes: ["claim_required"],
        data: { claim_url: claimUrl },
      });
    });

    it("claimed without a mandate: mandate_missing / 403 MANDATE_REQUIRED (Task 4 provides mandates)", async () => {
      await fundPool(db, mainWorldId, 30000);
      const { key, token } = await register(db);
      await claimAgent(db, await verifiedPrincipal(db, "OWNERA"), token);

      const eligibility = await call(db, "check_eligibility", key, { amount_cents: 1000, term_days: 7 });
      expect(eligibility.envelope.data).toMatchObject({ eligible: false, tier: 0 });
      expect((eligibility.envelope.data as Data).reasons).toContain("mandate_missing");
      expect(eligibility.envelope.data).not.toHaveProperty("claim_url");

      const applied = await call(db, "apply_for_loan", key, { amount_cents: 1000, term_days: 7, purpose: "Buy tools" });
      expect(applied.httpStatus).toBe(403);
      expect(applied.envelope).toMatchObject({ status: "MANDATE_REQUIRED", reason_codes: ["mandate_missing"] });
    });

    it("T1 (claimed + signed mandate) borrows; accept_offer re-checks the tier", async () => {
      await fundPool(db, mainWorldId, 30000);
      const { agentId, key, token } = await register(db);
      await claimAgent(db, await verifiedPrincipal(db, "OWNERA"), token);
      const mandate = await signMandate(db, agentId);

      const status = await call(db, "get_status", key, {});
      expect(status.envelope.data).toMatchObject({ kya: { tier: 1, can_borrow: true, borrow_blockers: [] } });

      const applied = await call(db, "apply_for_loan", key, { amount_cents: 1000, term_days: 7, purpose: "Buy tools" });
      expect(applied.envelope.status).toBe("OFFERED");
      const offer = applied.envelope.data as Data;

      // The mandate is revoked between offer and acceptance (Task 4: 409 MANDATE_REVOKED).
      await revokeMandate(db, { principalId: mandate.principalId, agentId });
      const accepted = await call(db, "accept_offer", key, {
        offer_id: offer.offer_id,
        disclosure_hash: offer.disclosure_hash,
      });
      expect(accepted.httpStatus).toBe(409);
      expect(accepted.envelope).toMatchObject({ status: "MANDATE_REVOKED", reason_codes: ["mandate_revoked"] });
    });

    it("a blocked apply is never stored under its Idempotency-Key (no token in idempotency_keys); the same key works after claiming", async () => {
      await fundPool(db, mainWorldId, 30000);
      const { agentId, key, token } = await register(db);
      const input = { amount_cents: 1000, term_days: 7, purpose: "Buy tools" };

      const blocked = await call(db, "apply_for_loan", key, input, "apply-1");
      expect(blocked.envelope.status).toBe("CLAIM_REQUIRED");
      const stored = await db.select().from(idempotencyKeys).where(eq(idempotencyKeys.agentId, agentId));
      expect(stored).toEqual([]);

      await claimAndMandate(db, agentId);
      const retried = await call(db, "apply_for_loan", key, input, "apply-1");
      expect(retried.envelope.status).toBe("OFFERED");
      const rows = await db.select().from(idempotencyKeys).where(eq(idempotencyKeys.agentId, agentId));
      expect(JSON.stringify(rows)).not.toContain(token);
    });

    it("claimAndMandate (test helper) lifts an agent to tier 1", async () => {
      const { agentId, key } = await register(db);
      await claimAndMandate(db, agentId);
      const status = await call(db, "get_status", key, {});
      expect(status.envelope.data).toMatchObject({ kya: { tier: 1, claimed: true, can_borrow: true } });
    });
  });
});
