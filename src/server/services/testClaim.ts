import { randomBytes } from "crypto";

import { eq } from "drizzle-orm";

import type { Db } from "../db/client";
import { agents, mandates, principals } from "../db/schema";
import { scoped } from "../db/scoped";

/**
 * TEST-ONLY: claims `agentId` for a fresh verified principal and signs a
 * generous mandate for it, skipping the human steps (Verify with PayPal,
 * the claim page, the mandate form). Used by unit tests (via
 * tests/helpers/kya.ts) and by the env-gated `POST /api/test/claim` that
 * the sandbox e2e and the acceptance harness call until Task 7 drives the
 * real claim + mandate flow in a browser. Never reachable in production.
 */
export const TEST_MANDATE_LIMITS = {
  maxPerLoanCents: 50000n,
  maxTotalOwedCents: 10_000_000n,
  maxFeeBps: 10_000,
  maxTermDays: 365,
  eligibleCollateral: ["invoice_link", "none"],
} as const;

export interface TestClaimResult {
  principalId: string;
  mandateId: string;
}

export async function claimAndMandateForTests(db: Db, worldId: string, agentId: string): Promise<TestClaimResult> {
  const now = new Date();
  const suffix = randomBytes(6).toString("hex").toUpperCase();
  const [principal] = await db
    .insert(principals)
    .values({
      paypalPayerId: `TEST${suffix}`,
      email: `owner-${suffix.toLowerCase()}@example.com`,
      name: `Test Owner ${suffix}`,
      entityType: "individual",
      verifiedAt: now,
    })
    .returning();
  if (!principal) {
    throw new Error("Expected a test principal to be inserted");
  }

  const updated = await scoped(db, worldId).update(
    agents,
    { principalId: principal.id, claimedAt: now, claimTokenSeed: null },
    eq(agents.id, agentId),
  );
  if (updated.length !== 1) {
    throw new Error(`No agent ${agentId} in world ${worldId}`);
  }

  const [mandate] = await scoped(db, worldId).insert(mandates, {
    principalId: principal.id,
    agentId,
    version: 1,
    maxPerLoanCents: TEST_MANDATE_LIMITS.maxPerLoanCents,
    maxTotalOwedCents: TEST_MANDATE_LIMITS.maxTotalOwedCents,
    eligibleCollateral: [...TEST_MANDATE_LIMITS.eligibleCollateral],
    maxFeeBps: TEST_MANDATE_LIMITS.maxFeeBps,
    maxTermDays: TEST_MANDATE_LIMITS.maxTermDays,
    guaranteeTextHash: "test-only",
    signedAt: now,
    signature: { test_only: true },
  });
  if (!mandate) {
    throw new Error("Expected a test mandate to be inserted");
  }
  return { principalId: principal.id, mandateId: mandate.id };
}
