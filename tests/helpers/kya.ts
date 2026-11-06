/**
 * KYA test helpers (P2 Task 2). Borrowing needs tier ≥ 1: a claim by a
 * verified principal plus a current signed mandate. `claimAndMandate`
 * does both directly in the database so lending/borrowing suites keep
 * testing what they test.
 */
import { eq } from "drizzle-orm";

import type { Db } from "@/server/db/client";
import { agents } from "@/server/db/schema";
import { claimAndMandateForTests, type TestClaimOptions, type TestClaimResult } from "@/server/services/testClaim";

/**
 * Claims `agentId` (for a fresh principal, or `options.principalId`) and
 * signs a mandate through the real signing service — generous limits
 * unless `options.limits` overrides some.
 */
export async function claimAndMandate(db: Db, agentId: string, options: TestClaimOptions = {}): Promise<TestClaimResult> {
  const [agent] = await db.select({ worldId: agents.worldId }).from(agents).where(eq(agents.id, agentId));
  if (!agent) {
    throw new Error(`claimAndMandate: no agent ${agentId}`);
  }
  return claimAndMandateForTests(db, agent.worldId, agentId, options);
}
