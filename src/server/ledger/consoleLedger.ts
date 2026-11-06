import { and, desc, eq, inArray, sql } from "drizzle-orm";

import type { Db } from "../db/client";
import { journalEntries, ledgerAccounts, postings } from "../db/schema";

/**
 * P6: ledger reads for the public console (`services/console.ts`). Every
 * query filters on `world_id` itself (the ledger owns its joins, like
 * `trialBalance`). Nothing here returns memos or idempotency keys.
 */

/** Postings summed per (account code, sim day since `anchorSim`) — the ledger's daily movement, for sparklines. */
export async function dailyMovements(
  db: Db,
  worldId: string,
  anchorSim: Date,
  codes: string[] = ["cash_paypal", "loans_receivable", "notes_payable", "allowance_for_losses"],
): Promise<Array<{ code: string; day: number; total: bigint }>> {
  const dayExpr = sql<number>`floor(extract(epoch from (${journalEntries.simAt} - ${anchorSim.toISOString()}::timestamptz)) / 86400)::int`;
  const rows = await db
    .select({ code: ledgerAccounts.code, day: dayExpr, total: sql<string>`sum(${postings.amountCents})` })
    .from(postings)
    .innerJoin(ledgerAccounts, eq(ledgerAccounts.id, postings.accountId))
    .innerJoin(journalEntries, eq(journalEntries.id, postings.entryId))
    .where(and(eq(postings.worldId, worldId), eq(journalEntries.worldId, worldId), inArray(ledgerAccounts.code, codes)))
    // By position: the day expression binds its anchor as a parameter, so
    // repeating it in GROUP BY would not match the select list.
    .groupBy(sql`1, 2`);
  return rows.map((row) => ({ code: row.code, day: Number(row.day), total: BigInt(row.total) }));
}

/** The world's latest `limit` journal entries (newest sim time first), their postings, and the total entry count. */
export async function latestJournalLines(db: Db, worldId: string, limit: number) {
  const entries = await db
    .select({ id: journalEntries.id, sourceType: journalEntries.sourceType, simAt: journalEntries.simAt })
    .from(journalEntries)
    .where(eq(journalEntries.worldId, worldId))
    .orderBy(desc(journalEntries.simAt), desc(journalEntries.createdAt))
    .limit(limit);
  const [count] = await db
    .select({ n: sql<string>`count(*)` })
    .from(journalEntries)
    .where(eq(journalEntries.worldId, worldId));
  const lines = entries.length
    ? await db
        .select({
          id: postings.id,
          entryId: postings.entryId,
          amountCents: postings.amountCents,
          code: ledgerAccounts.code,
          ownerRef: ledgerAccounts.ownerRef,
        })
        .from(postings)
        .innerJoin(ledgerAccounts, eq(ledgerAccounts.id, postings.accountId))
        .where(
          and(
            eq(postings.worldId, worldId),
            inArray(
              postings.entryId,
              entries.map((e) => e.id),
            ),
          ),
        )
    : [];
  return { entries, entryCount: Number(count?.n ?? 0), lines };
}
