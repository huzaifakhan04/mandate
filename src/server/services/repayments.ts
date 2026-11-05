import { and, eq, inArray, isNull } from "drizzle-orm";

import { getSimNow } from "../clock/clock";
import type { NextAction } from "../contracts/envelope";
import type { Db } from "../db/client";
import {
  agents,
  applications,
  events,
  journalEntries,
  ledgerAccounts,
  loans,
  noteSeries,
  notePositions,
  offers,
  postings,
  repaymentLinks,
  repayments,
} from "../db/schema";
import { scoped } from "../db/scoped";
import { distribute } from "../domain/distribution";
import { fromDbStatus, toDbStatus, transition } from "../domain/loanMachine";
import { holdersShare, waterfall } from "../domain/waterfall";
import { getAccountBalance } from "../ledger/trialBalance";
import { postJournal } from "../ledger/postJournal";
import {
  buildCreateOrderRequest,
  buildSendPayoutRequest,
  deriveOperationId,
  enqueueOperation,
  executeOperation,
  getOperation,
  journalKey,
  successBody,
  type ExecuteOperationOptions,
  type OperationPurpose,
  type OrderCaptureResult,
} from "../paypal/operations";
import { registerCaptureHandler, type CaptureApplyResult } from "./checkouts";
import { registerLoanActivatedHook } from "./loans";
import { payoutRecipientType, resolvePayoutOutcome, type ObservedPayoutStatus } from "./payoutStatus";
import { postCaptureFee, postPayoutFee } from "./paypalFees";
import { railForWorld } from "./worlds";

/**
 * Task 7 — repayment: the invoice payment link, `repay_loan`'s direct
 * checkout, the waterfall, the holders' share, remainder payouts and
 * `get_statement`.
 *
 * Money flow (Global Constraints journal templates):
 * - capture of gross G against outstanding fee F' / principal P'
 *   (fee first): Dr `cash_paypal` G / Cr `fee_income` f / Cr
 *   `loans_receivable` p / Cr `payable_to_borrower[borrower]` r;
 * - holders' share of the fee collected BY THIS CAPTURE, cumulative so
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

function checkoutUrl(path: string): string {
  const base = process.env.PUBLIC_BASE_URL || "http://localhost:3000";
  return `${base.replace(/\/+$/, "")}${path}`;
}

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

/**
 * What's still owed on a loan, split fee / principal. P1 has no late fees
 * and the waterfall always pays the fee first, so the split is derived
 * from `outstanding_cents` alone: paid so far = (P + F) − outstanding,
 * of which min(paid, F) went to the fee. A loan that isn't ACTIVE owes
 * nothing (REPAID, or never funded).
 */
export function outstandingParts(loan: LoanRow): { principalCents: bigint; feeCents: bigint } {
  if (loan.status !== "active") {
    return { principalCents: 0n, feeCents: 0n };
  }
  const paid = loan.principalCents + loan.feeCents - loan.outstandingCents;
  const feePaid = paid < loan.feeCents ? paid : loan.feeCents;
  const feeCents = loan.feeCents - feePaid;
  const principalCents = loan.outstandingCents - feeCents;
  if (paid < 0n || principalCents < 0n) {
    throw new Error(`loan ${loan.id} has an inconsistent outstanding balance ${loan.outstandingCents.toString()}`);
  }
  return { principalCents, feeCents };
}

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
    if (!loan || loan.status !== "active") {
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
 * Executes a link's queued `order.create` if it hasn't produced an order
 * yet, and copies the order id + approve URL onto the link row (`pending`
 * → `open`). A terminally failed create marks the link `failed`. Never
 * call inside a transaction. Returns the link's current row.
 */
async function refreshLinkRow(
  db: Db,
  worldId: string,
  link: LinkRow,
  options: ExecuteOperationOptions = {},
): Promise<LinkRow> {
  if (link.approveUrl || !link.createOpId) {
    return link;
  }
  const result = await executeOperation(db, link.createOpId, options);
  if (result.status === "succeeded") {
    const body = successBody(result, "order.create");
    // Copied even if a capture already settled the link (cron raced us).
    await scoped(db, worldId).update(
      repaymentLinks,
      { paypalOrderId: body.orderId, approveUrl: body.approveUrl },
      and(eq(repaymentLinks.id, link.id), isNull(repaymentLinks.approveUrl))!,
    );
    await scoped(db, worldId).update(
      repaymentLinks,
      { status: "open" },
      and(eq(repaymentLinks.id, link.id), eq(repaymentLinks.status, "pending"))!,
    );
  } else if (result.status === "failed_terminal") {
    const failed = await scoped(db, worldId).update(
      repaymentLinks,
      { status: "failed" },
      and(eq(repaymentLinks.id, link.id), eq(repaymentLinks.status, "pending"))!,
    );
    if (failed.length === 1) {
      console.error(`[repayments] order.create for repayment link ${link.id} failed terminally`);
    }
  }
  return (await scoped(db, worldId).findOne(repaymentLinks, eq(repaymentLinks.id, link.id))) ?? link;
}

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
 * `repay_loan`'s transactional half: the caller's own ACTIVE loan
 * (row-locked), an amount of at most what's outstanding (default: all of
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
  const [loan] = await scoped(tx, worldId).forUpdate(loans, and(eq(loans.id, loanId), eq(loans.agentId, agentId))!);
  if (!loan) {
    return { outcome: "not_found" };
  }
  if (loan.status !== "active") {
    return { outcome: "invalid_transition", state: fromDbStatus(loan.status) };
  }
  const amount = amountCents ?? loan.outstandingCents;
  if (amount > loan.outstandingCents) {
    return { outcome: "amount_exceeds_outstanding", outstandingCents: loan.outstandingCents };
  }

  const [link] = await scoped(tx, worldId).insert(repaymentLinks, {
    loanId: loan.id,
    kind: "direct",
    amountCents: amount,
    status: "pending",
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
  const outstanding = loan?.outstandingCents ?? 0n;
  const remainderNote =
    repayment.remainderCents > 0n
      ? ` ${repayment.remainderCents.toString()} cents over what was owed is being returned to the borrower (${repayment.remainderStatus}).`
      : "";
  return {
    outcome: "applied",
    summary:
      `Repayment of ${repayment.grossCents.toString()} cents applied: fee ${repayment.appliedFeeCents.toString()}, ` +
      `principal ${repayment.appliedPrincipalCents.toString()}. Loan is ${state}; ${outstanding.toString()} cents outstanding.` +
      remainderNote,
    data: {
      loan_id: repayment.loanId,
      loan_status: state,
      repayment_id: repayment.id,
      gross_cents: Number(repayment.grossCents),
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
  if (link.status === "review") {
    return { outcome: "mismatch", reason: `captured ${capturedCents.toString()} cents, expected ${link.amountCents.toString()}` };
  }
  if (link.status === "failed") {
    return { outcome: "failed", reason: "this repayment checkout previously failed" };
  }
  if (link.status === "paid") {
    // Paid by a capture we can't find — never apply a second one.
    return { outcome: "failed", reason: "this repayment checkout was already paid" };
  }

  if (capturedCents !== link.amountCents) {
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
    const [loan] = await scoped(tx, worldId).forUpdate(loans, eq(loans.id, link.loanId));
    if (!loan) {
      throw new Error(`loan ${link.loanId} not found for repayment link ${link.id}`);
    }

    const marked = await scoped(tx, worldId).update(
      repaymentLinks,
      { status: "paid", paypalOrderId: args.orderId },
      and(eq(repaymentLinks.id, link.id), inArray(repaymentLinks.status, OPEN_LINK_STATUSES))!,
    );
    if (marked.length !== 1) {
      return null; // Lost a race with another settlement of this checkout.
    }

    const owed = outstandingParts(loan);
    const split = waterfall({ grossCents: capturedCents, principalCents: owed.principalCents, feeCents: owed.feeCents });

    const [repayment] = await scoped(tx, worldId).insertOnConflictDoNothing(
      repayments,
      {
        loanId: loan.id,
        opId: captureOperationId,
        grossCents: capturedCents,
        appliedPrincipalCents: split.principal,
        appliedFeeCents: split.fee,
        appliedLateFeeCents: 0n,
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
    const repaidNow = loan.status === "active" && newOutstanding === 0n;
    await scoped(tx, worldId).update(
      loans,
      {
        outstandingCents: newOutstanding,
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
        fee_cents: Number(split.fee),
        principal_cents: Number(split.principal),
        remainder_cents: Number(split.remainder),
        holders_share_cents: Number(holdersPaid),
        outstanding_cents: Number(newOutstanding),
      },
    });
    if (repaidNow) {
      await appendEvent(tx, worldId, { type: "loan.repaid", aggregateId: loan.id, simAt: simNow });
    }

    let payoutOperationId: string | null = null;
    if (split.remainder > 0n) {
      const [agent] = await scoped(tx, worldId).select(agents, eq(agents.id, loan.agentId));
      const recipientType = payoutRecipientType(agent?.payoutReceiverType ?? null);
      if (!agent?.payoutReceiver || !recipientType) {
        // Nowhere to send it: stays owed in payable_to_borrower.
        await scoped(tx, worldId).update(repayments, { remainderStatus: "held" }, eq(repayments.id, repayment.id));
        await appendEvent(tx, worldId, {
          type: "loan.remainder_held",
          aggregateId: loan.id,
          simAt: simNow,
          payload: { repayment_id: repayment.id, remainder_cents: Number(split.remainder), reason: "payout_receiver_missing" },
        });
      } else {
        const rail = await railForWorld(tx, worldId);
        const enqueued = await enqueueOperation(tx, {
          worldId,
          rail,
          kind: "payout.send",
          purpose: "remainder_payout",
          sourceId: repayment.id,
          request: buildSendPayoutRequest({
            receiver: agent.payoutReceiver,
            receiverType: recipientType,
            amountCents: split.remainder,
            note: "Mandate: invoice proceeds above what your loan owed",
            senderItemId: repayment.id,
          }),
        });
        payoutOperationId = enqueued.operationId;
        await scoped(tx, worldId).update(
          repayments,
          { remainderPayoutOpId: payoutOperationId, remainderStatus: "pending" },
          eq(repayments.id, repayment.id),
        );
      }
    }

    return { repaymentId: repayment.id, payoutOperationId };
  });

  if (applied?.payoutOperationId) {
    await applyRemainderPayoutOutcome(db, applied.payoutOperationId);
  }

  const settled = await scoped(db, worldId).findOne(repayments, eq(repayments.captureId, captureId));
  if (!settled) {
    // The link update and the repayment row commit together, so a link
    // that is `paid` with no row for THIS capture was settled by another.
    return { outcome: "failed", reason: "this repayment checkout was already paid" };
  }
  return appliedResult(db, worldId, settled);
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
    return {
      tool: "repay_loan",
      args: link ? { loan_id: link.loanId, amount_cents: Number(link.amountCents) } : {},
    };
  },
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
