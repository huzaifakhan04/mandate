import type { Db } from "../db/client";
import { postJournal } from "../ledger/postJournal";
import type { CaptureRecord, PayoutGetResult, PayoutSendResult } from "../paypal/operations";

/**
 * Task 10b (Ruling U): PayPal's processing fees are the bank's own
 * expense — Dr `paypal_fees_expense` / Cr `cash_paypal` — so `cash_paypal`
 * tracks the real PayPal balance (and available liquidity, which is cash
 * based, drops by the fee). They never touch an agent's sub-account, so
 * `get_statement` never shows them, and they don't change any borrower /
 * lender amount.
 *
 * Exactly once per PayPal object, via the journal idempotency key:
 * `paypal_fee:capture:<captureId>` and `paypal_fee:payout:<batchId>`.
 * Callers post them inside the same transaction as the capture effect /
 * payout-success effect, after its conditional status update wins.
 */

export function captureFeeJournalKey(captureId: string): string {
  return `paypal_fee:capture:${captureId}`;
}

export function payoutFeeJournalKey(batchId: string): string {
  return `paypal_fee:payout:${batchId}`;
}

interface FeeJournalSource {
  worldId: string;
  simAt: Date;
  /** The domain row the fee belongs to (same as the effect's journal). */
  sourceType: string;
  sourceId: string;
}

async function postFee(tx: Db, source: FeeJournalSource, memo: string, key: string, feeCents: bigint): Promise<void> {
  if (feeCents <= 0n) {
    return; // No fee (or a zero one): nothing to journal.
  }
  await postJournal(tx, {
    worldId: source.worldId,
    memo,
    sourceType: source.sourceType,
    sourceId: source.sourceId,
    simAt: source.simAt,
    idempotencyKey: key,
    postings: [
      { accountCode: "paypal_fees_expense", amountCents: feeCents },
      { accountCode: "cash_paypal", amountCents: -feeCents },
    ],
  });
}

/**
 * Journals a COMPLETED capture's PayPal fee (no-op when PayPal reported
 * none). Call with the transaction that applies the capture's effect.
 *
 * Known gap (review M5, accepted): a capture fee PayPal didn't report when
 * the capture was applied (no `seller_receivable_breakdown`) is NOT
 * back-filled later, and a capture that went to `review` (amount mismatch)
 * journals neither its cash nor its fee — an operator booking that capture
 * by hand must book its fee by hand too (Dr paypal_fees_expense / Cr
 * cash_paypal, key `paypal_fee:capture:<captureId>`).
 */
export async function postCaptureFee(
  tx: Db,
  source: FeeJournalSource,
  capture: Pick<CaptureRecord, "captureId"> & { paypalFeeCents?: string | null },
): Promise<void> {
  const fee = capture.paypalFeeCents ?? null;
  if (fee === null) {
    return;
  }
  await postFee(tx, source, "PayPal fee on capture", captureFeeJournalKey(capture.captureId), BigInt(fee));
}

export interface KnownPayoutFee {
  batchId: string;
  feeCents: bigint;
}

/**
 * The batch's fee once it is known for a SUCCESS item: from the newest
 * `payout.get` read whose item is SUCCESS and that reports a fee, else
 * from the send result under the same condition, else `null` (not known
 * yet — e.g. PayPal's live POST reports no fee; a later poll will). A
 * zero fee is known only on a final (SUCCESS) batch (fix round 3, M6).
 * Results stored before Task 10b have no `feeCents` at all (→ unknown).
 */
export function knownPayoutFee(send: PayoutSendResult, latestGet: PayoutGetResult | null): KnownPayoutFee | null {
  const fromGet = latestGet ? feeOf(latestGet.batchId, latestGet.batchStatus, latestGet.items[0], latestGet.feeCents) : null;
  return fromGet ?? feeOf(send.batchId, send.batchStatus, send.item, send.feeCents);
}

/**
 * One response's fee for a SUCCESS item, or `null`. Fix round 3 (M6): a
 * zero fee counts as known only once the batch itself is final
 * (`batch_status` SUCCESS) — PayPal may report `0.00` while the batch is
 * still processing and fill the real fee in later.
 */
function feeOf(
  batchId: string,
  batchStatus: string,
  item: { transactionStatus: string } | null | undefined,
  feeCents: string | null | undefined,
): KnownPayoutFee | null {
  if (item?.transactionStatus !== "SUCCESS" || feeCents === null || feeCents === undefined) {
    return null;
  }
  const cents = BigInt(feeCents);
  if (cents === 0n && batchStatus !== "SUCCESS") {
    return null;
  }
  return { batchId, feeCents: cents };
}

/** Journals a payout batch's PayPal fee. Call with the transaction that applies the payout's success. */
export async function postPayoutFee(tx: Db, source: FeeJournalSource, fee: KnownPayoutFee): Promise<void> {
  await postFee(tx, source, "PayPal fee on payout", payoutFeeJournalKey(fee.batchId), fee.feeCents);
}
