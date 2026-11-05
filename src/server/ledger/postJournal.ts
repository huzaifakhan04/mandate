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

/** Postgres unique_violation error code (shared by Neon and PGlite). */
const UNIQUE_VIOLATION = "23505";

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === UNIQUE_VIOLATION
  );
}

async function findByIdempotencyKey(
  db: Db,
  worldId: string,
  idempotencyKey: string,
) {
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
 * Posts a balanced double-entry journal entry. Validates in TypeScript
 * before touching the database (so a rejected entry writes zero rows),
 * then writes the entry and its postings in one transaction.
 *
 * Idempotent on `(worldId, idempotencyKey)`: posting the same key twice
 * returns the original entry with `replayed: true` instead of writing a
 * second entry, whether the duplicate is caught by an up-front lookup or
 * by a unique-constraint violation from a concurrent/retried call.
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
    const alreadyPosted = await findByIdempotencyKey(
      tx,
      worldId,
      idempotencyKey,
    );
    if (alreadyPosted) {
      return { entryId: alreadyPosted.id, replayed: true };
    }

    try {
      const [entry] = await scoped(tx, worldId).insert(journalEntries, {
        memo,
        sourceType,
        sourceId,
        simAt,
        idempotencyKey,
      });

      if (!entry) {
        throw new Error("Failed to insert journal entry");
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
    } catch (error) {
      if (isUniqueViolation(error)) {
        const existing = await findByIdempotencyKey(
          tx,
          worldId,
          idempotencyKey,
        );
        if (existing) {
          return { entryId: existing.id, replayed: true };
        }
      }
      throw error;
    }
  });
}
