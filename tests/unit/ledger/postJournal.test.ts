import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { worlds, journalEntries, postings } from "@/server/db/schema";
import { createTestDb } from "@/server/db/testing";
import type { Db } from "@/server/db/client";
import { ensureChartOfAccounts } from "@/server/ledger/accounts";
import { insertEntryIdempotent, postJournal } from "@/server/ledger/postJournal";
import { trialBalance } from "@/server/ledger/trialBalance";
import {
  EmptyJournalError,
  UnbalancedJournalError,
  ZeroAmountPostingError,
} from "@/server/ledger/errors";

describe("postJournal", () => {
  let db: Db;
  let worldId: string;

  beforeEach(async () => {
    db = await createTestDb();
    const [world] = await db
      .insert(worlds)
      .values({ slug: "world-ledger", name: "World Ledger", railMode: "sim" })
      .returning();
    if (!world) {
      throw new Error("expected world to be inserted");
    }
    worldId = world.id;
    await ensureChartOfAccounts(db, worldId);
  });

  it("stores a balanced 2-line entry and keeps the trial balance at zero", async () => {
    const result = await postJournal(db, {
      worldId,
      memo: "disbursement",
      sourceType: "loan",
      sourceId: "00000000-0000-0000-0000-000000000001",
      simAt: new Date("2026-01-01T00:00:00Z"),
      idempotencyKey: "loan-1-disbursement",
      postings: [
        { accountCode: "cash_paypal", amountCents: 25000n },
        {
          accountCode: "notes_payable",
          ownerRef: "agentA",
          amountCents: -25000n,
        },
      ],
    });

    expect(result.replayed).toBe(false);
    expect(result.entryId).toBeTruthy();

    const { totalCents, accounts } = await trialBalance(db, worldId);
    expect(totalCents).toBe(0n);

    const cash = accounts.find(
      (a) => a.code === "cash_paypal" && a.ownerRef === null,
    );
    expect(cash?.balanceCents).toBe(25000n);

    const notesPayable = accounts.find(
      (a) => a.code === "notes_payable" && a.ownerRef === "agentA",
    );
    expect(notesPayable?.balanceCents).toBe(-25000n);
  });

  it("rejects an unbalanced entry and writes zero rows", async () => {
    await expect(
      postJournal(db, {
        worldId,
        memo: "bad entry",
        sourceType: "loan",
        sourceId: "00000000-0000-0000-0000-000000000002",
        simAt: new Date("2026-01-01T00:00:00Z"),
        idempotencyKey: "unbalanced-1",
        postings: [
          { accountCode: "cash_paypal", amountCents: 100n },
          { accountCode: "notes_payable", amountCents: -99n },
        ],
      }),
    ).rejects.toBeInstanceOf(UnbalancedJournalError);

    const rows = await db.select().from(journalEntries);
    expect(rows).toHaveLength(0);
  });

  it("rejects an empty postings list", async () => {
    await expect(
      postJournal(db, {
        worldId,
        memo: "empty",
        sourceType: "loan",
        sourceId: "00000000-0000-0000-0000-000000000003",
        simAt: new Date("2026-01-01T00:00:00Z"),
        idempotencyKey: "empty-1",
        postings: [],
      }),
    ).rejects.toBeInstanceOf(EmptyJournalError);

    const rows = await db.select().from(journalEntries);
    expect(rows).toHaveLength(0);
  });

  it("rejects a zero-amount posting line", async () => {
    await expect(
      postJournal(db, {
        worldId,
        memo: "zero line",
        sourceType: "loan",
        sourceId: "00000000-0000-0000-0000-000000000004",
        simAt: new Date("2026-01-01T00:00:00Z"),
        idempotencyKey: "zero-1",
        postings: [
          { accountCode: "cash_paypal", amountCents: 0n },
          { accountCode: "notes_payable", amountCents: 0n },
        ],
      }),
    ).rejects.toBeInstanceOf(ZeroAmountPostingError);

    const rows = await db.select().from(journalEntries);
    expect(rows).toHaveLength(0);
  });

  it("is idempotent: replaying the same idempotencyKey returns the original entry", async () => {
    const input = {
      worldId,
      memo: "replay me",
      sourceType: "loan",
      sourceId: "00000000-0000-0000-0000-000000000005",
      simAt: new Date("2026-01-01T00:00:00Z"),
      idempotencyKey: "replay-1",
      postings: [
        { accountCode: "cash_paypal" as const, amountCents: 1000n },
        {
          accountCode: "notes_payable" as const,
          ownerRef: "agentB",
          amountCents: -1000n,
        },
      ],
    };

    const first = await postJournal(db, input);
    const second = await postJournal(db, input);

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.entryId).toBe(first.entryId);

    const rows = await db.select().from(journalEntries);
    expect(rows).toHaveLength(1);
  });

  it("insertEntryIdempotent: a second insert with the same idempotencyKey returns replayed:true for the first row, with exactly one row written", async () => {
    const values = {
      memo: "conflict branch",
      sourceType: "loan",
      sourceId: "00000000-0000-0000-0000-000000000006",
      simAt: new Date("2026-01-01T00:00:00Z"),
      idempotencyKey: "conflict-branch-1",
    };

    // Two direct calls to the exported helper, bypassing postJournal
    // entirely, so this exercises the `ON CONFLICT DO NOTHING` branch
    // itself rather than postJournal's higher-level replay behavior.
    const first = await insertEntryIdempotent(db, worldId, values);
    const second = await insertEntryIdempotent(db, worldId, values);

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.entry.id).toBe(first.entry.id);

    const rows = await db
      .select()
      .from(journalEntries)
      .where(eq(journalEntries.idempotencyKey, "conflict-branch-1"));
    expect(rows).toHaveLength(1);
  });

  it("postJournal: replays without duplicating postings when the entry row was already written by someone else", async () => {
    // Simulate a concurrent writer that already committed the entry
    // row (e.g. another request that raced past the ON CONFLICT check
    // first) by inserting it directly, bypassing postJournal.
    const [preExisting] = await db
      .insert(journalEntries)
      .values({
        worldId,
        memo: "written by a concurrent caller",
        sourceType: "loan",
        sourceId: "00000000-0000-0000-0000-000000000007",
        simAt: new Date("2026-01-01T00:00:00Z"),
        idempotencyKey: "raced-1",
      })
      .returning();
    if (!preExisting) {
      throw new Error("expected the pre-existing entry to be inserted");
    }

    const result = await postJournal(db, {
      worldId,
      memo: "my attempt",
      sourceType: "loan",
      sourceId: "00000000-0000-0000-0000-000000000007",
      simAt: new Date("2026-01-01T00:00:00Z"),
      idempotencyKey: "raced-1",
      postings: [
        { accountCode: "cash_paypal", amountCents: 500n },
        { accountCode: "notes_payable", amountCents: -500n },
      ],
    });

    expect(result.replayed).toBe(true);
    expect(result.entryId).toBe(preExisting.id);

    const entryRows = await db
      .select()
      .from(journalEntries)
      .where(eq(journalEntries.idempotencyKey, "raced-1"));
    expect(entryRows).toHaveLength(1);

    // The "someone else" writer in this test never inserted postings,
    // so postJournal must not have inserted any either on the replayed
    // path — it must not duplicate (or originate) postings for an
    // entry it didn't create.
    const postingRows = await db
      .select()
      .from(postings)
      .where(eq(postings.entryId, preExisting.id));
    expect(postingRows).toHaveLength(0);
  });
});
