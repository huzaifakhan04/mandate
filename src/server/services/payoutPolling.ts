import { eq } from "drizzle-orm";

import { getSimNow } from "../clock/clock";
import type { Db } from "../db/client";
import { journalEntries, loans, noteTransactions, repayments } from "../db/schema";
import { scoped } from "../db/scoped";
import {
  buildGetPayoutRequest,
  enqueueReadOperation,
  executeOperation,
  getOperation,
  latestPayoutGetForSend,
  payoutPollTimes,
  type PayoutSendResult,
} from "../paypal/operations";
import { applyPayoutOutcome } from "./loans";
import { applyRedemptionPayoutOutcome } from "./notes";
import type { ObservedPayoutStatus } from "./payoutStatus";
import { knownPayoutFee, payoutFeeJournalKey, postPayoutFee, type KnownPayoutFee } from "./paypalFees";
import { isPollDue, pollIntervalMs } from "./pollThrottle";
import { applyRemainderPayoutOutcome, refreshRepaymentLink, remainderPayoutNeedsPolling } from "./repayments";
import { railForWorld } from "./worlds";

/** Re-exported: the age-based interval now lives in the shared throttle helper. */
export { pollIntervalMs };

export type PollPayoutReason =
  | "not_a_payout_send"
  | "unsupported_purpose"
  | "source_settled"
  | "throttled"
  | "send_not_succeeded"
  | "polled"
  /** Task 10b: the source had settled but its batch fee wasn't known yet; a read was made for it. */
  | "fee_polled";

export interface PollPayoutResult {
  /** Whether a `payout.get` read was enqueued and executed by this call. */
  polled: boolean;
  reason: PollPayoutReason;
}

/** Whether the send's source still awaits its payout outcome (loan DISBURSING / redemption pending). */
async function sourceNeedsPolling(db: Db, worldId: string, purpose: string, sourceId: string): Promise<boolean> {
  if (purpose === "loan_disbursement") {
    const loan = await scoped(db, worldId).findOne(loans, eq(loans.id, sourceId));
    return loan?.status === "disbursing";
  }
  if (purpose === "remainder_payout") {
    return remainderPayoutNeedsPolling(db, worldId, sourceId);
  }
  const noteTx = await scoped(db, worldId).findOne(noteTransactions, eq(noteTransactions.id, sourceId));
  return noteTx?.kind === "redeem" && noteTx.status === "pending";
}

/** Task 10b: whether the send's source settled as a SUCCESS (the payout effect was applied). */
async function sourceSucceeded(db: Db, worldId: string, purpose: string, sourceId: string): Promise<boolean> {
  if (purpose === "loan_disbursement") {
    const loan = await scoped(db, worldId).findOne(loans, eq(loans.id, sourceId));
    return !!loan?.disbursedSimAt;
  }
  if (purpose === "remainder_payout") {
    const repayment = await scoped(db, worldId).findOne(repayments, eq(repayments.id, sourceId));
    return repayment?.remainderStatus === "paid";
  }
  const noteTx = await scoped(db, worldId).findOne(noteTransactions, eq(noteTransactions.id, sourceId));
  return noteTx?.kind === "redeem" && noteTx.status === "completed";
}

const FEE_SOURCE_TYPE: Record<string, string> = {
  loan_disbursement: "loans",
  note_redemption: "note_transactions",
  remainder_payout: "repayments",
};

export type PayoutFeeState =
  /** Not a succeeded payout send of a known purpose, or its source hasn't (or didn't) succeed. */
  | "not_applicable"
  /** Known (and journaled, when non-zero). */
  | "known"
  /** The source succeeded but no read so far reported the batch's fee. */
  | "unknown";

/**
 * Task 10b: journals a settled payout's PayPal fee when the payout's
 * success was applied without it (the fee showed up only in a later
 * `payout.get`) — `paypal_fee:payout:<batchId>`, idempotent, so calling it
 * after every poll/webhook is safe. Only once the source succeeded (the
 * applier itself journals a fee already known at success, in its own
 * transaction). Never call inside a transaction.
 */
export async function postPayoutFeeIfKnown(db: Db, sendOperationId: string): Promise<PayoutFeeState> {
  const inspected = await inspectPayoutFee(db, sendOperationId);
  if (inspected.state !== "known") {
    return inspected.state;
  }
  const { worldId, sourceId, sourceType, fee } = inspected;
  const journaled = await scoped(db, worldId).findOne(
    journalEntries,
    eq(journalEntries.idempotencyKey, payoutFeeJournalKey(fee.batchId)),
  );
  if (fee.feeCents > 0n && !journaled) {
    const simAt = await getSimNow(db, worldId);
    await db.transaction((tx) => postPayoutFee(tx, { worldId, simAt, sourceType, sourceId }, fee));
  }
  return "known";
}

type InspectedPayoutFee =
  | { state: "not_applicable" }
  | { state: "unknown"; worldId: string; purpose: string; sourceId: string; batchId: string }
  | { state: "known"; worldId: string; sourceId: string; sourceType: string; fee: KnownPayoutFee };

/** Read-only: whether a succeeded payout's batch fee is known yet (see `PayoutFeeState`). */
async function inspectPayoutFee(db: Db, sendOperationId: string): Promise<InspectedPayoutFee> {
  const record = await getOperation(db, sendOperationId);
  const sourceType = record?.purpose ? FEE_SOURCE_TYPE[record.purpose] : undefined;
  if (!record || record.kind !== "payout.send" || record.status !== "succeeded" || !record.sourceId || !sourceType) {
    return { state: "not_applicable" };
  }
  const { worldId, sourceId } = record;
  const purpose = record.purpose!;
  if (!(await sourceSucceeded(db, worldId, purpose, sourceId))) {
    return { state: "not_applicable" };
  }
  const send = record.body as PayoutSendResult;
  const fee = knownPayoutFee(send, await latestPayoutGetForSend(db, sendOperationId));
  if (!fee) {
    return { state: "unknown", worldId, purpose, sourceId, batchId: send.batchId };
  }
  return { state: "known", worldId, sourceId, sourceType, fee };
}

/** A settled payout whose PayPal fee was never reported (reconcile's `payout_fee_unknown`). */
export interface UnknownPayoutFee {
  purpose: string;
  sourceId: string;
  sendOperationId: string;
  batchId: string;
}

/**
 * Task 10b (controller item 3): read-only — the payout's details when its
 * source succeeded but no read ever reported the batch's fee, else `null`.
 * The reconcile cron lists these once they are older than
 * `PAYOUT_FEE_POLL_WINDOW_MS` (it stops polling for the fee then).
 */
export async function unknownPayoutFee(db: Db, sendOperationId: string): Promise<UnknownPayoutFee | null> {
  const inspected = await inspectPayoutFee(db, sendOperationId);
  return inspected.state === "unknown"
    ? { purpose: inspected.purpose, sourceId: inspected.sourceId, sendOperationId, batchId: inspected.batchId }
    : null;
}

/** Task 10b: how long after a send the cron keeps reading a settled batch for its (still unknown) fee. */
export const PAYOUT_FEE_POLL_WINDOW_MS = 72 * 60 * 60 * 1000;

/**
 * Task 10b: the source already settled. If it succeeded and its batch
 * fee isn't known yet (and the send is younger than
 * `PAYOUT_FEE_POLL_WINDOW_MS`), make one throttled `payout.get` read and
 * journal the fee if that read reports it. Otherwise nothing.
 */
async function pollSettledPayoutFee(db: Db, sendOperationId: string, now: Date): Promise<PollPayoutResult> {
  const settled: PollPayoutResult = { polled: false, reason: "source_settled" };
  if ((await postPayoutFeeIfKnown(db, sendOperationId)) !== "unknown") {
    return settled;
  }
  const times = await payoutPollTimes(db, sendOperationId);
  const record = await getOperation(db, sendOperationId);
  if (!times || !record || now.getTime() - times.sendCreatedAt.getTime() > PAYOUT_FEE_POLL_WINDOW_MS) {
    return settled;
  }
  if (!isPollDue({ createdAt: times.sendCreatedAt, lastReadAt: times.lastReadCreatedAt, now })) {
    return { polled: false, reason: "throttled" };
  }
  await readBatch(db, record.worldId, (record.body as PayoutSendResult).batchId);
  await postPayoutFeeIfKnown(db, sendOperationId);
  return { polled: true, reason: "fee_polled" };
}

/** Enqueues and executes one `payout.get` read of a batch. */
async function readBatch(db: Db, worldId: string, batchId: string): Promise<void> {
  const rail = await railForWorld(db, worldId);
  const { operationId } = await enqueueReadOperation(db, {
    worldId,
    rail,
    kind: "payout.get",
    request: buildGetPayoutRequest(batchId),
  });
  await executeOperation(db, operationId, { ignoreBackoff: true });
}

type PayoutApplier = (db: Db, operationId: string, observed?: ObservedPayoutStatus) => Promise<void>;

/** The outcome applier for each payout purpose (Ruling B). */
const PAYOUT_APPLIERS: Partial<Record<string, PayoutApplier>> = {
  loan_disbursement: applyPayoutOutcome,
  note_redemption: applyRedemptionPayoutOutcome,
  remainder_payout: applyRemainderPayoutOutcome,
};

/**
 * Ruling B: settles a `payout.send` operation with the applier for its
 * purpose — for a verified webhook (`observed` = the event's item
 * status, Ruling Q), `pollPayoutStatus` and the reconcile cron. After a
 * loan disbursement it also executes the loan's queued invoice-link
 * `order.create` (Task 7: an activation enqueues it; no-op without a
 * link). Returns `false` when the operation isn't a payout send with a
 * known purpose. Idempotent; never call inside a transaction.
 */
export async function dispatchPayoutOutcome(
  db: Db,
  sendOperationId: string,
  observed?: ObservedPayoutStatus,
): Promise<boolean> {
  const record = await getOperation(db, sendOperationId);
  const applier = record?.purpose ? PAYOUT_APPLIERS[record.purpose] : undefined;
  if (!record || record.kind !== "payout.send" || !record.sourceId || !applier) {
    return false;
  }
  await applier(db, sendOperationId, observed);
  if (record.purpose === "loan_disbursement") {
    await refreshRepaymentLink(db, record.worldId, record.sourceId);
  }
  // Task 10b: a fee that only became known after the success was applied.
  await postPayoutFeeIfKnown(db, sendOperationId);
  return true;
}

/**
 * Ruling Q: polls a `payout.send` operation's batch and settles it — for
 * Task 8's reconcile cron, which should log the returned `reason`. Never
 * call inside a transaction. Bounded (fix round 2):
 *
 * 1. Not a `payout.send`, or a purpose with no applier → nothing. Task 7
 *    adds `remainder_payout` (and, after a disbursement's applier, executes
 *    the loan's queued invoice-link create).
 * 2. The source (loan / redemption / remainder) is already settled →
 *    nothing, unless (Task 10b) it succeeded without its batch's PayPal
 *    fee being known yet: then one throttled read for the fee
 *    (`fee_polled`), within `PAYOUT_FEE_POLL_WINDOW_MS` of the send.
 * 3. The send hasn't succeeded yet (no batch id) → no read; the applier
 *    (re-)executes the send itself, respecting its backoff.
 * 4. Throttled: skips if the newest `payout.get` of this batch (any
 *    status) is younger than `pollIntervalMs(age of the send)`.
 * 5. Otherwise enqueues + executes one `payout.get` read, then runs the
 *    applier, which sees the read via `latestPayoutGetForSend`.
 *
 * `now` (real time, injectable for tests) is compared with the rows'
 * `created_at`.
 */
export async function pollPayoutStatus(
  db: Db,
  sendOperationId: string,
  { now = new Date() }: { now?: Date } = {},
): Promise<PollPayoutResult> {
  const record = await getOperation(db, sendOperationId);
  if (!record || record.kind !== "payout.send" || !record.sourceId) {
    return { polled: false, reason: "not_a_payout_send" };
  }
  if (!record.purpose || !PAYOUT_APPLIERS[record.purpose]) {
    return { polled: false, reason: "unsupported_purpose" };
  }
  const apply = (database: Db, opId: string) => dispatchPayoutOutcome(database, opId);

  if (!(await sourceNeedsPolling(db, record.worldId, record.purpose, record.sourceId))) {
    return pollSettledPayoutFee(db, sendOperationId, now);
  }

  if (record.status !== "succeeded") {
    await apply(db, sendOperationId);
    return { polled: false, reason: "send_not_succeeded" };
  }

  const times = await payoutPollTimes(db, sendOperationId);
  if (times && !isPollDue({ createdAt: times.sendCreatedAt, lastReadAt: times.lastReadCreatedAt, now })) {
    return { polled: false, reason: "throttled" };
  }

  await readBatch(db, record.worldId, (record.body as PayoutSendResult).batchId);
  await apply(db, sendOperationId);
  return { polled: true, reason: "polled" };
}
