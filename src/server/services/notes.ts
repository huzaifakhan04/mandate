import { and, eq } from "drizzle-orm";

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
 * must never double-credit), guarded by a conditional
 * `pending -> completed` update on the note transaction so a replayed
 * capture (idempotent retry, or a second confirm_checkout call) never
 * re-applies the position increment.
 */
async function applyNotePurchaseCaptureEffect(
  db: Db,
  worldId: string,
  simNow: Date,
  args: { createSourceId: string; orderId: string },
): Promise<CaptureApplyResult> {
  const noteTx = await scoped(db, worldId).findOne(
    noteTransactions,
    eq(noteTransactions.id, args.createSourceId),
  );
  if (!noteTx) {
    throw new Error(`note_transactions row ${args.createSourceId} not found in world ${worldId}`);
  }

  const position = await scoped(db, worldId).findOne(
    notePositions,
    eq(notePositions.id, noteTx.positionId),
  );
  if (!position) {
    throw new Error(`note_positions row ${noteTx.positionId} not found in world ${worldId}`);
  }

  const amountCents = noteTx.amountCents;

  await postJournal(db, {
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

  await db.transaction(async (tx) => {
    const updated = await scoped(tx, worldId).update(
      noteTransactions,
      { status: "completed" },
      and(eq(noteTransactions.id, noteTx.id), eq(noteTransactions.status, "pending")),
    );
    if (updated.length === 1) {
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
    }
  });

  return {
    summary: `Captured ${amountCents.toString()} cents; ${amountCents.toString()} note units credited.`,
    data: { amount_cents: Number(amountCents), units_credited: Number(amountCents) },
  };
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
  applyEffect: (db, worldId, simNow, args) =>
    applyNotePurchaseCaptureEffect(db, worldId, simNow, args),
});

// ---------------------------------------------------------------------
// redeem_notes
// ---------------------------------------------------------------------

export type RedeemNotesOutcome =
  | { outcome: "insufficient_note_balance"; positionUnits: bigint }
  | { outcome: "insufficient_liquidity"; availableLiquidityCents: bigint }
  | { outcome: "submitted"; noteTxId: string; payoutOperationId: string };

/**
 * `redeem_notes`'s transactional half: checks the amount against the
 * agent's position and the world's available liquidity (both computed
 * under the note series row's lock, per Review Focus #4), creates the
 * redemption (`note_transactions` kind `redeem`, pending) and enqueues
 * the payout — never executes it inside the transaction.
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
  if (amountCents > positionUnits) {
    return { outcome: "insufficient_note_balance", positionUnits };
  }

  const availableLiquidityCents = await availableLiquidity(tx, worldId);
  if (amountCents > availableLiquidityCents) {
    return { outcome: "insufficient_liquidity", availableLiquidityCents };
  }

  const [agent] = await scoped(tx, worldId).select(agents, eq(agents.id, agentId));
  if (!agent || !agent.payoutReceiver) {
    throw new Error(`Agent ${agentId} has no payout receiver configured`);
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

/**
 * Settles a redemption payout (Ruling B/J), idempotent and safe to call
 * from `ctx.afterCommit` (Task 5) as well as later from a webhook or the
 * reconcile cron (Task 8): reads the item's `transactionStatus` —
 * `SUCCESS` journals the redemption (Dr `notes_payable[agent]` / Cr
 * `cash_paypal`) and reduces the position's units; any other terminal
 * status fails the redemption with the position left untouched; still
 * in flight/retryable leaves the redemption `pending` for a later call.
 * Looks the operation up by id alone (no `worldId` yet), via
 * `paypal/operations.getOperation` rather than reading
 * `paypal_operations` directly, to stay off the world-isolation guard's
 * denylist.
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
  const transactionStatus = body.item?.transactionStatus ?? "UNKNOWN";

  if (transactionStatus === "PENDING") {
    return; // Still settling on PayPal's side; Task 8's cron polls payout.get.
  }

  const position = await scoped(db, worldId).findOne(
    notePositions,
    eq(notePositions.id, noteTx.positionId),
  );
  if (!position) {
    throw new Error(`note_positions row ${noteTx.positionId} not found in world ${worldId}`);
  }

  if (transactionStatus !== "SUCCESS") {
    await scoped(db, worldId).update(
      noteTransactions,
      { status: "failed" },
      and(eq(noteTransactions.id, noteTx.id), eq(noteTransactions.status, "pending")),
    );
    return;
  }

  const simAt = await getSimNow(db, worldId);
  await postJournal(db, {
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

  await db.transaction(async (tx) => {
    const updated = await scoped(tx, worldId).update(
      noteTransactions,
      { status: "completed" },
      and(eq(noteTransactions.id, noteTx.id), eq(noteTransactions.status, "pending")),
    );
    if (updated.length === 1) {
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
    }
  });
}
