import { and, eq } from "drizzle-orm";

import type { Db } from "../db/client";
import { loans, noteTransactions } from "../db/schema";
import { scoped } from "../db/scoped";
import { getAccountBalance } from "../ledger/trialBalance";

/**
 * Available liquidity (plan, "Available liquidity"):
 *
 *   cash_paypal balance − Σ(principal of loans in DISBURSING) − Σ(pending
 *   redemptions)
 *
 * Minimal Task 4 implementation: no tool creates a loan or a redemption
 * yet, so both subtracted terms are necessarily zero for every world at
 * this stage. `sumDisbursingLoanPrincipal` is real (it will start
 * returning non-zero sums the moment Task 5/6 disburse a loan);
 * `sumPendingRedemptions` is a stub Task 5 must fill in once it has
 * somewhere to record a redemption's requested amount and in-flight
 * status.
 */
export async function availableLiquidity(
  db: Db,
  worldId: string,
): Promise<bigint> {
  const cashCents = await getAccountBalance(db, worldId, "cash_paypal", null);
  const disbursingPrincipalCents = await sumDisbursingLoanPrincipal(db, worldId);
  const pendingRedemptionCents = await sumPendingRedemptions(db, worldId);
  return cashCents - disbursingPrincipalCents - pendingRedemptionCents;
}

async function sumDisbursingLoanPrincipal(
  db: Db,
  worldId: string,
): Promise<bigint> {
  const rows = await scoped(db, worldId).select(
    loans,
    eq(loans.status, "disbursing"),
  );
  return rows.reduce((sum, loan) => sum + loan.principalCents, 0n);
}

/**
 * Sums the requested amount of every `redeem` note transaction still
 * `pending` (Task 5): money already promised to a holder but not yet
 * paid out must not be double-committed to a loan or another
 * redemption.
 */
async function sumPendingRedemptions(
  db: Db,
  worldId: string,
): Promise<bigint> {
  const rows = await scoped(db, worldId).select(
    noteTransactions,
    and(eq(noteTransactions.kind, "redeem"), eq(noteTransactions.status, "pending")),
  );
  return rows.reduce((sum, row) => sum + row.amountCents, 0n);
}
