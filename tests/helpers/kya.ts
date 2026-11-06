/**
 * KYA test helpers (P2 Task 2). Borrowing needs tier ≥ 1: a claim by a
 * verified principal plus a current signed mandate. `claimAndMandate`
 * does both directly in the database so lending/borrowing suites keep
 * testing what they test.
 *
 * P3 Task 2: applications are underwritten by grade, and a fresh T1 agent
 * is grade E (declined). Unless `credit: "real"`, the helper also gives the
 * agent an ESTABLISHED credit file (grade A without collateral) through the
 * test-only score-facts override, so those suites still get offers. Suites
 * about scoring and underwriting pass `credit: "real"`.
 */
import { eq } from "drizzle-orm";

import type { Db } from "@/server/db/client";
import { agents } from "@/server/db/schema";
import type { ScoreFacts } from "@/server/domain/scorecard";
import { __setScoreFactsOverrideForTests } from "@/server/services/credit";
import { claimAndMandateForTests, type TestClaimOptions, type TestClaimResult } from "@/server/services/testClaim";

/**
 * Identity 25 + history 35 + tenure 10 + exposure 10 = 80 → grade A
 * (limit 50000) with no collateral; exposure is pinned so the grade (and so
 * the fee) doesn't drift as the test's principal borrows.
 */
export const ESTABLISHED_CREDIT: Partial<Omit<ScoreFacts, "invoiceCoverageBps">> = {
  hasSigningKey: true,
  hasApprovedDocument: true,
  onTimeRepaidLoans: 5,
  lateRepayments: 0,
  everChargedOff: false,
  tenureDays: 30,
  exposureCents: 0n,
};

export interface TestKyaOptions extends TestClaimOptions {
  /** `established` (default): grade A credit file; `real`: score from the agent's real DB facts. */
  credit?: "established" | "real";
}

/**
 * Claims `agentId` (for a fresh principal, or `options.principalId`) and
 * signs a mandate through the real signing service — generous limits
 * unless `options.limits` overrides some.
 */
export async function claimAndMandate(db: Db, agentId: string, options: TestKyaOptions = {}): Promise<TestClaimResult> {
  const { credit = "established", ...claimOptions } = options;
  const [agent] = await db.select({ worldId: agents.worldId }).from(agents).where(eq(agents.id, agentId));
  if (!agent) {
    throw new Error(`claimAndMandate: no agent ${agentId}`);
  }
  __setScoreFactsOverrideForTests(agentId, credit === "established" ? ESTABLISHED_CREDIT : null);
  return claimAndMandateForTests(db, agent.worldId, agentId, claimOptions);
}
