import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { worlds } from "@/server/db/schema";
import { createTestDb } from "@/server/db/testing";
import { ACCOUNT_CODES, ensureChartOfAccounts } from "@/server/ledger/accounts";
import { postJournal, type PostingInput } from "@/server/ledger/postJournal";
import { trialBalance } from "@/server/ledger/trialBalance";

const AMOUNT_BOUND = 1_000_000_000;

/** A single posting-amount: any non-zero integer in [-1e9, 1e9]. */
const nonZeroAmount = fc
  .integer({ min: -AMOUNT_BOUND, max: AMOUNT_BOUND })
  .filter((n) => n !== 0);

/**
 * A balanced set of 2-5 posting amounts: the first 1-4 are random
 * non-zero integers, the last is whatever balances the sum to zero
 * (nudged by 1 in the rare case that would otherwise land on zero).
 */
const balancedAmounts = fc
  .array(nonZeroAmount, { minLength: 1, maxLength: 4 })
  .map((amounts) => {
    const sum = amounts.reduce((a, b) => a + b, 0);
    let last = -sum;
    if (last === 0) {
      amounts[0] = (amounts[0] ?? 0) - 1;
      if (amounts[0] === 0) {
        amounts[0] = -1;
      }
      last = -amounts.reduce((a, b) => a + b, 0);
    }
    return [...amounts, last];
  });

/** 1-20 balanced entries, each with 2-5 lines. */
const balancedEntries = fc.array(balancedAmounts, {
  minLength: 1,
  maxLength: 20,
});

describe("ledger property: any set of balanced entries nets to zero", () => {
  it(
    "keeps trialBalance().totalCents at 0n after posting randomly generated balanced entries",
    async () => {
      await fc.assert(
        fc.asyncProperty(balancedEntries, async (entries) => {
          const db = await createTestDb();
          const [world] = await db
            .insert(worlds)
            .values({
              slug: `world-prop-${Date.now()}-${Math.random()}`,
              name: "World Property",
              railMode: "sim",
            })
            .returning();
          if (!world) {
            throw new Error("expected world to be inserted");
          }
          await ensureChartOfAccounts(db, world.id);

          for (const [entryIndex, amounts] of entries.entries()) {
            const entryPostings: PostingInput[] = amounts.map(
              (amountCents, lineIndex) => ({
                accountCode:
                  ACCOUNT_CODES[
                    (entryIndex + lineIndex) % ACCOUNT_CODES.length
                  ] ?? "suspense",
                amountCents: BigInt(amountCents),
              }),
            );

            await postJournal(db, {
              worldId: world.id,
              memo: `property entry ${entryIndex}`,
              sourceType: "property-test",
              sourceId: "00000000-0000-0000-0000-000000000000",
              simAt: new Date("2026-01-01T00:00:00Z"),
              idempotencyKey: `property-entry-${entryIndex}`,
              postings: entryPostings,
            });
          }

          const { totalCents } = await trialBalance(db, world.id);
          expect(totalCents).toBe(0n);
        }),
        { numRuns: 50 },
      );
    },
    60_000,
  );
});
