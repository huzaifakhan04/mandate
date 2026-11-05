import { and, eq, inArray } from "drizzle-orm";

import { getSimNow } from "../clock/clock";
import type { Db } from "../db/client";
import { agents, noteSeries, notePositions, noteTransactions } from "../db/schema";
import { scoped } from "../db/scoped";
import { postJournal } from "../ledger/postJournal";
import {
  buildCreateOrderRequest,
  buildSendPayoutRequest,
  enqueueOperation,
  executeOperation,
  getOperation,
  journalKey,
  type PayoutSendResult,
} from "../paypal/operations";
import { availableLiquidity } from "../domain/liquidity";
import { railForWorld } from "./worlds";
import { registerCaptureHandler, type CaptureApplyResult } from "./checkouts";

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
 */
async function applyNotePurchaseCaptureEffect(
  db: Db,
  worldId: string,
  simNow: Date,
  args: { createSourceId: string; orderId: string; capture: { amountCents: string } },
): Promise<CaptureApplyResult> {
  const noteTx = await scoped(db, worldId).findOne(
    noteTransactions,
    eq(noteTransactions.id, args.createSourceId),
  );
  if (!noteTx) {
    throw new Error(`note_transactions row ${args.createSourceId} not found in world ${worldId}`);
  }
  // Already settled (success or mismatch-review) — nothing to do; keeps
  // this safe to call on every replay without re-deriving the result.
  if (noteTx.status !== "pending") {
    return { outcome: "applied", summary: "Already captured.", data: { amount_cents: Number(noteTx.amountCents) } };
  }

  const amountCents = noteTx.amountCents;
  const capturedAmountCents = BigInt(args.capture.amountCents);

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

registerCaptureHandler("note_purchase", {
  resolveOwnerAgentId: resolveNotePurchaseOwnerAgentId,
  applyEffect: (db, worldId, simNow, args) => applyNotePurchaseCaptureEffect(db, worldId, simNow, args),
  applyFailure: applyNotePurchaseFailure,
});

// ---------------------------------------------------------------------
// redeem_notes
// ---------------------------------------------------------------------

export type RedeemNotesOutcome =
  | { outcome: "insufficient_note_balance"; redeemableUnits: bigint }
  | { outcome: "insufficient_liquidity"; availableLiquidityCents: bigint }
  | { outcome: "payout_receiver_missing" }
  | { outcome: "submitted"; noteTxId: string; payoutOperationId: string };

/** Redemption statuses that still count against the position (not yet settled either way). */
const OPEN_REDEMPTION_STATUSES = ["pending"] as const;

/**
 * `redeem_notes`'s transactional half: checks the amount against the
 * agent's *redeemable* balance and the world's available liquidity (both
 * computed under the note series row's lock, per Review Focus #4),
 * creates the redemption (`note_transactions` kind `redeem`, pending)
 * and enqueues the payout — never executes it inside the transaction.
 *
 * Fix round 1 (C1): redeemable = `position.units` − the sum of this
 * position's own *other* `redeem` transactions still `pending` — so a
 * second redemption submitted while a first one hasn't settled yet (its
 * payout item came back `PENDING`, or hasn't been executed at all) can't
 * also pass the balance check and double-spend the same units. Combined
 * with the series row lock, two concurrent `redeem_notes` calls for the
 * same agent can never both read a stale `positionUnits` snapshot.
 */
export async function beginNoteRedemption(
  tx: Db,
  worldId: string,
  agentId: string,
  amountCents: bigint,
): Promise<RedeemNotesOutcome> {
  const seriesId = await getNoteSeriesId(tx, worldId);
  // Row-lock the series so concurrent redemptions (or a future
  // accept_offer disbursement) can't both pass the liquidity check
  // against the same stale snapshot.
  await scoped(tx, worldId).forUpdate(noteSeries, eq(noteSeries.id, seriesId));

  const position = await scoped(tx, worldId).findOne(
    notePositions,
    and(eq(notePositions.seriesId, seriesId), eq(notePositions.agentId, agentId))!,
  );
  const positionUnits = position?.units ?? 0n;

  const pendingRedemptions = position
    ? await scoped(tx, worldId).select(
        noteTransactions,
        and(
          eq(noteTransactions.positionId, position.id),
          eq(noteTransactions.kind, "redeem"),
          inArray(noteTransactions.status, [...OPEN_REDEMPTION_STATUSES]),
        )!,
      )
    : [];
  const pendingRedeemCents = pendingRedemptions.reduce((sum, row) => sum + row.amountCents, 0n);
  const redeemableUnits = positionUnits - pendingRedeemCents;

  if (amountCents > redeemableUnits) {
    return { outcome: "insufficient_note_balance", redeemableUnits };
  }

  const availableLiquidityCents = await availableLiquidity(tx, worldId);
  if (amountCents > availableLiquidityCents) {
    return { outcome: "insufficient_liquidity", availableLiquidityCents };
  }

  const [agent] = await scoped(tx, worldId).select(agents, eq(agents.id, agentId));
  if (!agent || !agent.payoutReceiver) {
    // Fix round 1 (M1): a clean domain outcome, not a thrown error — the
    // tool maps this to 400 `PAYOUT_RECEIVER_MISSING`.
    return { outcome: "payout_receiver_missing" };
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

  const rail = await railForWorld(tx, worldId);
  const { operationId } = await enqueueOperation(tx, {
    worldId,
    rail,
    kind: "payout.send",
    purpose: "note_redemption",
    sourceId: noteTx.id,
    request: buildSendPayoutRequest({
      receiver: agent.payoutReceiver,
      receiverType: agent.payoutReceiverType === "paypal_id" ? "PAYPAL_ID" : "EMAIL",
      amountCents,
      note: "Mandate note redemption",
      senderItemId: noteTx.id,
    }),
  });

  await scoped(tx, worldId).update(noteTransactions, { opId: operationId }, eq(noteTransactions.id, noteTx.id));

  return { outcome: "submitted", noteTxId: noteTx.id, payoutOperationId: operationId };
}

/** Terminal payout item statuses that fail the redemption (Ruling J, Fix round 1 C2 — enumerated exactly). */
const FAILED_PAYOUT_ITEM_STATUSES = new Set([
  "FAILED",
  "UNCLAIMED",
  "RETURNED",
  "BLOCKED",
  "REFUNDED",
  "DENIED",
]);

/**
 * Settles a redemption payout (Ruling B/J), idempotent and safe to call
 * from `ctx.afterCommit` (Task 5) as well as later from a webhook or the
 * reconcile cron (Task 8). Fix round 1 (C2): reads the item's
 * `transactionStatus` strictly — `SUCCESS` journals the redemption (Dr
 * `notes_payable[agent]` / Cr `cash_paypal`) and reduces the position's
 * units; one of the enumerated terminal-failure statuses
 * (`FAILED`/`UNCLAIMED`/`RETURNED`/`BLOCKED`/`REFUNDED`/`DENIED`) fails
 * the redemption with the position left untouched; everything else —
 * `PENDING`, `ONHOLD`, `UNKNOWN`, or no item at all (a live PayPal
 * `payout.send` POST usually doesn't report the item yet) — leaves the
 * redemption `pending` for a later call (Task 8's cron, polling
 * `payout.get`). Looks the operation up by id alone (no `worldId` yet),
 * via `paypal/operations.getOperation` rather than reading
 * `paypal_operations` directly, to stay off the world-isolation guard's
 * denylist.
 *
 * Fix round 1 (I1): the conditional `pending -> completed` transition,
 * the journal post, and the position decrement all happen in ONE
 * transaction, with the journal posted only after the conditional
 * update wins.
 */
export async function applyRedemptionPayoutOutcome(db: Db, operationId: string): Promise<void> {
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

  // Actually attempt the payout (idempotent/no-op if it's already
  // final): nothing else executes a freshly-enqueued `payout.send`
  // operation. Respects backoff (no `ignoreBackoff`) so a cron retry
  // (Task 8) backs off correctly; a fresh `queued` row with no
  // `next_attempt_at` yet is still claimed immediately.
  const op = await executeOperation(db, operationId);

  if (op.status === "queued" || op.status === "in_flight" || op.status === "failed_retryable") {
    return; // Still in flight; a later call (cron/webhook, Task 8) retries.
  }

  if (op.status === "failed_terminal") {
    await scoped(db, worldId).update(
      noteTransactions,
      { status: "failed" },
      and(eq(noteTransactions.id, noteTx.id), eq(noteTransactions.status, "pending")),
    );
    return;
  }

  const body = op.body as PayoutSendResult;
  const transactionStatus = body.item?.transactionStatus;

  if (!transactionStatus) {
    return; // No item reported yet (typical for a live PayPal POST); stays pending.
  }

  if (transactionStatus !== "SUCCESS") {
    if (!FAILED_PAYOUT_ITEM_STATUSES.has(transactionStatus)) {
      return; // PENDING / ONHOLD / UNKNOWN / anything else not enumerated: stays pending.
    }
    await scoped(db, worldId).update(
      noteTransactions,
      { status: "failed" },
      and(eq(noteTransactions.id, noteTx.id), eq(noteTransactions.status, "pending")),
    );
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

  await db.transaction(async (tx) => {
    const updated = await scoped(tx, worldId).update(
      noteTransactions,
      { status: "completed" },
      and(eq(noteTransactions.id, noteTx.id), eq(noteTransactions.status, "pending")),
    );
    if (updated.length !== 1) {
      return;
    }

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

    const [lockedPosition] = await scoped(tx, worldId).forUpdate(
      notePositions,
      eq(notePositions.id, position.id),
    );
    if (lockedPosition) {
      await scoped(tx, worldId).update(
        notePositions,
        {
          units: lockedPosition.units - noteTx.amountCents,
          costCents: lockedPosition.costCents - noteTx.amountCents,
        },
        eq(notePositions.id, lockedPosition.id),
      );
    }
  });
}
