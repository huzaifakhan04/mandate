import { eq } from "drizzle-orm";

import type { Db } from "../db/client";
import { loans, noteTransactions } from "../db/schema";
import { scoped } from "../db/scoped";
import {
  buildGetPayoutRequest,
  enqueueReadOperation,
  executeOperation,
  getOperation,
  payoutPollTimes,
  type PayoutSendResult,
} from "../paypal/operations";
import { applyPayoutOutcome } from "./loans";
import { applyRedemptionPayoutOutcome } from "./notes";
import type { ObservedPayoutStatus } from "./payoutStatus";
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
  | "polled";

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
 * 2. The source (loan / redemption) is already settled → nothing enqueued.
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
    return { polled: false, reason: "source_settled" };
  }

  if (record.status !== "succeeded") {
    await apply(db, sendOperationId);
    return { polled: false, reason: "send_not_succeeded" };
  }

  const times = await payoutPollTimes(db, sendOperationId);
  if (times && !isPollDue({ createdAt: times.sendCreatedAt, lastReadAt: times.lastReadCreatedAt, now })) {
    return { polled: false, reason: "throttled" };
  }

  const batchId = (record.body as PayoutSendResult).batchId;
  const rail = await railForWorld(db, record.worldId);
  const { operationId } = await enqueueReadOperation(db, {
    worldId: record.worldId,
    rail,
    kind: "payout.get",
    request: buildGetPayoutRequest(batchId),
  });
  await executeOperation(db, operationId, { ignoreBackoff: true });
  await apply(db, sendOperationId);
  return { polled: true, reason: "polled" };
}
