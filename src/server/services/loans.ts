import { and, eq, inArray, lte } from "drizzle-orm";

import { getSimNow } from "../clock/clock";
import type { Db } from "../db/client";
import { agents, applications, events, loans, noteSeries, offers } from "../db/schema";
import { scoped } from "../db/scoped";
import { canonicalJson, disclosureHash } from "../domain/disclosure";
import { availableLiquidity } from "../domain/liquidity";
import {
  fromDbStatus,
  OPEN_LOAN_DB_STATUSES,
  toDbStatus,
  transition,
  type LoanState,
} from "../domain/loanMachine";
import { price, PRICING_LIMITS, rangeReasons } from "../domain/pricing";
import { postJournal } from "../ledger/postJournal";
import { buildSendPayoutRequest, enqueueOperation, getOperation, journalKey } from "../paypal/operations";
import { payoutRecipientType, resolvePayoutOutcome, type ObservedPayoutStatus } from "./payoutStatus";
import { postPayoutFee } from "./paypalFees";
import { railForWorld } from "./worlds";

/** The plan's single per-world note series name — see `services/worlds.ts`. */
const MANDATE_POOL_A_NAME = "Mandate Pool A";

const DAY_MS = 86_400_000;
/** An offer is valid for one simulated day (plan, Fixed P1 pricing). */
const OFFER_TTL_MS = DAY_MS;
/** APR above which the disclosure carries the state-cap note (36%). */
const STATE_CAP_NOTE_APR_BPS = 3600;

type LoanRow = typeof loans.$inferSelect;
type OfferRow = typeof offers.$inferSelect;

// ---------------------------------------------------------------------
// Loan-activated hooks (Task 7 registers the invoice repayment link)
// ---------------------------------------------------------------------

/**
 * Runs inside the same transaction that moves a loan DISBURSING → ACTIVE
 * and posts the disbursement journal, after both — so whatever a hook
 * writes commits (or rolls back) atomically with the activation. Because
 * it runs inside a transaction a hook may only write rows and
 * `enqueueOperation(tx, …)`; it must NEVER call PayPal (the money-movement
 * rule) — whoever executes the activation's queued work does that after
 * commit (Task 8's reconcile cron picks up anything still queued).
 *
 * A hook that throws rolls the whole activation back: the loan stays
 * DISBURSING with no journal, and the next `applyPayoutOutcome` call
 * (inline, webhook, or cron) retries it.
 *
 * `loan` is the row as updated (status `active`, `disbursedSimAt` and the
 * re-based `dueSimAt` set).
 */
export type LoanActivatedHook = (tx: Db, loan: LoanRow) => Promise<void>;

const loanActivatedHooks: LoanActivatedHook[] = [];

/** Registers a hook to run on every loan activation, in registration order. */
export function registerLoanActivatedHook(hook: LoanActivatedHook): void {
  loanActivatedHooks.push(hook);
}

/** Test-only: forgets every registered loan-activated hook. */
export function __resetLoanActivatedHooksForTests(): void {
  loanActivatedHooks.length = 0;
}

// ---------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------

async function lockNoteSeries(tx: Db, worldId: string): Promise<void> {
  const locked = await scoped(tx, worldId).forUpdate(noteSeries, eq(noteSeries.name, MANDATE_POOL_A_NAME));
  if (locked.length === 0) {
    throw new Error(`Expected a "${MANDATE_POOL_A_NAME}" note series to exist for world ${worldId}`);
  }
}

async function appendEvent(
  tx: Db,
  worldId: string,
  event: { type: string; aggregateType: string; aggregateId: string; simAt: Date; payload?: Record<string, unknown> },
): Promise<void> {
  await scoped(tx, worldId).insert(events, {
    type: event.type,
    aggregateType: event.aggregateType,
    aggregateId: event.aggregateId,
    payload: event.payload ?? null,
    occurredSimAt: event.simAt,
  });
}

async function hasOpenLoan(db: Db, worldId: string, agentId: string): Promise<boolean> {
  const open = await scoped(db, worldId).select(
    loans,
    and(eq(loans.agentId, agentId), inArray(loans.status, [...OPEN_LOAN_DB_STATUSES]))!,
  );
  return open.length > 0;
}

/** The offer (and its application) iff it belongs to `agentId` — fail closed otherwise. */
async function findOwnedOffer(
  tx: Db,
  worldId: string,
  agentId: string,
  offerId: string,
  { lock }: { lock: boolean },
): Promise<{ offer: OfferRow; application: typeof applications.$inferSelect } | null> {
  const offer = lock
    ? (await scoped(tx, worldId).forUpdate(offers, eq(offers.id, offerId)))[0]
    : await scoped(tx, worldId).findOne(offers, eq(offers.id, offerId));
  if (!offer) {
    return null;
  }
  const application = await scoped(tx, worldId).findOne(
    applications,
    and(eq(applications.id, offer.applicationId), eq(applications.agentId, agentId))!,
  );
  return application ? { offer, application } : null;
}

/** OFFERED → EXPIRED, conditional on the row still being `offered`. */
async function expireOffer(tx: Db, worldId: string, offer: OfferRow, simAt: Date, reason: string): Promise<void> {
  const next = transition(fromDbStatus(offer.status), "EXPIRE");
  const updated = await scoped(tx, worldId).update(
    offers,
    { status: toDbStatus(next) },
    and(eq(offers.id, offer.id), eq(offers.status, "offered"))!,
  );
  if (updated.length === 1) {
    await appendEvent(tx, worldId, {
      type: "loan.offer_expired",
      aggregateType: "offer",
      aggregateId: offer.id,
      simAt,
      payload: { reason },
    });
  }
}

function addDays(at: Date, days: number): Date {
  return new Date(at.getTime() + days * DAY_MS);
}

// ---------------------------------------------------------------------
// check_eligibility
// ---------------------------------------------------------------------

export interface Quote {
  feeCents: bigint;
  aprBps: number;
  totalCents: bigint;
}

export interface Eligibility {
  eligible: boolean;
  /** Subset of `amount_out_of_range`, `term_out_of_range`, `open_loan_exists`, `insufficient_liquidity`, in that order. */
  reasons: string[];
  maxPrincipalCents: bigint;
  availableLiquidityCents: bigint;
  quote: Quote;
}

/**
 * Read-only eligibility for `(amount, term)`: the P1 range checks, the
 * one-open-loan rule, and available liquidity. Advisory only —
 * `apply_for_loan` re-evaluates the same rules, and `accept_offer`
 * re-checks liquidity and the open loan under the series lock.
 */
export async function checkEligibility(
  db: Db,
  worldId: string,
  agentId: string,
  amountCents: bigint,
  termDays: number,
): Promise<Eligibility> {
  const reasons = rangeReasons(amountCents, termDays);
  if (await hasOpenLoan(db, worldId, agentId)) {
    reasons.push("open_loan_exists");
  }
  const availableLiquidityCents = await availableLiquidity(db, worldId);
  if (amountCents > availableLiquidityCents) {
    reasons.push("insufficient_liquidity");
  }

  // Below the P1 minimum principal nothing can be lent at all (M2).
  const maxPrincipalCents =
    availableLiquidityCents < PRICING_LIMITS.minPrincipalCents
      ? 0n
      : availableLiquidityCents < PRICING_LIMITS.maxPrincipalCents
        ? availableLiquidityCents
        : PRICING_LIMITS.maxPrincipalCents;

  const { feeCents, aprBps } = price(amountCents, termDays);

  return {
    eligible: reasons.length === 0,
    reasons,
    maxPrincipalCents,
    availableLiquidityCents,
    quote: { feeCents, aprBps, totalCents: amountCents + feeCents },
  };
}

// ---------------------------------------------------------------------
// apply_for_loan
// ---------------------------------------------------------------------

export interface InvoiceInput {
  clientEmail: string;
  amountCents: bigint;
  dueInDays: number;
  description: string;
}

export interface LoanApplicationInput {
  amountCents: bigint;
  termDays: number;
  purpose: string;
  invoice: InvoiceInput | null;
}

/** The disclosure shown to the agent; its canonical JSON's sha256 is what `accept_offer` must echo back. */
export interface Disclosure {
  funding_provided_cents: number;
  fee_cents: number;
  estimated_apr_bps: number;
  total_repayment_cents: number;
  term_days: number;
  /** Offer time + term; the real due date is `due_rule` applied to when the funds are sent (Ruling P). */
  estimated_due_date: string;
  due_rule: string;
  prepayment: "No penalty";
  collateral: "Invoice payment link" | "None";
  avoidable_fees: "None in P1";
  note?: "APR above 36% may exceed some state caps (unverified)";
}

export type CreateLoanOfferOutcome =
  | { outcome: "declined"; applicationId: string; reasons: string[] }
  | {
      outcome: "offered";
      applicationId: string;
      offerId: string;
      disclosure: Disclosure;
      disclosureHash: string;
      expiresSimAt: Date;
    };

function buildDisclosure(
  amountCents: bigint,
  feeCents: bigint,
  aprBps: number,
  termDays: number,
  dueSimAt: Date,
  hasInvoice: boolean,
): Disclosure {
  const disclosure: Disclosure = {
    funding_provided_cents: Number(amountCents),
    fee_cents: Number(feeCents),
    estimated_apr_bps: aprBps,
    total_repayment_cents: Number(amountCents + feeCents),
    term_days: termDays,
    estimated_due_date: dueSimAt.toISOString(),
    due_rule: `${termDays} days after funds are sent`,
    prepayment: "No penalty",
    collateral: hasInvoice ? "Invoice payment link" : "None",
    avoidable_fees: "None in P1",
  };
  if (aprBps > STATE_CAP_NOTE_APR_BPS) {
    disclosure.note = "APR above 36% may exceed some state caps (unverified)";
  }
  return disclosure;
}

/**
 * `apply_for_loan`'s transactional half. Always records the application.
 * When the P1 rules decline it (range, open loan, liquidity — evaluated
 * under the note series row lock for a consistent snapshot) it is
 * `declined` with the reason codes; otherwise it is `offered` and an
 * offer is created with the priced disclosure and its hash, valid for one
 * simulated day. Any of the agent's earlier still-open offers are
 * superseded (expired) first, so an agent has at most one live offer.
 *
 * Ruling P: the loan is due `term_days` after the funds are sent (the
 * borrower always gets the full term). The disclosure says so in
 * `due_rule`, and `estimated_due_date` is `now + term_days`; both are
 * covered by the hash.
 */
export async function createLoanOffer(
  tx: Db,
  worldId: string,
  agentId: string,
  input: LoanApplicationInput,
): Promise<CreateLoanOfferOutcome> {
  const simNow = await getSimNow(tx, worldId);

  // Ruling N lock order: the series row first. Serialises this with
  // `accept_offer` (which also locks it first), so an offer can't be
  // superseded underneath a concurrent acceptance of it.
  await lockNoteSeries(tx, worldId);

  const [application] = await scoped(tx, worldId).insert(applications, {
    agentId,
    amountCents: input.amountCents,
    termDays: input.termDays,
    purpose: input.purpose,
    invoiceRef: input.invoice
      ? {
          client_email: input.invoice.clientEmail,
          amount_cents: Number(input.invoice.amountCents),
          due_in_days: input.invoice.dueInDays,
          description: input.invoice.description,
        }
      : null,
    status: toDbStatus("SUBMITTED"),
  });
  if (!application) {
    throw new Error("Expected an applications row to be inserted");
  }

  const reasons = rangeReasons(input.amountCents, input.termDays);
  if (await hasOpenLoan(tx, worldId, agentId)) {
    reasons.push("open_loan_exists");
  }
  if (input.amountCents > (await availableLiquidity(tx, worldId))) {
    reasons.push("insufficient_liquidity");
  }

  if (reasons.length > 0) {
    await scoped(tx, worldId).update(
      applications,
      {
        status: toDbStatus(transition("SUBMITTED", "DECLINE")),
        decision: "declined",
        reasonCodes: reasons,
      },
      eq(applications.id, application.id),
    );
    await appendEvent(tx, worldId, {
      type: "loan.declined",
      aggregateType: "application",
      aggregateId: application.id,
      simAt: simNow,
      payload: { reasons },
    });
    return { outcome: "declined", applicationId: application.id, reasons };
  }

  // Supersede the agent's earlier open offers.
  const agentApplications = await scoped(tx, worldId).select(applications, eq(applications.agentId, agentId));
  const earlierIds = agentApplications.map((row) => row.id).filter((id) => id !== application.id);
  if (earlierIds.length > 0) {
    const openOffers = await scoped(tx, worldId).select(
      offers,
      and(inArray(offers.applicationId, earlierIds), eq(offers.status, "offered"))!,
    );
    for (const offer of openOffers) {
      await expireOffer(tx, worldId, offer, simNow, "superseded");
    }
  }

  const { feeCents, aprBps } = price(input.amountCents, input.termDays);
  const dueSimAt = addDays(simNow, input.termDays);
  const expiresSimAt = new Date(simNow.getTime() + OFFER_TTL_MS);
  const disclosure = buildDisclosure(input.amountCents, feeCents, aprBps, input.termDays, dueSimAt, !!input.invoice);
  // Round-trip through canonical JSON so what's stored is exactly what was hashed.
  const storedDisclosure = JSON.parse(canonicalJson(disclosure)) as Disclosure;
  const hash = disclosureHash(storedDisclosure);

  const [offer] = await scoped(tx, worldId).insert(offers, {
    applicationId: application.id,
    principalCents: input.amountCents,
    feeCents,
    aprBps,
    termDays: input.termDays,
    dueSimAt,
    disclosure: storedDisclosure,
    disclosureHash: hash,
    expiresSimAt,
    status: toDbStatus("OFFERED"),
  });
  if (!offer) {
    throw new Error("Expected an offers row to be inserted");
  }

  await scoped(tx, worldId).update(
    applications,
    { status: toDbStatus(transition("SUBMITTED", "OFFER")), decision: "approved", reasonCodes: [] },
    eq(applications.id, application.id),
  );
  await appendEvent(tx, worldId, {
    type: "loan.offered",
    aggregateType: "offer",
    aggregateId: offer.id,
    simAt: simNow,
    payload: { application_id: application.id, principal_cents: Number(input.amountCents), fee_cents: Number(feeCents) },
  });

  return {
    outcome: "offered",
    applicationId: application.id,
    offerId: offer.id,
    disclosure: storedDisclosure,
    disclosureHash: hash,
    expiresSimAt,
  };
}

// ---------------------------------------------------------------------
// accept_offer / decline_offer
// ---------------------------------------------------------------------

export type AcceptOfferOutcome =
  | { outcome: "not_found" }
  | { outcome: "disclosure_mismatch" }
  | { outcome: "offer_expired" }
  | { outcome: "invalid_transition"; state: LoanState; loanId: string | null }
  | { outcome: "open_loan_exists" }
  | { outcome: "insufficient_liquidity"; availableLiquidityCents: bigint }
  | { outcome: "payout_receiver_missing" }
  | { outcome: "disbursing"; loanId: string; payoutOperationId: string };

/**
 * `accept_offer`'s transactional half (Review Focus 4). Locks the world's
 * note series row FIRST (Ruling N), then the offer row, and only then
 * evaluates the offer, the one-open-loan rule and available liquidity —
 * so two concurrent acceptances (by different agents, or the same agent
 * on two offers) are fully serialised on the series lock and the second
 * one sees the first one's DISBURSING principal subtracted from
 * liquidity. Creates the loan in DISBURSING and enqueues its
 * `payout.send` (purpose `loan_disbursement`, sourceId = loan id) — never
 * executes it here; the tool executes it after commit via
 * `applyPayoutOutcome`.
 *
 * Writes nothing on a refusal, except that an offer found past its expiry
 * is marked EXPIRED (the handler returns an envelope, so that commits).
 */
export async function beginAcceptOffer(
  tx: Db,
  worldId: string,
  agentId: string,
  offerId: string,
  presentedHash: string,
): Promise<AcceptOfferOutcome> {
  const simNow = await getSimNow(tx, worldId);

  await lockNoteSeries(tx, worldId);
  const owned = await findOwnedOffer(tx, worldId, agentId, offerId, { lock: true });
  if (!owned) {
    return { outcome: "not_found" };
  }
  const { offer } = owned;

  if (presentedHash !== offer.disclosureHash) {
    return { outcome: "disclosure_mismatch" };
  }

  const offerState = fromDbStatus(offer.status);
  if (offerState === "EXPIRED") {
    return { outcome: "offer_expired" };
  }
  if (offerState !== "OFFERED") {
    const [loan] = await scoped(tx, worldId).select(loans, eq(loans.offerId, offer.id));
    return { outcome: "invalid_transition", state: offerState, loanId: loan?.id ?? null };
  }
  if (simNow.getTime() >= offer.expiresSimAt.getTime()) {
    await expireOffer(tx, worldId, offer, simNow, "expired");
    return { outcome: "offer_expired" };
  }

  if (await hasOpenLoan(tx, worldId, agentId)) {
    return { outcome: "open_loan_exists" };
  }

  const availableLiquidityCents = await availableLiquidity(tx, worldId);
  if (offer.principalCents > availableLiquidityCents) {
    return { outcome: "insufficient_liquidity", availableLiquidityCents };
  }

  const [agent] = await scoped(tx, worldId).select(agents, eq(agents.id, agentId));
  const recipientType = payoutRecipientType(agent?.payoutReceiverType ?? null);
  if (!agent || !agent.payoutReceiver || !recipientType) {
    return { outcome: "payout_receiver_missing" };
  }

  const acceptedState = transition(offerState, "ACCEPT");
  const updated = await scoped(tx, worldId).update(
    offers,
    { status: toDbStatus(acceptedState), acceptedAckHash: presentedHash },
    and(eq(offers.id, offer.id), eq(offers.status, "offered"))!,
  );
  if (updated.length !== 1) {
    // Unreachable while we hold the offer's row lock; fail loudly if not.
    throw new Error(`Offer ${offer.id} changed status under its row lock`);
  }

  const [loan] = await scoped(tx, worldId).insert(loans, {
    offerId: offer.id,
    agentId,
    principalCents: offer.principalCents,
    feeCents: offer.feeCents,
    // Nothing is owed until the funds are sent: P + F is set at activation.
    outstandingCents: 0n,
    // Provisional; re-based on the disbursement time at activation (Ruling P).
    dueSimAt: addDays(simNow, offer.termDays),
    status: toDbStatus(transition(acceptedState, "DISBURSE")),
  });
  if (!loan) {
    throw new Error("Expected a loans row to be inserted");
  }

  const rail = await railForWorld(tx, worldId);
  const { operationId } = await enqueueOperation(tx, {
    worldId,
    rail,
    kind: "payout.send",
    purpose: "loan_disbursement",
    sourceId: loan.id,
    request: buildSendPayoutRequest({
      receiver: agent.payoutReceiver,
      receiverType: recipientType,
      amountCents: offer.principalCents,
      note: "Mandate loan disbursement",
      senderItemId: loan.id,
    }),
  });
  await scoped(tx, worldId).update(loans, { disbursementOpId: operationId }, eq(loans.id, loan.id));

  await appendEvent(tx, worldId, {
    type: "loan.accepted",
    aggregateType: "loan",
    aggregateId: loan.id,
    simAt: simNow,
    payload: { offer_id: offer.id, principal_cents: Number(offer.principalCents) },
  });

  return { outcome: "disbursing", loanId: loan.id, payoutOperationId: operationId };
}

export type DeclineOfferOutcome =
  | { outcome: "not_found" }
  | { outcome: "offer_expired" }
  | { outcome: "invalid_transition"; state: LoanState }
  | { outcome: "declined" };

/** OFFERED → DECLINED_BY_AGENT for the agent's own offer (row-locked). */
export async function declineOffer(
  tx: Db,
  worldId: string,
  agentId: string,
  offerId: string,
): Promise<DeclineOfferOutcome> {
  const simNow = await getSimNow(tx, worldId);
  const owned = await findOwnedOffer(tx, worldId, agentId, offerId, { lock: true });
  if (!owned) {
    return { outcome: "not_found" };
  }
  const { offer } = owned;
  const state = fromDbStatus(offer.status);
  if (state === "EXPIRED") {
    return { outcome: "offer_expired" };
  }
  if (state !== "OFFERED") {
    return { outcome: "invalid_transition", state };
  }
  if (simNow.getTime() >= offer.expiresSimAt.getTime()) {
    await expireOffer(tx, worldId, offer, simNow, "expired");
    return { outcome: "offer_expired" };
  }

  await scoped(tx, worldId).update(
    offers,
    { status: toDbStatus(transition(state, "DECLINE_OFFER")) },
    and(eq(offers.id, offer.id), eq(offers.status, "offered"))!,
  );
  await appendEvent(tx, worldId, {
    type: "loan.offer_declined",
    aggregateType: "offer",
    aggregateId: offer.id,
    simAt: simNow,
  });
  return { outcome: "declined" };
}

/**
 * Expires every still-`offered` offer whose `expires_sim_at` has passed
 * (Task 8's tick). Each expiry is a conditional update, so it is a no-op
 * against an offer a concurrent `accept_offer` already accepted (that
 * transaction holds the offer's row lock until it commits).
 */
export async function expireStaleOffers(db: Db, worldId: string, simNow: Date): Promise<number> {
  const stale = await scoped(db, worldId).select(
    offers,
    and(eq(offers.status, "offered"), lte(offers.expiresSimAt, simNow))!,
  );
  for (const offer of stale) {
    await db.transaction((tx) => expireOffer(tx, worldId, offer, simNow, "expired"));
  }
  return stale.length;
}

// ---------------------------------------------------------------------
// Disbursement outcome
// ---------------------------------------------------------------------

/**
 * Settles a loan disbursement payout (Rulings B/J/Q/R). Idempotent; safe
 * to call from `accept_offer`'s finalize step, Task 8's webhook (with
 * `observed`) and its reconcile cron (via `pollPayoutStatus`), any number
 * of times, concurrently. Never call inside a transaction.
 *
 * `resolvePayoutOutcome` (services/payoutStatus.ts) executes the
 * `payout.send` operation and resolves the item's status from — in order
 * — a succeeded cancel, `observed`, the newest `payout.get` read of the
 * batch, then the send result:
 * - `SUCCESS` → DISBURSING → ACTIVE, `disbursed_sim_at` = now,
 *   `due_sim_at` = now + term (Ruling P), `outstanding_cents` = P + F,
 *   journal Dr `loans_receivable` / Cr `cash_paypal` (P), event
 *   `loan.disbursed`, then every loan-activated hook — all in ONE
 *   transaction, the journal posted only after the conditional
 *   `WHERE status = 'disbursing'` update wins.
 * - `FAILED`/`RETURNED`/`BLOCKED`/`REFUNDED`/`DENIED`, or a terminally
 *   failed operation → DISBURSEMENT_FAILED, outstanding 0, no journal,
 *   event `loan.disbursement_failed` with the reason. The reserved
 *   liquidity is released (the loan no longer counts as DISBURSING).
 * - `UNCLAIMED` (Ruling R) → stays DISBURSING (liquidity stays reserved)
 *   while the item is cancelled; once the cancel returns it (RETURNED),
 *   the failure above applies.
 * - anything else → stays DISBURSING for a later call.
 *
 * Both settlements lock the note series row first (Ruling N), so they
 * serialise with `accept_offer`'s liquidity read: without it, an
 * activation committing between that read's cash balance and its
 * Σ DISBURSING could make the pool look P cents richer than it is.
 *
 * Only handles operations with purpose `loan_disbursement`; any other
 * operation is ignored.
 */
export async function applyPayoutOutcome(
  db: Db,
  operationId: string,
  observed?: ObservedPayoutStatus,
): Promise<void> {
  const record = await getOperation(db, operationId);
  if (!record || record.kind !== "payout.send" || record.purpose !== "loan_disbursement" || !record.sourceId) {
    return;
  }
  const worldId = record.worldId;
  const loanId = record.sourceId;

  const loan = await scoped(db, worldId).findOne(loans, eq(loans.id, loanId));
  if (!loan || loan.status !== "disbursing") {
    return; // Unknown, or already settled.
  }

  const resolution = await resolvePayoutOutcome(db, operationId, observed);
  if (resolution.kind === "pending") {
    return;
  }
  if (resolution.kind === "failed") {
    await settleDisbursementFailure(db, worldId, loan, resolution.reason);
    return;
  }

  const simAt = await getSimNow(db, worldId);
  const offer = await scoped(db, worldId).findOne(offers, eq(offers.id, loan.offerId));
  if (!offer) {
    throw new Error(`offers row ${loan.offerId} not found for loan ${loan.id}`);
  }

  await db.transaction(async (tx) => {
    await lockNoteSeries(tx, worldId);
    const [activated] = await scoped(tx, worldId).update(
      loans,
      {
        status: toDbStatus(transition("DISBURSING", "PAYOUT_SUCCEEDED")),
        disbursedSimAt: simAt,
        dueSimAt: addDays(simAt, offer.termDays),
        outstandingCents: loan.principalCents + loan.feeCents,
      },
      and(eq(loans.id, loan.id), eq(loans.status, "disbursing"))!,
    );
    if (!activated) {
      return; // Lost a race with another settlement; it applied the effect.
    }

    await postJournal(tx, {
      worldId,
      memo: "Loan disbursed",
      sourceType: "loans",
      sourceId: loan.id,
      simAt,
      idempotencyKey: journalKey("loan_disbursement", loan.id),
      postings: [
        { accountCode: "loans_receivable", amountCents: loan.principalCents },
        { accountCode: "cash_paypal", amountCents: -loan.principalCents },
      ],
    });
    if (resolution.fee) {
      // Task 10b: the payout's PayPal fee, same transaction (once per batch).
      await postPayoutFee(tx, { worldId, simAt, sourceType: "loans", sourceId: loan.id }, resolution.fee);
    }

    await appendEvent(tx, worldId, {
      type: "loan.disbursed",
      aggregateType: "loan",
      aggregateId: loan.id,
      simAt,
      payload: { principal_cents: Number(loan.principalCents), due_sim_at: activated.dueSimAt.toISOString() },
    });

    for (const hook of loanActivatedHooks) {
      await hook(tx, activated);
    }
  });
}

async function settleDisbursementFailure(db: Db, worldId: string, loan: LoanRow, reason: string): Promise<void> {
  const simAt = await getSimNow(db, worldId);
  await db.transaction(async (tx) => {
    await lockNoteSeries(tx, worldId);
    const [failed] = await scoped(tx, worldId).update(
      loans,
      { status: toDbStatus(transition("DISBURSING", "PAYOUT_FAILED")), outstandingCents: 0n },
      and(eq(loans.id, loan.id), eq(loans.status, "disbursing"))!,
    );
    if (!failed) {
      return;
    }
    await appendEvent(tx, worldId, {
      type: "loan.disbursement_failed",
      aggregateType: "loan",
      aggregateId: loan.id,
      simAt,
      payload: { reason },
    });
  });
}

// ---------------------------------------------------------------------
// get_loan
// ---------------------------------------------------------------------

export interface LoanEventView {
  type: string;
  occurredSimAt: Date;
  payload: unknown;
}

export interface LoanView {
  loan: LoanRow;
  state: LoanState;
  history: LoanEventView[];
  /** Why the disbursement failed (the payout item status, or `payout_error:<issue>`), when it did. */
  disbursementFailureReason: string | null;
}

/**
 * The agent's own loan with its history (events on its application,
 * offer and the loan itself, oldest first), or `null` if the loan doesn't
 * exist or belongs to another agent (fail closed — callers map that to
 * NOT_FOUND without distinguishing the two).
 */
export async function getLoanView(db: Db, worldId: string, agentId: string, loanId: string): Promise<LoanView | null> {
  const loan = await scoped(db, worldId).findOne(loans, and(eq(loans.id, loanId), eq(loans.agentId, agentId))!);
  if (!loan) {
    return null;
  }
  const offer = await scoped(db, worldId).findOne(offers, eq(offers.id, loan.offerId));
  const aggregateIds = [loan.id, loan.offerId, ...(offer ? [offer.applicationId] : [])];

  const rows = (await scoped(db, worldId).select(events, inArray(events.aggregateId, aggregateIds))).sort((a, b) =>
    a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0,
  );

  const history = rows.map((row) => ({ type: row.type, occurredSimAt: row.occurredSimAt, payload: row.payload }));
  const failure = [...history].reverse().find((event) => event.type === "loan.disbursement_failed");
  const failureReason = (failure?.payload as { reason?: string } | null)?.reason ?? null;

  return { loan, state: fromDbStatus(loan.status), history, disbursementFailureReason: failureReason };
}

/**
 * Reason codes telling the agent why its disbursement failed: always
 * `payout_failed`, plus `payout_<item status>` (e.g. `payout_unclaimed` —
 * the receiver has no PayPal account) or `payout_error:<issue>` when
 * PayPal rejected the payout request outright.
 */
export function disbursementFailureReasonCodes(reason: string | null): string[] {
  if (!reason) {
    return ["payout_failed"];
  }
  const specific = reason.startsWith("payout_error:") ? reason.toLowerCase() : `payout_${reason.toLowerCase()}`;
  // De-duplicated: an item status of FAILED would otherwise repeat `payout_failed`.
  return [...new Set(["payout_failed", specific])];
}
