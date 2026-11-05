import type { Db } from "../db/client";
import {
  buildGetPayoutRequest,
  enqueueReadOperation,
  executeOperation,
  getOperation,
  type PayoutSendResult,
} from "../paypal/operations";
import { applyPayoutOutcome } from "./loans";
import { applyRedemptionPayoutOutcome } from "./notes";
import { railForWorld } from "./worlds";

/**
 * Ruling Q: polls a `payout.send` operation's batch and settles it — for
 * Task 8's reconcile cron. Never call inside a transaction.
 *
 * If the send has succeeded (so a batch id exists), enqueues and executes
 * a `payout.get` read of that batch; the outcome appliers then see the
 * item's live status through `latestPayoutGetForSend`. Then dispatches to
 * the applier for the send's purpose (`loan_disbursement` →
 * `applyPayoutOutcome`, `note_redemption` → `applyRedemptionPayoutOutcome`);
 * the appliers also (re-)execute a send that hasn't succeeded yet.
 * Other purposes (e.g. Task 7's `remainder_payout`) are ignored here
 * until their applier exists.
 */
export async function pollPayoutStatus(db: Db, sendOperationId: string): Promise<void> {
  const record = await getOperation(db, sendOperationId);
  if (!record || record.kind !== "payout.send") {
    return;
  }

  if (record.status === "succeeded") {
    const batchId = (record.body as PayoutSendResult).batchId;
    const rail = await railForWorld(db, record.worldId);
    const { operationId } = await enqueueReadOperation(db, {
      worldId: record.worldId,
      rail,
      kind: "payout.get",
      request: buildGetPayoutRequest(batchId),
    });
    await executeOperation(db, operationId, { ignoreBackoff: true });
  }

  switch (record.purpose) {
    case "loan_disbursement":
      await applyPayoutOutcome(db, sendOperationId);
      return;
    case "note_redemption":
      await applyRedemptionPayoutOutcome(db, sendOperationId);
      return;
    default:
      return;
  }
}
