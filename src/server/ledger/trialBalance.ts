import { eq, sql } from "drizzle-orm";

import type { Db } from "../db/client";
import { ledgerAccounts, postings } from "../db/schema";
import { scoped } from "../db/scoped";
import type { AccountCode } from "./accounts";

export interface TrialBalanceAccount {
  code: AccountCode;
  ownerRef: string | null;
  balanceCents: bigint;
}

export interface TrialBalanceResult {
  accounts: TrialBalanceAccount[];
  totalCents: bigint;
}

/**
 * Sums postings per account for a world. For a balanced ledger (every
 * journal entry's postings sum to zero) `totalCents` is always `0n`.
 */
export async function trialBalance(
  db: Db,
  worldId: string,
): Promise<TrialBalanceResult> {
  const accounts = await scoped(db, worldId).select(ledgerAccounts);

  const sums = await db
    .select({
      accountId: postings.accountId,
      // SUM of a bigint column comes back as numeric from Postgres (and
      // PGlite), which the driver surfaces as a string, not a JS number
      // — cast through `sql<string>` and parse with BigInt() below so we
      // never round-trip through a float.
      total: sql<string>`sum(${postings.amountCents})`,
    })
    .from(postings)
    .where(eq(postings.worldId, worldId))
    .groupBy(postings.accountId);

  const balanceByAccountId = new Map<string, bigint>();
  for (const row of sums) {
    balanceByAccountId.set(row.accountId, BigInt(row.total));
  }

  const resultAccounts: TrialBalanceAccount[] = accounts.map((account) => ({
    code: account.code as AccountCode,
    ownerRef: account.ownerRef,
    balanceCents: balanceByAccountId.get(account.id) ?? 0n,
  }));

  const totalCents = resultAccounts.reduce(
    (sum, account) => sum + account.balanceCents,
    0n,
  );

  return { accounts: resultAccounts, totalCents };
}
