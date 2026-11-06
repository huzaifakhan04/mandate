import { and, eq, inArray } from "drizzle-orm";

import { getSimNow } from "../clock/clock";
import type { NextAction } from "../contracts/envelope";
import type { Db } from "../db/client";
import {
  agents,
  applications,
  events,
  journalEntries,
  ledgerAccounts,
  loanHolderLosses,
  loans,
  noteSeries,
  notePositions,
  offers,
  paypalOperations,
  postings,
  repaymentLinks,
  repayments,
} from "../db/schema";
import { scoped } from "../db/scoped";
import { distribute } from "../domain/distribution";
import { fromDbStatus, isOwingStatus, toDbStatus, transition } from "../domain/loanMachine";
import { holdersShare, waterfall } from "../domain/waterfall";
import { getAccountBalance } from "../ledger/trialBalance";
import { postJournal } from "../ledger/postJournal";
import {
  amountToCents,
  buildCreateOrderRequest,
  buildSendPayoutRequest,
  deriveOperationId,
  enqueueOperation,
  getOperation,
  journalKey,
  type ExecuteOperationOptions,
  type OperationPurpose,
  type OrderCaptureResult,
} from "../paypal/operations";
import { registerCaptureHandler, type CaptureApplyResult } from "./checkouts";
import {
  accruePenaltyLocked,
  onLoanCured,
  onLoanRecovery,
  outstandingParts,
  recoverableCents,
  totalDueCents,
} from "./collections";
import { registerLoanActivatedHook } from "./loans";
import { payoutRecipientType, resolvePayoutOutcome, type ObservedPayoutStatus } from "./payoutStatus";
import { checkoutUrl, refreshLinkRow } from "./paymentLinks";
import { postCaptureFee, postPayoutFee } from "./paypalFees";
import { railForWorld } from "./worlds";

/**
 * Task 7 — repayment: the invoice payment link, `repay_loan`'s direct
 * checkout, the waterfall, the holders' share, remainder payouts and
 * `get_statement`.
 *
 * Money flow (Global Constraints journal templates):
 * - capture of gross G against outstanding late fees L', penalty N',
 *   fee F' and principal P' (P4 waterfall: late fees → penalty → fee →
 *   principal → remainder): Dr `cash_paypal` G / Cr `late_fee_income` l /
 *   Cr `penalty_income` n / Cr `fee_income` f / Cr `loans_receivable` p /
 *   Cr `payable_to_borrower[borrower]` r. Late fees and the penalty are
 *   recognised here, on collection (they were memo balances on the loan —
 *   `services/collections.ts`);
 * - holders' share of the BASE fee collected by this capture (never the
 *   late fees or penalty — those are the bank's), cumulative so
 *   flooring never loses a cent across partial payments:
 *   H = floor((F_before+f)×80/100) − floor(F_before×80/100),
 *   Dr `note_interest_expense` H / Cr `notes_payable[holder_i]` h_i,
 *   distributed pro rata over the series' positions at that moment
 *   (largest remainder). Each holder's position `units` also grows by h_i
 *   (and `accrued_cents`, the "earned" figure) — units are the holder's
 *   redeemable cents, so earned interest is redeemable and, for every
 *   holder, `units == −balance(notes_payable[holder])` stays true. With
 *   no holders at all H stays with the bank (no holders' journal);
 * - remainder r > 0 is paid back to the borrower by a `remainder_payout`
 *   (Dr `payable_to_borrower` / Cr `cash_paypal` once SUCCESS). A failed
 *   payout leaves r owed in `payable_to_borrower` (get_status shows it).
 *
 * P4 Task 2 — recovery: a capture on a CHARGED_OFF (or already RECOVERED)
 * loan — the guarantee link, the old invoice link or a direct repayment —
 * recovers rc = min(G, written-off total − recovered so far):
 * Dr `cash_paypal` G / Cr `recoveries_income` rc / Cr
 * `payable_to_borrower[borrower]` G − rc (the excess goes back by the
 * remainder payout, exactly as above). Holders are made whole first: hc =
 * min(rc, Σ their losses not yet credited back), distributed pro rata to
 * what each is still owed (so never above its loss), Dr
 * `recoveries_income` hc / Cr `notes_payable[holder_i]`, units += share
 * (Ruling T). The bank keeps rc − hc (its own principal loss, the fees).
 * Fully recovered → RECOVERED (agent restored, freeze lifted); partial →
 * stays CHARGED_OFF with `recovered_cents`. A payment on a RECOVERED loan
 * recovers nothing: it is all remainder (Review Focus 4).
 *
 * Lock order inside the capture transaction: note series row → loan row
 * → note positions. It extends Ruling N (series before positions) and
 * matches activation/`accept_offer` (series before the loan/offer row),
 * so it can't deadlock with any of them.
 */

const MANDATE_POOL_A_NAME = "Mandate Pool A";
/** PayPal's `purchase_units[].description` limit. */
const PAYPAL_DESCRIPTION_MAX = 127;

type LoanRow = typeof loans.$inferSelect;
type LinkRow = typeof repaymentLinks.$inferSelect;
type RepaymentRow = typeof repayments.$inferSelect;

/** The open (unsettled) link statuses a capture may settle or a failure may close. */
const OPEN_LINK_STATUSES = ["pending", "open"];

async function appendEvent(
  tx: Db,
  worldId: string,
  event: { type: string; aggregateId: string; simAt: Date; payload?: Record<string, unknown> },
): Promise<void> {
  await scoped(tx, worldId).insert(events, {
    type: event.type,
    aggregateType: "loan",
    aggregateId: event.aggregateId,
    payload: event.payload ?? null,
    occurredSimAt: event.simAt,
  });
}

/** What's still owed on a loan by bucket (moved to `collections.ts` in P4; re-exported). */
export { outstandingParts, totalDueCents } from "./collections";

// ---------------------------------------------------------------------
// The invoice payment link
// ---------------------------------------------------------------------

interface InvoiceRef {
  client_email?: string;
  amount_cents?: number;
  description?: string;
}

/**
 * Loan-activated hook (runs inside the activation transaction — enqueue
 * only, never PayPal): when the loan's application carried an invoice,
 * enqueues the link's `order.create` (purpose `repayment_link`, sourceId =
 * loan id, for the invoice amount, payee = the bank's own merchant
 * account — no `payee` field) and records the `repayment_links` row
 * (`pending` until the order exists). `refreshRepaymentLink` executes the
 * operation after commit and stores the approve URL.
 */
async function createInvoiceRepaymentLink(tx: Db, loan: LoanRow): Promise<void> {
  const worldId = loan.worldId;
  const invoice = await loanInvoice(tx, loan);
  if (!invoice) {
    return;
  }
  const amountCents = BigInt(invoice.amount_cents);
  const operationId = await enqueueInvoiceOrderCreate(tx, loan, invoice, loan.id);

  await scoped(tx, worldId).insert(repaymentLinks, {
    loanId: loan.id,
    kind: "invoice",
    amountCents,
    payerHint: invoice.client_email ?? null,
    status: "pending",
    createOpId: operationId,
  });
}

/** The invoice the loan's application carried, or `null`. */
async function loanInvoice(tx: Db, loan: LoanRow): Promise<(InvoiceRef & { amount_cents: number }) | null> {
  const worldId = loan.worldId;
  const offer = await scoped(tx, worldId).findOne(offers, eq(offers.id, loan.offerId));
  const application = offer
    ? await scoped(tx, worldId).findOne(applications, eq(applications.id, offer.applicationId))
    : undefined;
  const invoice = (application?.invoiceRef ?? null) as InvoiceRef | null;
  if (!invoice || typeof invoice.amount_cents !== "number") {
    return null;
  }
  return invoice as InvoiceRef & { amount_cents: number };
}

/**
 * Enqueues an invoice link's `order.create` (purpose `repayment_link`).
 * `sourceId` is the loan id for the first issue and `${loanId}:${n}` for
 * a re-issue (Task 8) — see `invoiceLinkSourceId`.
 */
async function enqueueInvoiceOrderCreate(
  tx: Db,
  loan: LoanRow,
  invoice: InvoiceRef & { amount_cents: number },
  sourceId: string,
): Promise<string> {
  const worldId = loan.worldId;
  const agent = await scoped(tx, worldId).findOne(agents, eq(agents.id, loan.agentId));
  const description = invoiceLinkDescription(invoice.description ?? "", agent?.name ?? "the borrower");
  const rail = await railForWorld(tx, worldId);
  const { operationId } = await enqueueOperation(tx, {
    worldId,
    rail,
    kind: "order.create",
    purpose: "repayment_link",
    sourceId,
    request: buildCreateOrderRequest({
      amountCents: BigInt(invoice.amount_cents),
      description,
      customId: loan.id,
      returnUrl: checkoutUrl("/checkout/invoice/return"),
      cancelUrl: checkoutUrl("/checkout/invoice/cancel"),
    }),
  });
  return operationId;
}

/**
 * The `repayment_link` checkout's `sourceId` for issue `n` of a loan's
 * invoice link: the loan id itself for the first issue, `${loanId}:${n}`
 * for a re-issue — so every issue gets its own deterministic operation id.
 */
export function invoiceLinkSourceId(loanId: string, issue: number): string {
  return issue <= 1 ? loanId : `${loanId}:${issue}`;
}

/** The loan id behind a `repayment_link` checkout's `sourceId` (strips a re-issue suffix). */
export function loanIdFromInvoiceSourceId(sourceId: string): string {
  return sourceId.replace(/:\d+$/, "");
}

/** How many times the reconcile cron may issue one loan's invoice link in total. */
export const MAX_INVOICE_LINK_ISSUES = 3;

export type ReissueInvoiceLinkOutcome =
  | { outcome: "reissued"; issue: number; link: LinkRow }
  | { outcome: "not_needed" }
  | { outcome: "exhausted"; issues: number };

/**
 * Task 8 (reconcile auto-fix): re-issues a `failed` invoice link of a
 * still-ACTIVE loan — agents depend on the link, the client may not have
 * paid yet. In one transaction (link row locked): checks it's still
 * `failed`, works out which issue its current `order.create` was, and —
 * below `MAX_INVOICE_LINK_ISSUES` — enqueues the next issue's
 * `order.create` (sourceId `${loanId}:${n}`, so idempotent: a repeat
 * resolves to the same operation) and resets the SAME row to `pending`
 * with no order/URL (one invoice link per loan stays true). After commit
 * it executes the create and copies the new approve URL (`open`).
 * Never call inside a transaction.
 */
export async function reissueInvoiceLink(db: Db, worldId: string, linkId: string): Promise<ReissueInvoiceLinkOutcome> {
  const result = await db.transaction(async (tx): Promise<ReissueInvoiceLinkOutcome> => {
    const [link] = await scoped(tx, worldId).forUpdate(repaymentLinks, eq(repaymentLinks.id, linkId));
    if (!link || link.kind !== "invoice" || link.status !== "failed") {
      return { outcome: "not_needed" };
    }
    const loan = await scoped(tx, worldId).findOne(loans, eq(loans.id, link.loanId));
    if (!loan || !isOwingStatus(loan.status)) {
      return { outcome: "not_needed" };
    }
    const invoice = await loanInvoice(tx, loan);
    if (!invoice) {
      return { outcome: "not_needed" };
    }

    let current = 1;
    for (let issue = 1; issue <= MAX_INVOICE_LINK_ISSUES; issue += 1) {
      if (deriveOperationId(worldId, "repayment_link", invoiceLinkSourceId(loan.id, issue)) === link.createOpId) {
        current = issue;
        break;
      }
    }
    const next = current + 1;
    if (next > MAX_INVOICE_LINK_ISSUES) {
      return { outcome: "exhausted", issues: current };
    }

    const operationId = await enqueueInvoiceOrderCreate(tx, loan, invoice, invoiceLinkSourceId(loan.id, next));
    const [reset] = await scoped(tx, worldId).update(
      repaymentLinks,
      { status: "pending", createOpId: operationId, paypalOrderId: null, approveUrl: null },
      and(eq(repaymentLinks.id, link.id), eq(repaymentLinks.status, "failed"))!,
    );
    await appendEvent(tx, worldId, {
      type: "loan.repayment_link_reissued",
      aggregateId: loan.id,
      simAt: await getSimNow(tx, worldId),
      payload: { link_id: link.id, issue: next },
    });
    return { outcome: "reissued", issue: next, link: reset! };
  });

  if (result.outcome !== "reissued") {
    return result;
  }
  const refreshed = await refreshLinkRow(db, worldId, result.link, { ignoreBackoff: true });
  return { ...result, link: refreshed };
}

/**
 * The invoice link's order description: `Invoice <description> — pay to
 * Mandate on behalf of <agent name>` (no double space for a blank
 * description), cut to PayPal's 127-character limit.
 */
export function invoiceLinkDescription(invoiceDescription: string, agentName: string): string {
  const text = invoiceDescription.trim();
  const full = `Invoice ${text ? `${text} ` : ""}— pay to Mandate on behalf of ${agentName}`;
  return full.slice(0, PAYPAL_DESCRIPTION_MAX);
}

/** The production loan-activated hook (exported so tests that reset hooks can re-register it). */
export const invoiceRepaymentLinkHook = createInvoiceRepaymentLink;

registerLoanActivatedHook(invoiceRepaymentLinkHook);

/**
 * The loan's invoice link (or `undefined` if it has none), with its
 * `order.create` executed and approve URL stored if that hasn't happened
 * yet. Called after commit by `accept_offer`'s finalize, by
 * `pollPayoutStatus` after an activation, and lazily by `get_loan`; the
 * reconcile cron (Task 8) also executes any still-queued create. Never
 * call inside a transaction.
 */
export async function refreshRepaymentLink(
  db: Db,
  worldId: string,
  loanId: string,
  options: ExecuteOperationOptions = {},
): Promise<LinkRow | undefined> {
  const link = await scoped(db, worldId).findOne(
    repaymentLinks,
    and(eq(repaymentLinks.loanId, loanId), eq(repaymentLinks.kind, "invoice"))!,
  );
  return link ? refreshLinkRow(db, worldId, link, options) : undefined;
}

/** `repay_loan`'s finalize: executes the direct checkout's `order.create` and returns the link row. */
export async function refreshDirectRepayment(
  db: Db,
  worldId: string,
  linkId: string,
): Promise<LinkRow | undefined> {
  const link = await scoped(db, worldId).findOne(repaymentLinks, eq(repaymentLinks.id, linkId));
  return link ? refreshLinkRow(db, worldId, link, { ignoreBackoff: true }) : undefined;
}

// ---------------------------------------------------------------------
// repay_loan (direct checkout)
// ---------------------------------------------------------------------

export type BeginDirectRepaymentOutcome =
  | { outcome: "not_found" }
  | { outcome: "invalid_transition"; state: string }
  | { outcome: "amount_exceeds_outstanding"; outstandingCents: bigint }
  | { outcome: "submitted"; linkId: string; createOperationId: string; amountCents: bigint; loanId: string };

/**
 * `repay_loan`'s transactional half: the caller's own ACTIVE (or LATE /
 * SUBSTANDARD) loan (row-locked), an amount of at most everything it owes
 * — base outstanding plus late fees and penalty (default: all of
 * it — a direct repayment can never overpay; only an invoice link can
 * produce a remainder), a `repayment_links` row of kind `direct` and its
 * queued `order.create` (purpose `repayment_direct`, sourceId = the link
 * row's id, so every `repay_loan` call gets its own checkout). The tool's
 * finalize executes the create after commit.
 */
export async function beginDirectRepayment(
  tx: Db,
  worldId: string,
  agentId: string,
  loanId: string,
  amountCents: bigint | null,
): Promise<BeginDirectRepaymentOutcome> {
  const [lockedLoan] = await scoped(tx, worldId).forUpdate(loans, and(eq(loans.id, loanId), eq(loans.agentId, agentId))!);
  if (!lockedLoan) {
    return { outcome: "not_found" };
  }
  // P4 Task 2: a charged-off loan can still be repaid (a recovery, up to what was written off).
  if (!isOwingStatus(lockedLoan.status) && lockedLoan.status !== "charged_off") {
    return { outcome: "invalid_transition", state: fromDbStatus(lockedLoan.status) };
  }
  // P4: the quote includes the penalty up to now (accrued under the loan lock).
  const quoteSimAt = await getSimNow(tx, worldId);
  const loan = await accruePenaltyLocked(tx, worldId, lockedLoan, quoteSimAt);
  // P4: a late loan owes its late fees and penalty too (paid first).
  const due = totalDueCents(loan);
  const amount = amountCents ?? due;
  if (amount > due) {
    return { outcome: "amount_exceeds_outstanding", outstandingCents: due };
  }
  // Ruling P4-C: a full payoff of an owing loan is a quote — paid as quoted,
  // it settles the loan even if charges accrue before the capture lands.
  const quoted = isOwingStatus(loan.status) && amount === due;

  const [link] = await scoped(tx, worldId).insert(repaymentLinks, {
    loanId: loan.id,
    kind: "direct",
    amountCents: amount,
    status: "pending",
    ...(quoted ? { quoteSimAt, quotedCents: due } : {}),
  });
  if (!link) {
    throw new Error("Expected a repayment_links row to be inserted");
  }

  const rail = await railForWorld(tx, worldId);
  const { operationId } = await enqueueOperation(tx, {
    worldId,
    rail,
    kind: "order.create",
    purpose: "repayment_direct",
    sourceId: link.id,
    request: buildCreateOrderRequest({
      amountCents: amount,
      description: `Repayment of Mandate loan ${loan.id}`,
      customId: link.id,
      returnUrl: checkoutUrl("/checkout/repay/return"),
      cancelUrl: checkoutUrl("/checkout/repay/cancel"),
    }),
  });
  await scoped(tx, worldId).update(repaymentLinks, { createOpId: operationId }, eq(repaymentLinks.id, link.id));

  return { outcome: "submitted", linkId: link.id, createOperationId: operationId, amountCents: amount, loanId: loan.id };
}

// ---------------------------------------------------------------------
// Capture → waterfall (both checkout purposes)
// ---------------------------------------------------------------------

/** The link row a checkout's `order.create` sourceId points at, per checkout purpose. */
async function findLinkForCheckout(
  db: Db,
  worldId: string,
  purpose: OperationPurpose,
  createSourceId: string,
): Promise<LinkRow | undefined> {
  if (purpose === "guarantee") {
    return scoped(db, worldId).findOne(
      repaymentLinks,
      and(eq(repaymentLinks.loanId, loanIdFromGuaranteeSourceId(createSourceId)), eq(repaymentLinks.kind, "guarantee"))!,
    );
  }
  return purpose === "repayment_link"
    ? scoped(db, worldId).findOne(
        repaymentLinks,
        and(eq(repaymentLinks.loanId, loanIdFromInvoiceSourceId(createSourceId)), eq(repaymentLinks.kind, "invoice"))!,
      )
    : scoped(db, worldId).findOne(
        repaymentLinks,
        and(eq(repaymentLinks.id, createSourceId), eq(repaymentLinks.kind, "direct"))!,
      );
}

async function appliedResult(db: Db, worldId: string, repayment: RepaymentRow): Promise<CaptureApplyResult> {
  const loan = await scoped(db, worldId).findOne(loans, eq(loans.id, repayment.loanId));
  const state = loan ? fromDbStatus(loan.status) : "ACTIVE";
  const outstanding = loan ? totalDueCents(loan) : 0n;
  const remainderNote =
    repayment.remainderCents > 0n
      ? ` ${repayment.remainderCents.toString()} cents over what was owed is being returned to the borrower (${repayment.remainderStatus}).`
      : "";
  if (state === "CHARGED_OFF" || state === "RECOVERED") {
    return {
      outcome: "applied",
      summary:
        `Payment of ${repayment.grossCents.toString()} cents on the charged-off loan: ` +
        `${repayment.appliedRecoveryCents.toString()} cents recovered. Loan is ${state}; ${outstanding.toString()} cents still owed.` +
        remainderNote,
      data: {
        loan_id: repayment.loanId,
        loan_status: state,
        repayment_id: repayment.id,
        gross_cents: Number(repayment.grossCents),
        applied_recovery_cents: Number(repayment.appliedRecoveryCents),
        remainder_cents: Number(repayment.remainderCents),
        remainder_status: repayment.remainderStatus.toUpperCase(),
        outstanding_cents: Number(outstanding),
      },
    };
  }
  return {
    outcome: "applied",
    summary:
      `Repayment of ${repayment.grossCents.toString()} cents applied: ` +
      (repayment.appliedLateFeeCents > 0n || repayment.appliedPenaltyCents > 0n
        ? `late fees ${repayment.appliedLateFeeCents.toString()}, penalty ${repayment.appliedPenaltyCents.toString()}, `
        : "") +
      `fee ${repayment.appliedFeeCents.toString()}, ` +
      `principal ${repayment.appliedPrincipalCents.toString()}. Loan is ${state}; ${outstanding.toString()} cents outstanding.` +
      remainderNote,
    data: {
      loan_id: repayment.loanId,
      loan_status: state,
      repayment_id: repayment.id,
      gross_cents: Number(repayment.grossCents),
      applied_late_fee_cents: Number(repayment.appliedLateFeeCents),
      applied_penalty_cents: Number(repayment.appliedPenaltyCents),
      applied_fee_cents: Number(repayment.appliedFeeCents),
      applied_principal_cents: Number(repayment.appliedPrincipalCents),
      remainder_cents: Number(repayment.remainderCents),
      remainder_status: repayment.remainderStatus.toUpperCase(),
      outstanding_cents: Number(outstanding),
    },
  };
}

/**
 * Applies a COMPLETED repayment capture exactly once (the capture handler
 * for both `repayment_link` and `repayment_direct`). Never call inside a
 * transaction.
 *
 * Exactly-once: keyed on the PayPal capture id — a `repayments` row unique
 * on `(world_id, capture_id)`, the journal key
 * `journalKey('repayment_capture', captureId)`, and the link's
 * conditional `pending|open → paid` update, all in ONE transaction — so a
 * webhook, the cron and `confirm_checkout` racing on the same order (or
 * an ALREADY_CAPTURED recovery returning the same capture) apply it once.
 * A replay re-derives its result from the stored row (and pushes a still
 * pending remainder payout along).
 *
 * The captured amount must equal the link's amount, else the link goes
 * to `review` and nothing is applied (`mismatch`).
 *
 * In the transaction (series → loan → positions locks): the waterfall
 * on the loan's CURRENT outstanding (fee first), the repayment row, the
 * repayment journal, the (cumulative) holders' share for THIS capture's fee,
 * the loan's new outstanding (ACTIVE → REPAID at zero, via the loan
 * machine), events, and — when there is a remainder — the remainder
 * payout's enqueue. The payout is executed after commit.
 */
export async function applyRepaymentCapture(
  db: Db,
  worldId: string,
  simNow: Date,
  args: { purpose: OperationPurpose; createSourceId: string; orderId: string; capture: OrderCaptureResult },
): Promise<CaptureApplyResult> {
  const link = await findLinkForCheckout(db, worldId, args.purpose, args.createSourceId);
  if (!link) {
    throw new Error(`No repayment link for ${args.purpose} source ${args.createSourceId} in world ${worldId}`);
  }
  const captureId = args.capture.captureId;
  const capturedCents = BigInt(args.capture.amountCents);

  const existing = await scoped(db, worldId).findOne(repayments, eq(repayments.captureId, captureId));
  if (existing) {
    await settlePendingRemainder(db, existing);
    return appliedResult(db, worldId, (await reloadRepayment(db, worldId, existing.id)) ?? existing);
  }
  // P4-F: a capture of a superseded guarantee issue (the owner paid an
  // older link) — the row now describes a newer issue, so check the amount
  // against the old order and apply it as a recovery without touching the row.
  const createOperationId = deriveOperationId(worldId, args.purpose, args.createSourceId);
  const staleOutside = args.purpose === "guarantee" && link.createOpId !== createOperationId;
  if (staleOutside) {
    const expected = await orderAmountCents(db, worldId, createOperationId);
    if (expected === null || expected !== capturedCents) {
      console.error(
        `[repayments] capture ${captureId} of a superseded guarantee order ${args.orderId} captured ${capturedCents.toString()} cents, expected ${String(expected)} — nothing applied`,
      );
      return { outcome: "mismatch", reason: `captured ${capturedCents.toString()} cents, expected ${String(expected)}` };
    }
  } else if (link.status === "review") {
    return { outcome: "mismatch", reason: `captured ${capturedCents.toString()} cents, expected ${link.amountCents.toString()}` };
  }
  if (link.status === "failed") {
    return { outcome: "failed", reason: "this repayment checkout previously failed" };
  }
  if (link.status === "paid") {
    // Paid by a capture we can't find — never apply a second one.
    return { outcome: "failed", reason: "this repayment checkout was already paid" };
  }

  if (!staleOutside && capturedCents !== link.amountCents) {
    await scoped(db, worldId).update(
      repaymentLinks,
      { status: "review" },
      and(eq(repaymentLinks.id, link.id), inArray(repaymentLinks.status, OPEN_LINK_STATUSES))!,
    );
    console.error(
      `[repayments] capture ${captureId} (order ${args.orderId}) for link ${link.id} captured ${capturedCents.toString()} cents, expected ${link.amountCents.toString()} — marked for review, nothing applied`,
    );
    return {
      outcome: "mismatch",
      reason: `captured ${capturedCents.toString()} cents, expected ${link.amountCents.toString()}`,
    };
  }

  const captureOperationId = (await findCaptureOperationId(db, worldId, args.orderId)) ?? null;
  if (!captureOperationId) {
    throw new Error(`No repayment_capture operation for order ${args.orderId}`);
  }

  const applied = await db.transaction(async (tx) => {
    const [series] = await scoped(tx, worldId).forUpdate(noteSeries, eq(noteSeries.name, MANDATE_POOL_A_NAME));
    const [lockedLoan] = await scoped(tx, worldId).forUpdate(loans, eq(loans.id, link.loanId));
    if (!lockedLoan) {
      throw new Error(`loan ${link.loanId} not found for repayment link ${link.id}`);
    }

    // P4-F: re-check under the loan lock (a re-issue holds it too) whether
    // this capture is for the guarantee link's current issue.
    let stale = staleOutside;
    if (!stale && args.purpose === "guarantee") {
      const [current] = await scoped(tx, worldId).forUpdate(repaymentLinks, eq(repaymentLinks.id, link.id));
      stale = current?.createOpId !== createOperationId;
    }
    if (!stale) {
      const marked = await scoped(tx, worldId).update(
        repaymentLinks,
        { status: "paid", paypalOrderId: args.orderId },
        and(eq(repaymentLinks.id, link.id), inArray(repaymentLinks.status, OPEN_LINK_STATUSES))!,
      );
      if (marked.length !== 1) {
        return null; // Lost a race with another settlement of this checkout.
      }
    } else if (lockedLoan.status !== "charged_off" && lockedLoan.status !== "recovered") {
      throw new Error(`superseded guarantee capture ${captureId} on loan ${lockedLoan.id} that isn't charged off`);
    }

    if (lockedLoan.status === "charged_off" || lockedLoan.status === "recovered") {
      // P4 Task 2: a payment after charge-off is a recovery.
      const recovered = await applyRecoveryLocked(tx, worldId, simNow, {
        loan: lockedLoan,
        link,
        stale,
        seriesId: series?.id ?? null,
        captureId,
        captureOperationId,
        capturedCents,
        capture: args.capture,
      });
      if (!recovered) {
        return null;
      }
      const payoutOperationId = await enqueueRemainderLocked(tx, worldId, simNow, lockedLoan, {
        ...recovered,
        note: "Mandate: payment received above what your charged-off loan owed",
      });
      return { repaymentId: recovered.repaymentId, payoutOperationId };
    }

    // P4: the penalty is owed up to the cure date — accrue it to now first
    // (under the loan lock, so it can't race processDue's accrual). Ruling
    // P4-C: for a quoted link only up to the quote's sim time, and whatever
    // was assessed or accrued after the quote is waived when it is paid as quoted.
    const accrueTo =
      link.quoteSimAt && link.quoteSimAt.getTime() < simNow.getTime() ? link.quoteSimAt : simNow;
    const accrued = await accruePenaltyLocked(tx, worldId, lockedLoan, accrueTo);
    const loan = await waivePostQuoteChargesLocked(tx, worldId, simNow, accrued, link, capturedCents);
    const owed = outstandingParts(loan);
    const split = waterfall({
      grossCents: capturedCents,
      principalCents: owed.principalCents,
      feeCents: owed.feeCents,
      lateFeeCents: owed.lateFeeCents,
      penaltyCents: owed.penaltyCents,
    });

    const [repayment] = await scoped(tx, worldId).insertOnConflictDoNothing(
      repayments,
      {
        loanId: loan.id,
        opId: captureOperationId,
        grossCents: capturedCents,
        appliedPrincipalCents: split.principal,
        appliedFeeCents: split.fee,
        appliedLateFeeCents: split.lateFee,
        appliedPenaltyCents: split.penalty,
        remainderCents: split.remainder,
        captureId,
        linkId: link.id,
        remainderStatus: "none",
      },
      [repayments.worldId, repayments.captureId],
    );
    if (!repayment) {
      return null; // This capture was already applied.
    }

    const repaymentPostings = [
      { accountCode: "cash_paypal" as const, amountCents: capturedCents },
      { accountCode: "loans_receivable" as const, amountCents: -split.principal },
      { accountCode: "fee_income" as const, amountCents: -split.fee },
      { accountCode: "late_fee_income" as const, amountCents: -split.lateFee },
      { accountCode: "penalty_income" as const, amountCents: -split.penalty },
      { accountCode: "payable_to_borrower" as const, ownerRef: loan.agentId, amountCents: -split.remainder },
    ].filter((posting) => posting.amountCents !== 0n);
    await postJournal(tx, {
      worldId,
      memo: link.kind === "invoice" ? "Invoice repayment captured" : "Repayment captured",
      sourceType: "repayments",
      sourceId: repayment.id,
      simAt: simNow,
      idempotencyKey: journalKey("repayment_capture", captureId),
      postings: repaymentPostings,
    });
    // Task 10b: PayPal's fee on this capture — the bank's expense, so it
    // changes neither the waterfall nor the holders' share.
    await postCaptureFee(tx, { worldId, simAt: simNow, sourceType: "repayments", sourceId: repayment.id }, args.capture);

    // Cumulative, so partial payments never lose cents to flooring: the
    // holders' share of everything collected so far minus what earlier
    // captures already distributed (fee 1 then 749 → 0 then 600).
    const feePaidBefore = loan.feeCents - owed.feeCents;
    const holdersCents = holdersShare(feePaidBefore + split.fee) - holdersShare(feePaidBefore);
    let holdersPaid = 0n;
    if (holdersCents > 0n && series) {
      // Ruling N: series row (locked above) → position rows.
      const positions = await scoped(tx, worldId).forUpdate(notePositions, eq(notePositions.seriesId, series.id));
      const shares = distribute(
        positions.map((position) => ({ agentId: position.agentId, units: position.units })),
        holdersCents,
      ).filter((share) => share.cents > 0n);
      if (shares.length > 0) {
        await postJournal(tx, {
          worldId,
          memo: "Note interest from loan fee",
          sourceType: "repayments",
          sourceId: repayment.id,
          simAt: simNow,
          idempotencyKey: journalKey("repayment_capture", `${captureId}:holders`),
          postings: [
            { accountCode: "note_interest_expense", amountCents: holdersCents },
            ...shares.map((share) => ({
              accountCode: "notes_payable" as const,
              ownerRef: share.agentId,
              amountCents: -share.cents,
            })),
          ],
        });
        for (const share of shares) {
          const position = positions.find((row) => row.agentId === share.agentId)!;
          await scoped(tx, worldId).update(
            notePositions,
            { units: position.units + share.cents, accruedCents: position.accruedCents + share.cents },
            eq(notePositions.id, position.id),
          );
        }
        holdersPaid = holdersCents;
      }
    }

    const newOutstanding = loan.outstandingCents - split.fee - split.principal;
    const newLateFees = loan.lateFeeOutstandingCents - split.lateFee;
    const newPenalty = loan.penaltyOutstandingCents - split.penalty;
    // Cure (P4): everything owed — base, late fees and penalty — is paid.
    const repaidNow = isOwingStatus(loan.status) && newOutstanding === 0n && newLateFees === 0n && newPenalty === 0n;
    const [after] = await scoped(tx, worldId).update(
      loans,
      {
        outstandingCents: newOutstanding,
        lateFeeOutstandingCents: newLateFees,
        penaltyOutstandingCents: newPenalty,
        ...(repaidNow ? { status: toDbStatus(transition(fromDbStatus(loan.status), "REPAY")) } : {}),
      },
      eq(loans.id, loan.id),
    );

    await appendEvent(tx, worldId, {
      type: "loan.repayment_received",
      aggregateId: loan.id,
      simAt: simNow,
      payload: {
        repayment_id: repayment.id,
        source: link.kind,
        gross_cents: Number(capturedCents),
        late_fee_cents: Number(split.lateFee),
        penalty_cents: Number(split.penalty),
        fee_cents: Number(split.fee),
        principal_cents: Number(split.principal),
        remainder_cents: Number(split.remainder),
        holders_share_cents: Number(holdersPaid),
        outstanding_cents: Number(newOutstanding + newLateFees + newPenalty),
      },
    });
    if (repaidNow) {
      await appendEvent(tx, worldId, { type: "loan.repaid", aggregateId: loan.id, simAt: simNow });
      if (loan.status !== "active") {
        // A delinquent loan cured: restore the agent, notify.
        await onLoanCured(tx, worldId, after!, simNow);
      }
    }

    const payoutOperationId = await enqueueRemainderLocked(tx, worldId, simNow, loan, {
      repaymentId: repayment.id,
      remainderCents: split.remainder,
    });

    return { repaymentId: repayment.id, payoutOperationId };
  });

  if (applied?.payoutOperationId) {
    await applyRemainderPayoutOutcome(db, applied.payoutOperationId);
  }
  if (applied) {
    // P4-F: a partial recovery leaves the guarantee link quoting too much — re-issue it.
    await reissueGuaranteeLink(db, worldId, link.loanId).catch((err: unknown) => {
      console.error(`[repayments] guarantee re-issue for loan ${link.loanId}: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  const settled = await scoped(db, worldId).findOne(repayments, eq(repayments.captureId, captureId));
  if (!settled) {
    // The link update and the repayment row commit together, so a link
    // that is `paid` with no row for THIS capture was settled by another.
    return { outcome: "failed", reason: "this repayment checkout was already paid" };
  }
  return appliedResult(db, worldId, settled);
}

/**
 * Ruling P4-C (inside the capture transaction, loan row locked): a quoted
 * full-payoff link (`quoted_cents` set, link amount = the quote) paid as
 * quoted settles the loan. If the loan now owes more than the quote, the
 * excess can only be late fees / penalty assessed or accrued after the
 * quote (the base principal + fee never grows; other payments only lower
 * it), so it is waived — penalty first, then late fees. Both are memo
 * balances (fees are recognised on collection), so the waiver posts no
 * journal: it is recorded in `loans.waived_cents` and a
 * `loan.charges_waived` event. Invoice links and partial amounts carry no
 * quote and are unaffected.
 */
async function waivePostQuoteChargesLocked(
  tx: Db,
  worldId: string,
  simNow: Date,
  loan: LoanRow,
  link: LinkRow,
  capturedCents: bigint,
): Promise<LoanRow> {
  if (link.quotedCents === null || link.quotedCents !== link.amountCents || capturedCents !== link.quotedCents) {
    return loan;
  }
  const excess = totalDueCents(loan) - capturedCents;
  if (excess <= 0n) {
    return loan;
  }
  const waivedPenalty = excess < loan.penaltyOutstandingCents ? excess : loan.penaltyOutstandingCents;
  const waivedLateFees = excess - waivedPenalty;
  if (waivedLateFees > loan.lateFeeOutstandingCents) {
    // Unreachable: base principal + fee never grows after a quote.
    throw new Error(`loan ${loan.id} owes ${excess.toString()} more than quoted beyond its late fees and penalty`);
  }
  const [updated] = await scoped(tx, worldId).update(
    loans,
    {
      penaltyOutstandingCents: loan.penaltyOutstandingCents - waivedPenalty,
      lateFeeOutstandingCents: loan.lateFeeOutstandingCents - waivedLateFees,
      waivedCents: loan.waivedCents + excess,
    },
    eq(loans.id, loan.id),
  );
  await appendEvent(tx, worldId, {
    type: "loan.charges_waived",
    aggregateId: loan.id,
    simAt: simNow,
    payload: {
      link_id: link.id,
      quote_sim_at: link.quoteSimAt?.toISOString() ?? null,
      quoted_cents: Number(link.quotedCents),
      waived_penalty_cents: Number(waivedPenalty),
      waived_late_fee_cents: Number(waivedLateFees),
      reason: "paid_as_quoted",
    },
  });
  return updated!;
}

/**
 * Inside the capture transaction: a remainder r > 0 is paid back to the
 * borrower (`remainder_payout`, executed after commit), or held when the
 * agent has no payout receiver. Returns the payout operation id, if any.
 */
async function enqueueRemainderLocked(
  tx: Db,
  worldId: string,
  simNow: Date,
  loan: LoanRow,
  args: { repaymentId: string; remainderCents: bigint; note?: string },
): Promise<string | null> {
  if (args.remainderCents <= 0n) {
    return null;
  }
  const [agent] = await scoped(tx, worldId).select(agents, eq(agents.id, loan.agentId));
  const recipientType = payoutRecipientType(agent?.payoutReceiverType ?? null);
  if (!agent?.payoutReceiver || !recipientType) {
    // Nowhere to send it: stays owed in payable_to_borrower.
    await scoped(tx, worldId).update(repayments, { remainderStatus: "held" }, eq(repayments.id, args.repaymentId));
    await appendEvent(tx, worldId, {
      type: "loan.remainder_held",
      aggregateId: loan.id,
      simAt: simNow,
      payload: { repayment_id: args.repaymentId, remainder_cents: Number(args.remainderCents), reason: "payout_receiver_missing" },
    });
    return null;
  }
  const rail = await railForWorld(tx, worldId);
  const enqueued = await enqueueOperation(tx, {
    worldId,
    rail,
    kind: "payout.send",
    purpose: "remainder_payout",
    sourceId: args.repaymentId,
    request: buildSendPayoutRequest({
      receiver: agent.payoutReceiver,
      receiverType: recipientType,
      amountCents: args.remainderCents,
      note: args.note ?? "Mandate: invoice proceeds above what your loan owed",
      senderItemId: args.repaymentId,
    }),
  });
  await scoped(tx, worldId).update(
    repayments,
    { remainderPayoutOpId: enqueued.operationId, remainderStatus: "pending" },
    eq(repayments.id, args.repaymentId),
  );
  return enqueued.operationId;
}

/**
 * P4 Task 2: applies a capture on a CHARGED_OFF / RECOVERED loan (row
 * locked, series locked before it) — see the file comment's "recovery".
 * Returns `null` if this capture was already applied.
 */
async function applyRecoveryLocked(
  tx: Db,
  worldId: string,
  simNow: Date,
  args: {
    loan: LoanRow;
    link: LinkRow;
    seriesId: string | null;
    captureId: string;
    captureOperationId: string;
    capturedCents: bigint;
    capture: OrderCaptureResult;
    /** A capture of a superseded guarantee issue (P4-F): never a quote. */
    stale?: boolean;
  },
): Promise<{ repaymentId: string; remainderCents: bigint } | null> {
  const { loan, capturedCents, link } = args;
  const recoverable = recoverableCents(loan);
  const recovery = capturedCents < recoverable ? capturedCents : recoverable;
  const remainder = capturedCents - recovery;
  // Ruling P4-E (as P4-C): a full-payoff quote made before the charge-off,
  // paid as quoted, fully recovers — the residue (charges that accrued
  // between the quote and the charge-off) is waived.
  const paidAsQuoted =
    !args.stale &&
    loan.status === "charged_off" &&
    link.quotedCents !== null &&
    link.quotedCents === link.amountCents &&
    capturedCents === link.quotedCents &&
    link.quoteSimAt !== null &&
    loan.chargedOffAt !== null &&
    link.quoteSimAt.getTime() <= loan.chargedOffAt.getTime();
  const waivedResidue = paidAsQuoted && recoverable > capturedCents ? recoverable - capturedCents : 0n;

  const [repayment] = await scoped(tx, worldId).insertOnConflictDoNothing(
    repayments,
    {
      loanId: loan.id,
      opId: args.captureOperationId,
      grossCents: capturedCents,
      appliedPrincipalCents: 0n,
      appliedFeeCents: 0n,
      appliedLateFeeCents: 0n,
      appliedPenaltyCents: 0n,
      appliedRecoveryCents: recovery,
      remainderCents: remainder,
      captureId: args.captureId,
      linkId: args.link.id,
      remainderStatus: "none",
    },
    [repayments.worldId, repayments.captureId],
  );
  if (!repayment) {
    return null;
  }

  await postJournal(tx, {
    worldId,
    memo: args.link.kind === "guarantee" ? "Guarantee payment captured (recovery)" : "Recovery captured",
    sourceType: "repayments",
    sourceId: repayment.id,
    simAt: simNow,
    idempotencyKey: journalKey("repayment_capture", args.captureId),
    postings: [
      { accountCode: "cash_paypal" as const, amountCents: capturedCents },
      { accountCode: "recoveries_income" as const, amountCents: -recovery },
      { accountCode: "payable_to_borrower" as const, ownerRef: loan.agentId, amountCents: -remainder },
    ].filter((posting) => posting.amountCents !== 0n),
  });
  // Task 10b: PayPal's fee on this capture is the bank's expense.
  await postCaptureFee(tx, { worldId, simAt: simNow, sourceType: "repayments", sourceId: repayment.id }, args.capture);

  // Holders are made whole first, pro rata to what each is still owed.
  let holdersCents = 0n;
  if (recovery > 0n) {
    const losses = await scoped(tx, worldId).select(loanHolderLosses, eq(loanHolderLosses.loanId, loan.id));
    const owedBack = losses.reduce((sum, row) => sum + (row.lossCents - row.recoveredCents), 0n);
    const toHolders = recovery < owedBack ? recovery : owedBack;
    if (toHolders > 0n && args.seriesId) {
      // Series (locked) → loan (locked) → positions.
      const positions = await scoped(tx, worldId).forUpdate(notePositions, eq(notePositions.seriesId, args.seriesId));
      const shares = distribute(
        losses.map((row) => ({ agentId: row.agentId, units: row.lossCents - row.recoveredCents })),
        toHolders,
      ).filter((share) => share.cents > 0n);
      await postJournal(tx, {
        worldId,
        memo: "Recovery credited back to note holders",
        sourceType: "repayments",
        sourceId: repayment.id,
        simAt: simNow,
        idempotencyKey: journalKey("repayment_capture", `${args.captureId}:holders_recovery`),
        postings: [
          { accountCode: "recoveries_income", amountCents: toHolders },
          ...shares.map((share) => ({
            accountCode: "notes_payable" as const,
            ownerRef: share.agentId,
            amountCents: -share.cents,
          })),
        ],
      });
      for (const share of shares) {
        const position = positions.find((row) => row.agentId === share.agentId);
        const loss = losses.find((row) => row.agentId === share.agentId)!;
        if (!position) {
          throw new Error(`note holder ${share.agentId} of loan ${loan.id} has no position`);
        }
        await scoped(tx, worldId).update(notePositions, { units: position.units + share.cents }, eq(notePositions.id, position.id));
        await scoped(tx, worldId).update(
          loanHolderLosses,
          { recoveredCents: loss.recoveredCents + share.cents },
          eq(loanHolderLosses.id, loss.id),
        );
      }
      holdersCents = toHolders;
    }
  }

  const newRecovered = loan.recoveredCents + recovery;
  const fullyRecovered = loan.status === "charged_off" && newRecovered + waivedResidue >= loan.chargeOffTotalCents;
  const [after] = await scoped(tx, worldId).update(
    loans,
    {
      recoveredCents: newRecovered,
      ...(waivedResidue > 0n ? { waivedCents: loan.waivedCents + waivedResidue } : {}),
      ...(fullyRecovered ? { status: toDbStatus(transition(fromDbStatus(loan.status), "RECOVER")) } : {}),
    },
    eq(loans.id, loan.id),
  );
  await appendEvent(tx, worldId, {
    type: "loan.recovery_received",
    aggregateId: loan.id,
    simAt: simNow,
    payload: {
      repayment_id: repayment.id,
      source: args.link.kind,
      gross_cents: Number(capturedCents),
      recovery_cents: Number(recovery),
      holders_recovery_cents: Number(holdersCents),
      remainder_cents: Number(remainder),
      still_owed_cents: Number(after!.chargeOffTotalCents - after!.recoveredCents),
    },
  });
  if (waivedResidue > 0n) {
    await appendEvent(tx, worldId, {
      type: "loan.charges_waived",
      aggregateId: loan.id,
      simAt: simNow,
      payload: {
        link_id: link.id,
        quote_sim_at: link.quoteSimAt?.toISOString() ?? null,
        quoted_cents: Number(link.quotedCents),
        waived_recovery_cents: Number(waivedResidue),
        reason: "paid_as_quoted_after_charge_off",
      },
    });
  }
  if (fullyRecovered) {
    await appendEvent(tx, worldId, { type: "loan.recovered", aggregateId: loan.id, simAt: simNow });
  }
  if (recovery > 0n) {
    await onLoanRecovery(tx, worldId, after!, simNow, { recoveredNowCents: recovery, fullyRecovered });
  }
  return { repaymentId: repayment.id, remainderCents: remainder };
}

async function reloadRepayment(db: Db, worldId: string, id: string): Promise<RepaymentRow | undefined> {
  return scoped(db, worldId).findOne(repayments, eq(repayments.id, id));
}

/** The derived `repayment_capture` operation id for an order (it must exist by the time a capture is applied). */
async function findCaptureOperationId(db: Db, worldId: string, orderId: string): Promise<string | undefined> {
  const id = deriveOperationId(worldId, "repayment_capture", orderId);
  const record = await getOperation(db, id);
  return record && record.worldId === worldId ? id : undefined;
}

/** On a replay: if the remainder payout is still pending, try to settle it now. */
async function settlePendingRemainder(db: Db, repayment: RepaymentRow): Promise<void> {
  if (repayment.remainderStatus === "pending" && repayment.remainderPayoutOpId) {
    await applyRemainderPayoutOutcome(db, repayment.remainderPayoutOpId);
  }
}

async function resolveLinkOwnerAgentId(db: Db, worldId: string, loanId: string): Promise<string | null> {
  const loan = await scoped(db, worldId).findOne(loans, eq(loans.id, loanId));
  return loan?.agentId ?? null;
}

async function resolveDirectOwnerAgentId(db: Db, worldId: string, linkId: string): Promise<string | null> {
  const link = await scoped(db, worldId).findOne(repaymentLinks, eq(repaymentLinks.id, linkId));
  return link ? resolveLinkOwnerAgentId(db, worldId, link.loanId) : null;
}

function failureApplier(purpose: OperationPurpose) {
  return async (db: Db, worldId: string, args: { createSourceId: string; orderId: string; reason: string }) => {
    const link = await findLinkForCheckout(db, worldId, purpose, args.createSourceId);
    if (!link) {
      return;
    }
    if (link.createOpId && link.createOpId !== deriveOperationId(worldId, purpose, args.createSourceId)) {
      // A stale issue of a re-issued invoice link (Task 8, fix round 1 M4):
      // the link's current order.create is a newer issue (different
      // sourceId suffix), which this failure says nothing about.
      return;
    }
    const failed = await scoped(db, worldId).update(
      repaymentLinks,
      { status: "failed" },
      and(eq(repaymentLinks.id, link.id), inArray(repaymentLinks.status, OPEN_LINK_STATUSES))!,
    );
    if (failed.length === 1) {
      console.error(`[repayments] ${purpose} ${link.id} (order ${args.orderId}) failed: ${args.reason}`);
    }
  };
}

registerCaptureHandler("repayment_link", {
  // The borrower agent owns its client's invoice link (the client pays it).
  resolveOwnerAgentId: (db, worldId, sourceId) => resolveLinkOwnerAgentId(db, worldId, loanIdFromInvoiceSourceId(sourceId)),
  applyEffect: (db, worldId, simNow, args) => applyRepaymentCapture(db, worldId, simNow, { purpose: "repayment_link", ...args }),
  applyFailure: failureApplier("repayment_link"),
  retryNextAction: async (_db, _worldId, sourceId): Promise<NextAction> => ({
    tool: "get_loan",
    args: { loan_id: loanIdFromInvoiceSourceId(sourceId) },
  }),
});

registerCaptureHandler("repayment_direct", {
  resolveOwnerAgentId: resolveDirectOwnerAgentId,
  applyEffect: (db, worldId, simNow, args) =>
    applyRepaymentCapture(db, worldId, simNow, { purpose: "repayment_direct", ...args }),
  applyFailure: failureApplier("repayment_direct"),
  retryNextAction: async (db, worldId, linkId): Promise<NextAction> => {
    const link = await scoped(db, worldId).findOne(repaymentLinks, eq(repaymentLinks.id, linkId));
    // M9: repay_loan needs a loan_id; with no link to take it from, point at get_status instead.
    return link
      ? { tool: "repay_loan", args: { loan_id: link.loanId, amount_cents: Number(link.amountCents) } }
      : { tool: "get_status", args: {} };
  },
});

registerCaptureHandler("guarantee", {
  // P4 Task 2: the owner pays it; the borrower agent may confirm it too (it's its loan).
  resolveOwnerAgentId: (db, worldId, sourceId) => resolveLinkOwnerAgentId(db, worldId, loanIdFromGuaranteeSourceId(sourceId)),
  applyEffect: (db, worldId, simNow, args) => applyRepaymentCapture(db, worldId, simNow, { purpose: "guarantee", ...args }),
  applyFailure: failureApplier("guarantee"),
  retryNextAction: async (_db, _worldId, sourceId): Promise<NextAction> => ({
    tool: "get_loan",
    args: { loan_id: loanIdFromGuaranteeSourceId(sourceId) },
  }),
});

// ---------------------------------------------------------------------
// Remainder payout outcome
// ---------------------------------------------------------------------

/**
 * Settles a remainder payout (Rulings J/Q/R, same semantics as the loan
 * and redemption appliers). Idempotent; safe from the capture path, Task
 * 8's webhook (with `observed`) and the cron (`pollPayoutStatus`). Never
 * call inside a transaction.
 * - SUCCESS → `pending → paid`, journal Dr `payable_to_borrower[borrower]`
 *   / Cr `cash_paypal` (R), event `loan.remainder_paid` — one transaction,
 *   journal only after the conditional update wins;
 * - FAILED/RETURNED/BLOCKED/REFUNDED/DENIED or a terminally failed send →
 *   `pending → failed` with the reason, event
 *   `loan.remainder_payout_failed`; the money stays owed in
 *   `payable_to_borrower` (get_status shows it as payable to the agent);
 * - UNCLAIMED → stays pending while the item is cancelled (Ruling R);
 * - anything else → stays pending.
 */
export async function applyRemainderPayoutOutcome(
  db: Db,
  operationId: string,
  observed?: ObservedPayoutStatus,
): Promise<void> {
  const record = await getOperation(db, operationId);
  if (!record || record.kind !== "payout.send" || record.purpose !== "remainder_payout" || !record.sourceId) {
    return;
  }
  const worldId = record.worldId;
  const repayment = await scoped(db, worldId).findOne(repayments, eq(repayments.id, record.sourceId));
  if (!repayment || repayment.remainderStatus !== "pending") {
    return;
  }

  const resolution = await resolvePayoutOutcome(db, operationId, observed);
  if (resolution.kind === "pending") {
    return;
  }
  const loan = await scoped(db, worldId).findOne(loans, eq(loans.id, repayment.loanId));
  if (!loan) {
    throw new Error(`loan ${repayment.loanId} not found for repayment ${repayment.id}`);
  }
  const simAt = await getSimNow(db, worldId);

  if (resolution.kind === "failed") {
    await db.transaction(async (tx) => {
      const [failed] = await scoped(tx, worldId).update(
        repayments,
        { remainderStatus: "failed", remainderFailureReason: resolution.reason },
        and(eq(repayments.id, repayment.id), eq(repayments.remainderStatus, "pending"))!,
      );
      if (!failed) {
        return;
      }
      await appendEvent(tx, worldId, {
        type: "loan.remainder_payout_failed",
        aggregateId: loan.id,
        simAt,
        payload: {
          repayment_id: repayment.id,
          remainder_cents: Number(repayment.remainderCents),
          reason: resolution.reason,
        },
      });
    });
    return;
  }

  await db.transaction(async (tx) => {
    const [paid] = await scoped(tx, worldId).update(
      repayments,
      { remainderStatus: "paid" },
      and(eq(repayments.id, repayment.id), eq(repayments.remainderStatus, "pending"))!,
    );
    if (!paid) {
      return;
    }
    await postJournal(tx, {
      worldId,
      memo: "Invoice remainder paid out",
      sourceType: "repayments",
      sourceId: repayment.id,
      simAt,
      idempotencyKey: journalKey("remainder_payout", repayment.id),
      postings: [
        { accountCode: "payable_to_borrower", ownerRef: loan.agentId, amountCents: repayment.remainderCents },
        { accountCode: "cash_paypal", amountCents: -repayment.remainderCents },
      ],
    });
    if (resolution.fee) {
      // Task 10b: the payout's PayPal fee, same transaction (once per batch).
      await postPayoutFee(tx, { worldId, simAt, sourceType: "repayments", sourceId: repayment.id }, resolution.fee);
    }
    await appendEvent(tx, worldId, {
      type: "loan.remainder_paid",
      aggregateId: loan.id,
      simAt,
      payload: { repayment_id: repayment.id, remainder_cents: Number(repayment.remainderCents) },
    });
  });
}

/** For `pollPayoutStatus`: whether a remainder payout still awaits its outcome. */
export async function remainderPayoutNeedsPolling(db: Db, worldId: string, repaymentId: string): Promise<boolean> {
  const repayment = await scoped(db, worldId).findOne(repayments, eq(repayments.id, repaymentId));
  return repayment?.remainderStatus === "pending";
}

// ---------------------------------------------------------------------
// P4-F: guarantee link re-issue
// ---------------------------------------------------------------------

/** How many times a guarantee link may be issued in total (the first + 3 re-issues). */
export const MAX_GUARANTEE_LINK_ISSUES = 4;

/** The `guarantee` checkout's sourceId for issue `n`: the loan id, then `${loanId}:g<n>`. */
export function guaranteeSourceId(loanId: string, issue: number): string {
  return issue <= 1 ? loanId : `${loanId}:g${issue}`;
}

/** The loan id behind a `guarantee` checkout's sourceId. */
export function loanIdFromGuaranteeSourceId(sourceId: string): string {
  return sourceId.replace(/:g\d+$/, "");
}

/** The amount (cents) a queued/executed `order.create` asked for, or `null`. */
async function orderAmountCents(db: Db, worldId: string, createOperationId: string): Promise<bigint | null> {
  const row = await scoped(db, worldId).findOne(paypalOperations, eq(paypalOperations.id, createOperationId));
  const body = (row?.executableRequest as { body?: { purchase_units?: { amount?: { value?: unknown } }[] } } | null | undefined)?.body;
  const value = body?.purchase_units?.[0]?.amount?.value;
  return typeof value === "string" ? amountToCents(value) : null;
}

export type ReissueGuaranteeOutcome =
  | { outcome: "reissued"; issue: number; link: LinkRow }
  | { outcome: "not_needed" }
  | { outcome: "exhausted"; issues: number };

/**
 * Ruling P4-F: re-issues a CHARGED_OFF loan's guarantee link at what is
 * still recoverable — after a partial recovery (the open link quotes too
 * much) or after its `order.create` failed terminally. Updates the SAME
 * row in place (one guarantee link per loan): a new `order.create` with
 * sourceId `${loanId}:g<n>` (deterministic, so a repeat resolves to the
 * same operation), status `pending`, no order/URL yet, amount = quote =
 * the recoverable amount, `quote_sim_at` = now. At most
 * `MAX_GUARANTEE_LINK_ISSUES` issues. Locks loan → link (the capture
 * path's order). An owner paying an OLDER issue afterwards is still
 * applied — as a recovery (any excess refunded) — see
 * `applyRepaymentCapture`. Executes the create after commit. Never call
 * inside a transaction.
 */
export async function reissueGuaranteeLink(db: Db, worldId: string, loanId: string): Promise<ReissueGuaranteeOutcome> {
  const result = await db.transaction(async (tx): Promise<ReissueGuaranteeOutcome> => {
    const [loan] = await scoped(tx, worldId).forUpdate(loans, eq(loans.id, loanId));
    if (!loan || loan.status !== "charged_off") {
      return { outcome: "not_needed" };
    }
    const [link] = await scoped(tx, worldId).forUpdate(
      repaymentLinks,
      and(eq(repaymentLinks.loanId, loanId), eq(repaymentLinks.kind, "guarantee"))!,
    );
    const recoverable = recoverableCents(loan);
    if (!link || recoverable <= 0n) {
      return { outcome: "not_needed" };
    }
    const stale = link.status === "failed" || (OPEN_LINK_STATUSES.includes(link.status) && link.amountCents !== recoverable);
    if (!stale) {
      return { outcome: "not_needed" };
    }
    let current = 1;
    for (let issue = 1; issue <= MAX_GUARANTEE_LINK_ISSUES; issue += 1) {
      if (deriveOperationId(worldId, "guarantee", guaranteeSourceId(loanId, issue)) === link.createOpId) {
        current = issue;
        break;
      }
    }
    const next = current + 1;
    if (next > MAX_GUARANTEE_LINK_ISSUES) {
      return { outcome: "exhausted", issues: current };
    }
    const simNow = await getSimNow(tx, worldId);
    const agent = await scoped(tx, worldId).findOne(agents, eq(agents.id, loan.agentId));
    const rail = await railForWorld(tx, worldId);
    const { operationId } = await enqueueOperation(tx, {
      worldId,
      rail,
      kind: "order.create",
      purpose: "guarantee",
      sourceId: guaranteeSourceId(loanId, next),
      request: buildCreateOrderRequest({
        amountCents: recoverable,
        description: `Guarantee: Mandate loan ${loan.id} to ${agent?.name ?? "your agent"} was charged off`.slice(0, PAYPAL_DESCRIPTION_MAX),
        customId: loan.id,
        returnUrl: checkoutUrl("/checkout/guarantee/return"),
        cancelUrl: checkoutUrl("/checkout/guarantee/cancel"),
      }),
    });
    const [reset] = await scoped(tx, worldId).update(
      repaymentLinks,
      {
        status: "pending",
        amountCents: recoverable,
        quotedCents: recoverable,
        quoteSimAt: simNow,
        createOpId: operationId,
        paypalOrderId: null,
        approveUrl: null,
      },
      eq(repaymentLinks.id, link.id),
    );
    await appendEvent(tx, worldId, {
      type: "loan.guarantee_reissued",
      aggregateId: loan.id,
      simAt: simNow,
      payload: { link_id: link.id, issue: next, amount_cents: Number(recoverable), previous_status: link.status },
    });
    return { outcome: "reissued", issue: next, link: reset! };
  });
  if (result.outcome !== "reissued") {
    return result;
  }
  return { ...result, link: await refreshLinkRow(db, worldId, result.link, { ignoreBackoff: true }) };
}

// ---------------------------------------------------------------------
// get_loan / get_statement views
// ---------------------------------------------------------------------

export interface RepaymentLinkView {
  url: string | null;
  orderId: string | null;
  amountCents: bigint;
  status: string;
}

/**
 * The loan's invoice link for `get_loan` (lazily executing a still-queued
 * create, respecting its backoff), or `null` if the loan has no invoice.
 */
export async function getRepaymentLinkView(db: Db, worldId: string, loanId: string): Promise<RepaymentLinkView | null> {
  const link = await refreshRepaymentLink(db, worldId, loanId);
  if (!link) {
    return null;
  }
  return { url: link.approveUrl, orderId: link.paypalOrderId, amountCents: link.amountCents, status: link.status };
}

export interface StatementLine {
  simAt: Date;
  memo: string;
  account: string;
  /** From the agent's side: positive = the bank owes the agent more. */
  amountCents: bigint;
}

export interface Statement {
  notes: { balanceCents: bigint; earnedCents: bigint };
  loans: LoanRow[];
  ledgerLines: StatementLine[];
}

/**
 * `get_statement`: the agent's own sub-accounts only — its note balance
 * (−`notes_payable[agent]`) and interest earned (Σ position
 * `accrued_cents`), its loans (oldest first), and every posting on an
 * account owned by the agent (`notes_payable[agent]`,
 * `payable_to_borrower[agent]`), oldest first. Never another agent's.
 */
export async function getStatement(db: Db, worldId: string, agentId: string): Promise<Statement> {
  const balance = await getAccountBalance(db, worldId, "notes_payable", agentId);
  const positions = await scoped(db, worldId).select(notePositions, eq(notePositions.agentId, agentId));
  const earnedCents = positions.reduce((sum, position) => sum + position.accruedCents, 0n);

  const agentLoans = (await scoped(db, worldId).select(loans, eq(loans.agentId, agentId))).sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1),
  );

  const accounts = await scoped(db, worldId).select(ledgerAccounts, eq(ledgerAccounts.ownerRef, agentId));
  const ledgerLines: StatementLine[] = [];
  if (accounts.length > 0) {
    const accountCode = new Map(accounts.map((account) => [account.id, account.code]));
    const rows = await scoped(db, worldId).select(postings, inArray(postings.accountId, [...accountCode.keys()]));
    const entryIds = [...new Set(rows.map((row) => row.entryId))];
    const entries = entryIds.length
      ? await scoped(db, worldId).select(journalEntries, inArray(journalEntries.id, entryIds))
      : [];
    const entryById = new Map(entries.map((entry) => [entry.id, entry]));
    const sorted = rows
      .map((row) => ({ row, entry: entryById.get(row.entryId)! }))
      .sort(
        (a, b) =>
          a.entry.simAt.getTime() - b.entry.simAt.getTime() ||
          a.entry.createdAt.getTime() - b.entry.createdAt.getTime() ||
          a.row.createdAt.getTime() - b.row.createdAt.getTime() ||
          (a.row.id < b.row.id ? -1 : 1),
      );
    for (const { row, entry } of sorted) {
      ledgerLines.push({
        simAt: entry.simAt,
        memo: entry.memo ?? "",
        account: accountCode.get(row.accountId)!,
        amountCents: -row.amountCents,
      });
    }
  }

  return { notes: { balanceCents: -balance, earnedCents }, loans: agentLoans, ledgerLines };
}
