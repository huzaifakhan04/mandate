import { and, eq, inArray, sql } from "drizzle-orm";

import { getSimNow } from "../clock/clock";
import type { NextAction } from "../contracts/envelope";
import type { Db } from "../db/client";
import { agents, noteSeries, notePositions, noteTransactions } from "../db/schema";
import { scoped } from "../db/scoped";
import { postJournal } from "../ledger/postJournal";
import {
  buildCreateOrderRequest,
  buildSendPayoutRequest,
  enqueueOperation,
  getOperation,
  journalKey,
  type OrderCaptureResult,
} from "../paypal/operations";
import { postCaptureFee, postPayoutFee } from "./paypalFees";
import { payoutRecipientType, resolvePayoutOutcome, type ObservedPayoutStatus } from "./payoutStatus";
import { availableLiquidity } from "../domain/liquidity";
import { OPEN_REDEMPTION_STATUSES, redemptionPayable, reserveFloorCents } from "../domain/treasury";
import { describeError } from "../db/errors";
import { getTreasuryPolicy, notesPayableCents, redemptionTotals } from "./treasury";
import { railForWorld } from "./worlds";
import { settleDeferredHolderLosses } from "./holderLosses";
import { registerCaptureHandler, type CaptureApplyResult } from "./checkouts";
import { SAMPLE_BUY_NOTES_ARGS } from "../contracts/sampleArgs";

/** The plan's single per-world note series name — see `services/worlds.ts`. */
const MANDATE_POOL_A_NAME = "Mandate Pool A";

export const NOTES_DISCLOSURE =
  "Notes are not deposits and are not FDIC-insured. Returns come only from borrower repayments.";

async function getNoteSeriesId(db: Db, worldId: string): Promise<string> {
  const [series] = await scoped(db, worldId).select(
    noteSeries,
    eq(noteSeries.name, MANDATE_POOL_A_NAME),
  );
  if (!series) {
    throw new Error(`Expected a "${MANDATE_POOL_A_NAME}" note series to exist for world ${worldId}`);
  }
  return series.id;
}

async function getOrCreatePosition(
  db: Db,
  worldId: string,
  seriesId: string,
  agentId: string,
): Promise<typeof notePositions.$inferSelect> {
  const existing = await scoped(db, worldId).findOne(
    notePositions,
    and(eq(notePositions.seriesId, seriesId), eq(notePositions.agentId, agentId))!,
  );
  if (existing) {
    return existing;
  }
  const inserted = await scoped(db, worldId).insertOnConflictDoNothing(
    notePositions,
    { seriesId, agentId, units: 0n, costCents: 0n },
    [notePositions.seriesId, notePositions.agentId],
  );
  if (inserted[0]) {
    return inserted[0];
  }
  const found = await scoped(db, worldId).findOne(
    notePositions,
    and(eq(notePositions.seriesId, seriesId), eq(notePositions.agentId, agentId))!,
  );
  if (!found) {
    throw new Error(`Expected a note position for agent ${agentId} after insert-or-find`);
  }
  return found;
}

/** `${PUBLIC_BASE_URL}/checkout/...`, falling back to `http://localhost:3000`. */
function checkoutUrl(path: string): string {
  const base = process.env.PUBLIC_BASE_URL || "http://localhost:3000";
  return `${base.replace(/\/+$/, "")}${path}`;
}

export interface CreateNotePurchaseResult {
  noteTxId: string;
  createOperationId: string;
  amountCents: bigint;
}

/**
 * `buy_notes`'s transactional half (Ruling K): creates the `note_transactions`
 * row (kind `buy`, pending) and enqueues the `order.create` operation —
 * never executes it (no PayPal call inside a transaction). The tool's
 * `finalize` hook executes it after commit and returns the approve URL.
 */
export async function createNotePurchase(
  tx: Db,
  worldId: string,
  agentId: string,
  amountCents: bigint,
): Promise<CreateNotePurchaseResult> {
  const seriesId = await getNoteSeriesId(tx, worldId);
  const position = await getOrCreatePosition(tx, worldId, seriesId, agentId);

  const [noteTx] = await scoped(tx, worldId).insert(noteTransactions, {
    positionId: position.id,
    kind: "buy",
    amountCents,
    status: "pending",
  });
  if (!noteTx) {
    throw new Error("Expected a note_transactions row to be inserted");
  }

  const rail = await railForWorld(tx, worldId);
  const { operationId } = await enqueueOperation(tx, {
    worldId,
    rail,
    kind: "order.create",
    purpose: "note_purchase",
    sourceId: noteTx.id,
    request: buildCreateOrderRequest({
      amountCents,
      description: `${MANDATE_POOL_A_NAME} note purchase`,
      customId: noteTx.id,
      returnUrl: checkoutUrl("/checkout/notes/return"),
      cancelUrl: checkoutUrl("/checkout/notes/cancel"),
    }),
  });

  await scoped(tx, worldId).update(noteTransactions, { opId: operationId }, eq(noteTransactions.id, noteTx.id));

  return { noteTxId: noteTx.id, createOperationId: operationId, amountCents };
}

/**
 * Applies a note purchase capture's effect exactly once: Dr `cash_paypal`
 * / Cr `notes_payable[agent]`, plus `+amountCents` units on the agent's
 * position. Keyed by `journalKey("note_purchase_capture", orderId)`
 * (never the capture operation id — the ALREADY_CAPTURED recovery path
 * must never double-credit).
 *
 * Fix round 1 (I1): the conditional `pending -> completed` transition,
 * the journal post, and the position bump all happen in ONE transaction,
 * with the journal posted only *after* the conditional update wins — so
 * a replayed capture (idempotent retry, or a second `confirm_checkout`
 * call) that finds the row already `completed` touches nothing at all
 * (not even a `postJournal` call, which is itself idempotent but would
 * otherwise run pointlessly outside the guard). `postJournal`'s own
 * `db.transaction` nests as a savepoint inside this one.
 *
 * Fix round 1 (M2): verifies the captured amount matches the note
 * transaction's amount before crediting anything (this system is
 * USD-only end to end — `buildCreateOrderRequest` always sets
 * `currency_code: USD` — so there is no separate currency field to
 * compare). A mismatch credits nothing, posts no journal, and leaves the
 * note transaction `review` instead of `completed`.
 *
 * Fix round 2 (item 1): on a replay (the transaction isn't `pending`
 * any more), the outcome reported must match what's actually stored —
 * `completed` really was applied, `review` really is a mismatch,
 * `failed` really did fail — never a blanket "applied" regardless of
 * which terminal state the row is in (the bug that let a second
 * `confirm_checkout` call after a mismatch claim `COMPLETED`).
 */
async function applyNotePurchaseCaptureEffect(
  db: Db,
  worldId: string,
  simNow: Date,
  args: { createSourceId: string; orderId: string; capture: OrderCaptureResult },
): Promise<CaptureApplyResult> {
  const noteTx = await scoped(db, worldId).findOne(
    noteTransactions,
    eq(noteTransactions.id, args.createSourceId),
  );
  if (!noteTx) {
    throw new Error(`note_transactions row ${args.createSourceId} not found in world ${worldId}`);
  }

  const capturedAmountCents = BigInt(args.capture.amountCents);

  // Already settled one way or another — nothing to (re-)apply, but the
  // reported outcome must reflect which way it settled.
  if (noteTx.status === "completed") {
    return { outcome: "applied", summary: "Already captured.", data: { amount_cents: Number(noteTx.amountCents) } };
  }
  if (noteTx.status === "review") {
    return {
      outcome: "mismatch",
      reason: `captured ${capturedAmountCents.toString()} cents, expected ${noteTx.amountCents.toString()}`,
    };
  }
  if (noteTx.status === "failed") {
    return { outcome: "failed", reason: "this note purchase previously failed" };
  }

  const amountCents = noteTx.amountCents;

  if (capturedAmountCents !== amountCents) {
    await scoped(db, worldId).update(
      noteTransactions,
      { status: "review" },
      and(eq(noteTransactions.id, noteTx.id), eq(noteTransactions.status, "pending")),
    );
    console.error(
      `[notes] capture ${args.orderId} for note_transactions ${noteTx.id} captured ${capturedAmountCents.toString()} cents, expected ${amountCents.toString()} — marked for review, nothing credited`,
    );
    return {
      outcome: "mismatch",
      reason: `captured ${capturedAmountCents.toString()} cents, expected ${amountCents.toString()}`,
    };
  }

  const position = await scoped(db, worldId).findOne(
    notePositions,
    eq(notePositions.id, noteTx.positionId),
  );
  if (!position) {
    throw new Error(`note_positions row ${noteTx.positionId} not found in world ${worldId}`);
  }

  await db.transaction(async (tx) => {
    const updated = await scoped(tx, worldId).update(
      noteTransactions,
      { status: "completed" },
      and(eq(noteTransactions.id, noteTx.id), eq(noteTransactions.status, "pending")),
    );
    if (updated.length !== 1) {
      // Lost a race with another replay between the read above and this
      // conditional update — the other one is applying the effect.
      return;
    }

    await postJournal(tx, {
      worldId,
      memo: "Note purchase captured",
      sourceType: "note_transactions",
      sourceId: noteTx.id,
      simAt: simNow,
      idempotencyKey: journalKey("note_purchase_capture", args.orderId),
      postings: [
        { accountCode: "cash_paypal", amountCents },
        { accountCode: "notes_payable", ownerRef: position.agentId, amountCents: -amountCents },
      ],
    });
    // Task 10b: PayPal's fee on this capture, same transaction (once per capture id).
    await postCaptureFee(
      tx,
      { worldId, simAt: simNow, sourceType: "note_transactions", sourceId: noteTx.id },
      args.capture,
    );

    const [lockedPosition] = await scoped(tx, worldId).forUpdate(
      notePositions,
      eq(notePositions.id, position.id),
    );
    if (lockedPosition) {
      await scoped(tx, worldId).update(
        notePositions,
        { units: lockedPosition.units + amountCents, costCents: lockedPosition.costCents + amountCents },
        eq(notePositions.id, lockedPosition.id),
      );
    }
  });

  return {
    outcome: "applied",
    summary: `Captured ${amountCents.toString()} cents; ${amountCents.toString()} note units credited.`,
    data: { amount_cents: Number(amountCents), units_credited: Number(amountCents) },
  };
}

/** Fix round 1 (I3): marks a note purchase's transaction `failed`, idempotently, crediting nothing. */
async function applyNotePurchaseFailure(
  db: Db,
  worldId: string,
  args: { createSourceId: string; orderId: string; reason: string },
): Promise<void> {
  const updated = await scoped(db, worldId).update(
    noteTransactions,
    { status: "failed" },
    and(eq(noteTransactions.id, args.createSourceId), eq(noteTransactions.status, "pending")),
  );
  if (updated.length === 1) {
    console.error(
      `[notes] note purchase ${args.createSourceId} (order ${args.orderId}) failed: ${args.reason}`,
    );
  }
}

async function resolveNotePurchaseOwnerAgentId(
  db: Db,
  worldId: string,
  noteTxId: string,
): Promise<string | null> {
  const noteTx = await scoped(db, worldId).findOne(noteTransactions, eq(noteTransactions.id, noteTxId));
  if (!noteTx) {
    return null;
  }
  const position = await scoped(db, worldId).findOne(
    notePositions,
    eq(notePositions.id, noteTx.positionId),
  );
  return position?.agentId ?? null;
}

/** Fix round 2 (item 4): points a failed note purchase back at `buy_notes` with its original amount. */
async function notePurchaseRetryNextAction(
  db: Db,
  worldId: string,
  createSourceId: string,
): Promise<NextAction> {
  const noteTx = await scoped(db, worldId).findOne(noteTransactions, eq(noteTransactions.id, createSourceId));
  return { tool: "buy_notes", args: noteTx ? { amount_cents: Number(noteTx.amountCents) } : { ...SAMPLE_BUY_NOTES_ARGS } };
}

registerCaptureHandler("note_purchase", {
  resolveOwnerAgentId: resolveNotePurchaseOwnerAgentId,
  applyEffect: (db, worldId, simNow, args) => applyNotePurchaseCaptureEffect(db, worldId, simNow, args),
  applyFailure: applyNotePurchaseFailure,
  retryNextAction: notePurchaseRetryNextAction,
});

// ---------------------------------------------------------------------
// redeem_notes
// ---------------------------------------------------------------------

export type RedeemNotesOutcome =
  | { outcome: "insufficient_note_balance"; redeemableUnits: bigint }
  | { outcome: "payout_receiver_missing" }
  | { outcome: "submitted"; noteTxId: string; payoutOperationId: string }
  /** P5 Task 3: the reserve floor gates it — queued (FIFO) until the tick can pay it. */
  | { outcome: "queued"; noteTxId: string; queue: QueuePosition };

/** Where a queued redemption stands (P5 Task 3), for the holder. */
export interface QueuePosition {
  /** 1 = next to be paid. */
  position: number;
  /** Σ queued redemptions ahead of this one. */
  aheadCents: bigint;
  /** The reserve floor on the notes left after this redemption and those ahead. */
  reserveFloorCents: bigint;
  availableLiquidityCents: bigint;
  /** How much more available cash the bank needs before it can pay this one (0 = next tick). */
  cashNeededCents: bigint;
  /** Why it waits: the floor itself, or other redemptions already queued ahead of it. */
  reason: "reserve_floor" | "queue_ahead";
}

/**
 * `redeem_notes`'s transactional half: checks the amount against the
 * agent's *redeemable* balance (computed under the note series row's lock,
 * per Review Focus #4) and either creates the redemption
 * (`note_transactions` kind `redeem`, pending) and enqueues the payout —
 * never executing it inside the transaction — or, P5 Task 3, queues it.
 *
 * Fix round 1 (C1): redeemable = `position.units` − the sum of this
 * position's own *other* open redemptions (`OPEN_REDEMPTION_STATUSES`:
 * `pending`, and P5's `queued`) — so a second redemption submitted while
 * a first one hasn't settled yet can't also pass the balance check and
 * double-spend the same units. Combined with the series row lock, two
 * concurrent `redeem_notes` calls for the same agent can never both read a
 * stale `positionUnits` snapshot.
 *
 * Fix round 2 (C1 race, item 2): the series row AND the agent's own
 * `note_positions` row are both locked with `SELECT … FOR UPDATE`
 * *before* `units`/the open-redemption sum are read. Lock order
 * everywhere in this module is **series row, then position row** (never
 * the reverse) — the settlement, the queue and cancellation follow it too.
 *
 * P5 Task 3 (redemption gate): it is paid now only if no redemption is
 * already queued (FIFO: nobody jumps the queue) and paying it keeps the
 * bank's available cash at or above the reserve floor on the notes left
 * (`redemptionPayable`). Otherwise it is created `queued` (no payout) and
 * the tick pays it in order once cash allows (`processRedemptionQueue`).
 * This replaces P1's INSUFFICIENT_LIQUIDITY refusal: a redemption larger
 * than the available cash waits in the queue instead.
 */
export async function beginNoteRedemption(
  tx: Db,
  worldId: string,
  agentId: string,
  amountCents: bigint,
): Promise<RedeemNotesOutcome> {
  const seriesId = await getNoteSeriesId(tx, worldId);
  // Lock order: series row, then position row (see doc comment above).
  await scoped(tx, worldId).forUpdate(noteSeries, eq(noteSeries.id, seriesId));

  const positionRow = await scoped(tx, worldId).findOne(
    notePositions,
    and(eq(notePositions.seriesId, seriesId), eq(notePositions.agentId, agentId))!,
  );
  // Lock the position row itself (if it exists) before trusting its
  // `units` or querying its open redemptions — a brand-new agent with
  // no position row yet has nothing to lock, and trivially redeems 0.
  const position = positionRow
    ? (await scoped(tx, worldId).forUpdate(notePositions, eq(notePositions.id, positionRow.id)))[0]
    : undefined;
  const positionUnits = position?.units ?? 0n;

  const openRedemptions = position
    ? await scoped(tx, worldId).select(
        noteTransactions,
        and(
          eq(noteTransactions.positionId, position.id),
          eq(noteTransactions.kind, "redeem"),
          inArray(noteTransactions.status, [...OPEN_REDEMPTION_STATUSES]),
        )!,
      )
    : [];
  const openRedeemCents = openRedemptions.reduce((sum, row) => sum + row.amountCents, 0n);
  const redeemableUnits = positionUnits - openRedeemCents;

  if (amountCents > redeemableUnits) {
    return { outcome: "insufficient_note_balance", redeemableUnits };
  }

  const [agent] = await scoped(tx, worldId).select(agents, eq(agents.id, agentId));
  const recipientType = payoutRecipientType(agent?.payoutReceiverType ?? null);
  if (!agent || !agent.payoutReceiver || !recipientType) {
    // Fix round 1 (M1): a clean domain outcome, not a thrown error — the
    // tool maps this to 400 `PAYOUT_RECEIVER_MISSING`.
    return { outcome: "payout_receiver_missing" };
  }

  // P5 Task 3: the redemption gate.
  const policy = await getTreasuryPolicy(tx, worldId);
  const availableLiquidityCents = await availableLiquidity(tx, worldId);
  const totals = await redemptionTotals(tx, worldId);
  const notesOutstandingCents = (await notesPayableCents(tx, worldId)) - totals.pendingCents;
  const payable =
    totals.queuedCount === 0 &&
    redemptionPayable(availableLiquidityCents, notesOutstandingCents, amountCents, policy?.reserveFloorBps ?? 0);

  if (!payable) {
    const [queued] = await scoped(tx, worldId).insert(noteTransactions, {
      positionId: position!.id,
      kind: "redeem",
      amountCents,
      status: "queued",
      queuedAt: sql`clock_timestamp()` as unknown as Date,
    });
    if (!queued) {
      throw new Error("Expected a note_transactions row to be inserted");
    }
    const queue = await queuePosition(tx, worldId, queued.id);
    return { outcome: "queued", noteTxId: queued.id, queue: queue! };
  }

  const [noteTx] = await scoped(tx, worldId).insert(noteTransactions, {
    positionId: position!.id,
    kind: "redeem",
    amountCents,
    status: "pending",
  });
  if (!noteTx) {
    throw new Error("Expected a note_transactions row to be inserted");
  }

  const operationId = await enqueueRedemptionPayout(tx, worldId, noteTx.id, amountCents, agent.payoutReceiver, recipientType);
  return { outcome: "submitted", noteTxId: noteTx.id, payoutOperationId: operationId };
}

async function enqueueRedemptionPayout(
  tx: Db,
  worldId: string,
  noteTxId: string,
  amountCents: bigint,
  receiver: string,
  receiverType: NonNullable<ReturnType<typeof payoutRecipientType>>,
): Promise<string> {
  const rail = await railForWorld(tx, worldId);
  const { operationId } = await enqueueOperation(tx, {
    worldId,
    rail,
    kind: "payout.send",
    purpose: "note_redemption",
    sourceId: noteTxId,
    request: buildSendPayoutRequest({
      receiver,
      receiverType,
      amountCents,
      note: "Mandate note redemption",
      senderItemId: noteTxId,
    }),
  });
  await scoped(tx, worldId).update(noteTransactions, { opId: operationId }, eq(noteTransactions.id, noteTxId));
  return operationId;
}

/** The world's queued redemptions, oldest first (`queued_at`, then id). */
async function queuedRedemptions(db: Db, worldId: string): Promise<Array<typeof noteTransactions.$inferSelect>> {
  const rows = await scoped(db, worldId).select(
    noteTransactions,
    and(eq(noteTransactions.kind, "redeem"), eq(noteTransactions.status, "queued"))!,
  );
  return rows.sort(
    (a, b) =>
      (a.queuedAt?.getTime() ?? 0) - (b.queuedAt?.getTime() ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

/**
 * P5 Task 3: where queued redemption `noteTxId` stands, or `null` if it
 * isn't queued. `cashNeededCents` is how much more available cash would
 * let the bank pay everything ahead of it and it, keeping the floor.
 */
export async function queuePosition(db: Db, worldId: string, noteTxId: string): Promise<QueuePosition | null> {
  const queue = await queuedRedemptions(db, worldId);
  const index = queue.findIndex((row) => row.id === noteTxId);
  if (index < 0) {
    return null;
  }
  const aheadCents = queue.slice(0, index).reduce((sum, row) => sum + row.amountCents, 0n);
  const through = aheadCents + queue[index]!.amountCents;
  const policy = await getTreasuryPolicy(db, worldId);
  const available = await availableLiquidity(db, worldId);
  const totals = await redemptionTotals(db, worldId);
  const notesOutstanding = (await notesPayableCents(db, worldId)) - totals.pendingCents;
  const floorBps = policy?.reserveFloorBps ?? 0;
  const floor = reserveFloorCents(notesOutstanding - through, floorBps);
  const needed = through + floor - available;
  return {
    position: index + 1,
    aheadCents,
    reserveFloorCents: floor,
    availableLiquidityCents: available,
    cashNeededCents: needed > 0n ? needed : 0n,
    reason: index > 0 && redemptionPayable(available, notesOutstanding, queue[index]!.amountCents, floorBps)
      ? "queue_ahead"
      : "reserve_floor",
  };
}

/** Each holder's queued redemptions with their queue positions (for `get_status`/`get_statement`). */
export async function queuedRedemptionsFor(
  db: Db,
  worldId: string,
  agentId: string,
): Promise<Array<{ noteTxId: string; amountCents: bigint; queuedAt: Date | null; position: number }>> {
  const queue = await queuedRedemptions(db, worldId);
  if (queue.length === 0) {
    return [];
  }
  const positions = await scoped(db, worldId).select(notePositions, eq(notePositions.agentId, agentId));
  const ids = new Set(positions.map((row) => row.id));
  return queue
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => ids.has(row.positionId))
    .map(({ row, index }) => ({ noteTxId: row.id, amountCents: row.amountCents, queuedAt: row.queuedAt, position: index + 1 }));
}

export interface ProcessQueueResult {
  /** Redemptions promoted `queued -> pending` (their payouts were then executed). */
  paid: number;
  /** Redemptions failed at promotion (the holder no longer has a payout receiver). */
  failed: number;
  /** Still queued after this run. */
  remaining: number;
}

/**
 * P5 Task 3 (Review Focus 4): pays queued redemptions in FIFO order while
 * cash allows. Under the note series lock (then each position's row, the
 * module's lock order), from the head of the queue: if
 * `redemptionPayable(available liquidity, notes outstanding, amount)` holds
 * — so it never pays more than the cash available, and keeps the floor —
 * the redemption moves `queued -> pending` and its payout is enqueued
 * (available liquidity drops by it, as for any pending redemption); the
 * first one that doesn't fit stops the run (no smaller one jumps it).
 * After commit each promoted payout is executed through the normal
 * settlement (`applyRedemptionPayoutOutcome`; a failure there leaves it
 * pending for the reconcile cron). A holder whose payout receiver vanished
 * meanwhile has its redemption failed (the reserved units are its own
 * again: Ruling P4-D applies). Called by the tick for every world;
 * never inside a transaction.
 */
export async function processRedemptionQueue(db: Db, worldId: string): Promise<ProcessQueueResult> {
  if ((await queuedRedemptions(db, worldId)).length === 0) {
    return { paid: 0, failed: 0, remaining: 0 }; // Unlocked pre-check: an empty queue takes no locks.
  }
  const simAt = await getSimNow(db, worldId);
  const result = await db.transaction(async (tx) => {
    const seriesId = await getNoteSeriesId(tx, worldId);
    await scoped(tx, worldId).forUpdate(noteSeries, eq(noteSeries.id, seriesId));
    const policy = await getTreasuryPolicy(tx, worldId);
    const queue = await queuedRedemptions(tx, worldId);
    const promoted: string[] = [];
    let failed = 0;
    let handled = 0;
    for (const row of queue) {
      const available = await availableLiquidity(tx, worldId);
      const totals = await redemptionTotals(tx, worldId);
      const notesOutstanding = (await notesPayableCents(tx, worldId)) - totals.pendingCents;
      if (!redemptionPayable(available, notesOutstanding, row.amountCents, policy?.reserveFloorBps ?? 0)) {
        break;
      }
      const [position] = await scoped(tx, worldId).forUpdate(notePositions, eq(notePositions.id, row.positionId));
      if (!position) {
        throw new Error(`note_positions row ${row.positionId} not found in world ${worldId}`);
      }
      handled += 1;
      const [agent] = await scoped(tx, worldId).select(agents, eq(agents.id, position.agentId));
      const recipientType = payoutRecipientType(agent?.payoutReceiverType ?? null);
      if (!agent || !agent.payoutReceiver || !recipientType) {
        const updated = await scoped(tx, worldId).update(
          noteTransactions,
          { status: "failed" },
          and(eq(noteTransactions.id, row.id), eq(noteTransactions.status, "queued"))!,
        );
        if (updated.length === 1) {
          failed += 1;
          await settleDeferredHolderLosses(tx, worldId, {
            positionId: position.id,
            agentId: position.agentId,
            redemptionId: row.id,
            outcome: "failed",
            simAt,
          });
        }
        continue;
      }
      const updated = await scoped(tx, worldId).update(
        noteTransactions,
        { status: "pending" },
        and(eq(noteTransactions.id, row.id), eq(noteTransactions.status, "queued"))!,
      );
      if (updated.length !== 1) {
        continue;
      }
      promoted.push(
        await enqueueRedemptionPayout(tx, worldId, row.id, row.amountCents, agent.payoutReceiver, recipientType),
      );
    }
    return { promoted, failed, remaining: queue.length - handled };
  });
  for (const operationId of result.promoted) {
    try {
      await applyRedemptionPayoutOutcome(db, operationId);
    } catch (err) {
      // Stays pending; the reconcile cron polls it.
      console.error(`[notes] queued redemption payout ${operationId} failed to settle: ${describeError(err)}`);
    }
  }
  return { paid: result.promoted.length, failed: result.failed, remaining: result.remaining };
}

export type CancelRedemptionOutcome =
  | { outcome: "not_found" }
  | { outcome: "not_queued"; status: string }
  | { outcome: "cancelled"; amountCents: bigint };

/**
 * P5 Task 3: the holder withdraws one of its own QUEUED redemptions
 * (`queued -> cancelled`; nothing was paid, so nothing is journaled). Its
 * units are the holder's again, so a deferred charge-off loss share on
 * them now applies (Ruling P4-D, like a failed redemption). A redemption
 * already `pending` (its payout is on its way) can't be cancelled. Locks:
 * series row, then the position row.
 */
export async function cancelQueuedRedemption(
  tx: Db,
  worldId: string,
  agentId: string,
  noteTxId: string,
): Promise<CancelRedemptionOutcome> {
  const seriesId = await getNoteSeriesId(tx, worldId);
  await scoped(tx, worldId).forUpdate(noteSeries, eq(noteSeries.id, seriesId));
  const noteTx = await scoped(tx, worldId).findOne(
    noteTransactions,
    and(eq(noteTransactions.id, noteTxId), eq(noteTransactions.kind, "redeem"))!,
  );
  if (!noteTx) {
    return { outcome: "not_found" };
  }
  const [position] = await scoped(tx, worldId).forUpdate(notePositions, eq(notePositions.id, noteTx.positionId));
  if (!position || position.agentId !== agentId) {
    return { outcome: "not_found" }; // Fail closed: someone else's redemption looks like none.
  }
  const updated = await scoped(tx, worldId).update(
    noteTransactions,
    { status: "cancelled" },
    and(eq(noteTransactions.id, noteTx.id), eq(noteTransactions.status, "queued"))!,
  );
  if (updated.length !== 1) {
    return { outcome: "not_queued", status: noteTx.status };
  }
  await settleDeferredHolderLosses(tx, worldId, {
    positionId: position.id,
    agentId,
    redemptionId: noteTx.id,
    outcome: "cancelled",
    simAt: await getSimNow(tx, worldId),
  });
  return { outcome: "cancelled", amountCents: noteTx.amountCents };
}

/**
 * Settles a redemption payout (Rulings B/J/Q/R), idempotent and safe to
 * call from `ctx.afterCommit` (Task 5) as well as later from a webhook
 * (with `observed`) or the reconcile cron (via `pollPayoutStatus`).
 * Never call inside a transaction.
 *
 * `resolvePayoutOutcome` (services/payoutStatus.ts) executes the
 * `payout.send` operation and resolves the item's status — from a
 * succeeded cancel, `observed`, the newest `payout.get` read of the
 * batch, or the send result, in that order:
 * - `SUCCESS` journals the redemption (Dr `notes_payable[agent]` / Cr
 *   `cash_paypal`) and reduces the position's units;
 * - `FAILED`/`RETURNED`/`BLOCKED`/`REFUNDED`/`DENIED` (or a terminally
 *   failed operation) fails the redemption with the position untouched;
 * - `UNCLAIMED` (Ruling R) keeps the redemption `pending` (still reserved
 *   against liquidity and the redeemable balance) while the item is
 *   cancelled; once it is RETURNED the failure above applies;
 * - everything else (no item yet, `PENDING`, `ONHOLD`, …) stays pending.
 *
 * Fix round 1 (I1): the conditional `pending -> completed` transition,
 * the journal post, and the position decrement all happen in ONE
 * transaction, with the journal posted only after the conditional
 * update wins.
 */
export async function applyRedemptionPayoutOutcome(
  db: Db,
  operationId: string,
  observed?: ObservedPayoutStatus,
): Promise<void> {
  const record = await getOperation(db, operationId);
  if (!record || record.kind !== "payout.send" || !record.sourceId) {
    return;
  }
  const worldId = record.worldId;
  const noteTxId = record.sourceId;

  const noteTx = await scoped(db, worldId).findOne(noteTransactions, eq(noteTransactions.id, noteTxId));
  if (!noteTx || noteTx.kind !== "redeem" || noteTx.status !== "pending") {
    // Nothing to do: unknown row, wrong kind, or already settled.
    return;
  }

  const resolution = await resolvePayoutOutcome(db, operationId, observed);
  if (resolution.kind === "pending") {
    return; // Still in flight / unclaimed; a later call (cron/webhook, Task 8) retries.
  }
  if (resolution.kind === "failed") {
    const failedAt = await getSimNow(db, worldId);
    await db.transaction(async (tx) => {
      const failed = await scoped(tx, worldId).update(
        noteTransactions,
        { status: "failed" },
        and(eq(noteTransactions.id, noteTx.id), eq(noteTransactions.status, "pending")),
      );
      if (failed.length !== 1) {
        return;
      }
      // Ruling P4-D: units this redemption reserved are the holder's again —
      // a charged-off loan's deferred loss share now applies (series → position locks).
      const [position] = await scoped(tx, worldId).select(notePositions, eq(notePositions.id, noteTx.positionId));
      if (!position) {
        return;
      }
      await scoped(tx, worldId).forUpdate(noteSeries, eq(noteSeries.id, position.seriesId));
      await scoped(tx, worldId).forUpdate(notePositions, eq(notePositions.id, position.id));
      await settleDeferredHolderLosses(tx, worldId, {
        positionId: position.id,
        agentId: position.agentId,
        redemptionId: noteTx.id,
        outcome: "failed",
        simAt: failedAt,
      });
    });
    return;
  }

  const position = await scoped(db, worldId).findOne(
    notePositions,
    eq(notePositions.id, noteTx.positionId),
  );
  if (!position) {
    throw new Error(`note_positions row ${noteTx.positionId} not found in world ${worldId}`);
  }

  const simAt = await getSimNow(db, worldId);

  // Fix round 2 (C1 race, item 2): same lock order as `beginNoteRedemption`
  // — series row, then position row — acquired before the position is
  // mutated, so a concurrent redemption request and this settlement can
  // never deadlock against each other.
  await db.transaction(async (tx) => {
    const updated = await scoped(tx, worldId).update(
      noteTransactions,
      { status: "completed" },
      and(eq(noteTransactions.id, noteTx.id), eq(noteTransactions.status, "pending")),
    );
    if (updated.length !== 1) {
      return;
    }

    await scoped(tx, worldId).forUpdate(noteSeries, eq(noteSeries.id, position.seriesId));
    const [lockedPosition] = await scoped(tx, worldId).forUpdate(
      notePositions,
      eq(notePositions.id, position.id),
    );

    await postJournal(tx, {
      worldId,
      memo: "Note redeemed",
      sourceType: "note_transactions",
      sourceId: noteTx.id,
      simAt,
      idempotencyKey: journalKey("note_redemption", noteTx.id),
      postings: [
        { accountCode: "notes_payable", ownerRef: position.agentId, amountCents: noteTx.amountCents },
        { accountCode: "cash_paypal", amountCents: -noteTx.amountCents },
      ],
    });
    if (resolution.fee) {
      // Task 10b: the payout's PayPal fee, same transaction (once per batch).
      await postPayoutFee(
        tx,
        { worldId, simAt, sourceType: "note_transactions", sourceId: noteTx.id },
        resolution.fee,
      );
    }

    if (lockedPosition) {
      await scoped(tx, worldId).update(
        notePositions,
        {
          units: lockedPosition.units - noteTx.amountCents,
          // Task 7: units include earned interest (credited on repayment)
          // but the cost basis doesn't, so redeeming the interest must not
          // drive the cost basis below zero.
          costCents:
            lockedPosition.costCents > noteTx.amountCents ? lockedPosition.costCents - noteTx.amountCents : 0n,
        },
        eq(notePositions.id, lockedPosition.id),
      );
      // Ruling P4-D: a deferred loss share these units backed is absorbed by the bank.
      await settleDeferredHolderLosses(tx, worldId, {
        positionId: lockedPosition.id,
        agentId: lockedPosition.agentId,
        redemptionId: noteTx.id,
        outcome: "completed",
        simAt,
      });
    }
  });
}
