import { and, eq } from "drizzle-orm";

import type { Db } from "../db/client";
import { journalEntries, postings } from "../db/schema";
import { scoped } from "../db/scoped";
import { getOrCreateAccount, type AccountCode } from "./accounts";
import {
  EmptyJournalError,
  UnbalancedJournalError,
  ZeroAmountPostingError,
} from "./errors";

export interface PostingInput {
  accountCode: AccountCode;
  ownerRef?: string;
  amountCents: bigint;
}

export interface PostJournalInput {
  worldId: string;
  memo: string;
  sourceType: string;
  sourceId: string;
  simAt: Date;
  idempotencyKey: string;
  postings: PostingInput[];
}

export interface PostJournalResult {
  entryId: string;
  replayed: boolean;
}

type JournalEntryRow = typeof journalEntries.$inferSelect;

export interface InsertEntryIdempotentValues {
  memo: string;
  sourceType: string;
  sourceId: string;
  simAt: Date;
  idempotencyKey: string;
}

export interface InsertEntryIdempotentResult {
  entry: JournalEntryRow;
  replayed: boolean;
}

async function findByIdempotencyKey(
  db: Db,
  worldId: string,
  idempotencyKey: string,
): Promise<JournalEntryRow | undefined> {
  const [existing] = await db
    .select()
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.worldId, worldId),
        eq(journalEntries.idempotencyKey, idempotencyKey),
      ),
    )
    .limit(1);
  return existing;
}

/**
 * Inserts a journal entry, or returns the existing one if `(worldId,
 * idempotencyKey)` already has a row.
 *
 * This uses `INSERT ... ON CONFLICT (world_id, idempotency_key) DO
 * NOTHING RETURNING *` rather than an up-front SELECT followed by a
 * plain INSERT wrapped in a try/catch. The try/catch approach is broken
 * under Postgres: once an INSERT inside a transaction fails with a
 * unique-violation (23505), that transaction is aborted and every
 * subsequent statement on it — including a "fall back and reselect the
 * existing row" SELECT — fails with `25P02 current transaction is
 * aborted`, not with the row we wanted. `ON CONFLICT DO NOTHING` avoids
 * ever raising that error in the first place, so the same transaction
 * can safely continue (or stop early) based on whether a row came back.
 *
 * Exported so a test can call it twice directly and exercise the
 * conflict branch without needing two real concurrent transactions.
 */
export async function insertEntryIdempotent(
  db: Db,
  worldId: string,
  values: InsertEntryIdempotentValues,
): Promise<InsertEntryIdempotentResult> {
  const [inserted] = await db
    .insert(journalEntries)
    .values({ ...values, worldId })
    .onConflictDoNothing({
      target: [journalEntries.worldId, journalEntries.idempotencyKey],
    })
    .returning();

  if (inserted) {
    return { entry: inserted, replayed: false };
  }

  const existing = await findByIdempotencyKey(
    db,
    worldId,
    values.idempotencyKey,
  );
  if (!existing) {
    throw new Error(
      `Expected an existing journal entry for idempotencyKey=${values.idempotencyKey} after an ON CONFLICT DO NOTHING insert, found none`,
    );
  }
  return { entry: existing, replayed: true };
}

/**
 * Posts a balanced double-entry journal entry. Validates in TypeScript
 * before touching the database (so a rejected entry writes zero rows),
 * then writes the entry and its postings in one transaction.
 *
 * Idempotent on `(worldId, idempotencyKey)`: posting the same key twice
 * — whether a plain sequential retry or two transactions racing each
 * other — returns the original entry with `replayed: true` and never
 * writes a second entry or duplicates its postings. See
 * `insertEntryIdempotent` for why this relies on `ON CONFLICT DO
 * NOTHING` rather than catching a unique-violation.
 *
 * Sign convention: positive amountCents = debit, negative = credit.
 */
export async function postJournal(
  db: Db,
  input: PostJournalInput,
): Promise<PostJournalResult> {
  const { worldId, memo, sourceType, sourceId, simAt, idempotencyKey } =
    input;

  if (input.postings.length === 0) {
    throw new EmptyJournalError();
  }

  for (const posting of input.postings) {
    if (posting.amountCents === 0n) {
      throw new ZeroAmountPostingError();
    }
  }

  const totalCents = input.postings.reduce(
    (sum, posting) => sum + posting.amountCents,
    0n,
  );
  if (totalCents !== 0n) {
    throw new UnbalancedJournalError(totalCents);
  }

  return db.transaction(async (tx) => {
    const { entry, replayed } = await insertEntryIdempotent(tx, worldId, {
      memo,
      sourceType,
      sourceId,
      simAt,
      idempotencyKey,
    });

    if (replayed) {
      // Someone else already posted this idempotency key (sequentially
      // before us, or concurrently and won the ON CONFLICT race) — its
      // postings already exist too, so inserting our own would
      // duplicate them. Return the existing entry untouched.
      return { entryId: entry.id, replayed: true };
    }

    for (const posting of input.postings) {
      const account = await getOrCreateAccount(
        tx,
        worldId,
        posting.accountCode,
        posting.ownerRef ?? null,
      );

      await scoped(tx, worldId).insert(postings, {
        entryId: entry.id,
        accountId: account.id,
        amountCents: posting.amountCents,
      });
    }

    return { entryId: entry.id, replayed: false };
  });
}
