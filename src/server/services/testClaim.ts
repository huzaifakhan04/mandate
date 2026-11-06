import { randomBytes } from "crypto";

import { eq } from "drizzle-orm";

import type { Db } from "../db/client";
import { agents, principals } from "../db/schema";
import { scoped } from "../db/scoped";
import type { MandateTerms } from "../domain/mandate";
import { hashIp, signTerms } from "./mandates";

/**
 * TEST-ONLY: claims `agentId` for a fresh verified principal and signs a
 * generous mandate for it through the real signing service (`signTerms`;
 * per-loan 50000 — the tier cap still applies — and a 10M total), skipping the human steps (Verify with PayPal,
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

export interface TestClaimOptions {
  /** Claim for this existing (verified) principal instead of a fresh one. */
  principalId?: string;
  /** Override some of the generous limits. */
  limits?: Partial<MandateTerms>;
}

export async function claimAndMandateForTests(
  db: Db,
  worldId: string,
  agentId: string,
  options: TestClaimOptions = {},
): Promise<TestClaimResult> {
  const now = new Date();
  const principal = options.principalId ? await existingPrincipal(db, options.principalId) : await freshPrincipal(db, now);

  const updated = await scoped(db, worldId).update(
    agents,
    { principalId: principal.id, claimedAt: now, claimTokenSeed: null },
    eq(agents.id, agentId),
  );
  if (updated.length !== 1) {
    throw new Error(`No agent ${agentId} in world ${worldId}`);
  }

  const signed = await signTerms(
    db,
    worldId,
    principal.id,
    agentId,
    {
      maxPerLoanCents: TEST_MANDATE_LIMITS.maxPerLoanCents,
      maxTotalOwedCents: TEST_MANDATE_LIMITS.maxTotalOwedCents,
      maxFeeBps: TEST_MANDATE_LIMITS.maxFeeBps,
      maxTermDays: TEST_MANDATE_LIMITS.maxTermDays,
      eligibleCollateral: [...TEST_MANDATE_LIMITS.eligibleCollateral],
      expiresAt: null,
      ...options.limits,
    },
    principal.name,
    hashIp("127.0.0.1"),
    now,
  );
  if (signed.outcome !== "signed") {
    throw new Error(`Expected a test mandate to be signed for agent ${agentId}`);
  }
  const mandate = signed.mandate;
  return { principalId: principal.id, mandateId: mandate.id };
}

async function freshPrincipal(db: Db, now: Date) {
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
  return principal;
}

async function existingPrincipal(db: Db, principalId: string) {
  const [principal] = await db.select().from(principals).where(eq(principals.id, principalId)).limit(1);
  if (!principal) {
    throw new Error(`No principal ${principalId}`);
  }
  return principal;
}
