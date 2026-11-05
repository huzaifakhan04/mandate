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
import { railForWorld } from "./worlds";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/**
 * Minimum time between two `payout.get` reads of one send, backing off
 * with the send's age (real time): < 10 min → 1 min; < 1 h → 5 min;
 * < 24 h → 30 min; else 6 h.
 */
export function pollIntervalMs(sendAgeMs: number): number {
  if (sendAgeMs < 10 * MINUTE_MS) return MINUTE_MS;
  if (sendAgeMs < HOUR_MS) return 5 * MINUTE_MS;
  if (sendAgeMs < 24 * HOUR_MS) return 30 * MINUTE_MS;
  return 6 * HOUR_MS;
}

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
  const noteTx = await scoped(db, worldId).findOne(noteTransactions, eq(noteTransactions.id, sourceId));
  return noteTx?.kind === "redeem" && noteTx.status === "pending";
}

/**
 * Ruling Q: polls a `payout.send` operation's batch and settles it — for
 * Task 8's reconcile cron, which should log the returned `reason`. Never
 * call inside a transaction. Bounded (fix round 2):
 *
 * 1. Not a `payout.send`, or a purpose with no applier yet (e.g. Task 7's
 *    `remainder_payout`) → nothing.
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
  const apply =
    record.purpose === "loan_disbursement"
      ? applyPayoutOutcome
      : record.purpose === "note_redemption"
        ? applyRedemptionPayoutOutcome
        : null;
  if (!apply || !record.purpose) {
    return { polled: false, reason: "unsupported_purpose" };
  }

  if (!(await sourceNeedsPolling(db, record.worldId, record.purpose, record.sourceId))) {
    return { polled: false, reason: "source_settled" };
  }

  if (record.status !== "succeeded") {
    await apply(db, sendOperationId);
    return { polled: false, reason: "send_not_succeeded" };
  }

  const times = await payoutPollTimes(db, sendOperationId);
  if (times?.lastReadCreatedAt) {
    const interval = pollIntervalMs(now.getTime() - times.sendCreatedAt.getTime());
    if (now.getTime() - times.lastReadCreatedAt.getTime() < interval) {
      return { polled: false, reason: "throttled" };
    }
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
