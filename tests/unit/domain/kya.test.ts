import { describe, expect, it } from "vitest";

import { computeTier, isCurrentMandate } from "@/server/domain/kya";

const NOW = new Date("2026-11-06T12:00:00Z");
const P = "11111111-1111-1111-1111-111111111111";
const claimedAgent = { principalId: P, claimedAt: NOW };
const verified = { id: P, verifiedAt: NOW };
const mandate = { principalId: P, signedAt: NOW, revokedAt: null };

describe("computeTier", () => {
  it("T0 with claim_required while unclaimed (lending only)", () => {
    const tier = computeTier({ principalId: null, claimedAt: null }, null, null, [], null, NOW);
    expect(tier).toMatchObject({ tier: 0, claimed: false, borrowBlockers: ["claim_required"], maxPerLoanCents: 0 });
  });

  it("an unverified principal does not count as a claim", () => {
    const tier = computeTier(claimedAgent, { id: P, verifiedAt: null }, mandate, [], null, NOW);
    expect(tier.borrowBlockers).toEqual(["claim_required"]);
  });

  it("claimed without a mandate stays T0 with mandate_missing", () => {
    const tier = computeTier(claimedAgent, verified, null, [], null, NOW);
    expect(tier).toMatchObject({ tier: 0, claimed: true, hasCurrentMandate: false, borrowBlockers: ["mandate_missing"] });
  });

  it("a revoked, unsigned, expired or other principal's mandate is not current", () => {
    expect(isCurrentMandate({ ...mandate, revokedAt: NOW }, P, NOW)).toBe(false);
    expect(isCurrentMandate({ ...mandate, signedAt: null }, P, NOW)).toBe(false);
    expect(isCurrentMandate({ ...mandate, expiresAt: NOW }, P, NOW)).toBe(false);
    expect(isCurrentMandate({ ...mandate, principalId: "other" }, P, NOW)).toBe(false);
    expect(isCurrentMandate({ ...mandate, expiresAt: new Date(NOW.getTime() + 1) }, P, NOW)).toBe(true);
    expect(computeTier(claimedAgent, verified, { ...mandate, revokedAt: NOW }, [], null, NOW).borrowBlockers).toEqual([
      "mandate_missing",
    ]);
  });

  it("T1 = claimed + current mandate, per loan ≤ 25000; T2 also needs an approved document and a key", () => {
    expect(computeTier(claimedAgent, verified, mandate, [], null, NOW)).toMatchObject({
      tier: 1,
      borrowBlockers: [],
      nextTierRequirements: ["kya_document_missing", "signing_key_missing"],
      maxPerLoanCents: 25000,
    });
    expect(computeTier(claimedAgent, verified, mandate, [{ reviewStatus: "pending" }], {}, NOW).tier).toBe(1);
    expect(computeTier(claimedAgent, verified, mandate, [{ reviewStatus: "approved" }], {}, NOW)).toMatchObject({
      tier: 2,
      nextTierRequirements: [],
      maxPerLoanCents: 50000,
    });
    expect(
      computeTier(claimedAgent, verified, mandate, [{ reviewStatus: "approved" }], { revokedAt: NOW }, NOW).tier,
    ).toBe(1);
  });
});
