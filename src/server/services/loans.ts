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
import { PRICING_LIMITS } from "../domain/pricing";
import { totalBps, type LoanPrice } from "../domain/pricingV2";
import type { ReasonCode } from "../domain/reasons";
import { evaluateApplication, sanctionsStubList, type ApplicationDecision } from "../domain/rules";
import type { Grade, ScoreResult } from "../domain/scorecard";
import { isCurrentMandate, TIER_MAX_PER_LOAN_CENTS, type KyaTier } from "../domain/kya";
import type { MandateCollateral } from "../domain/mandate";
import { invoiceCoverageBps, recordScore, scoreAgent } from "./credit";
import { postJournal } from "../ledger/postJournal";
import { buildSendPayoutRequest, enqueueOperation, getOperation, journalKey } from "../paypal/operations";
import { payoutRecipientType, resolvePayoutOutcome, type ObservedPayoutStatus } from "./payoutStatus";
import { postPayoutFee } from "./paypalFees";
import { railForWorld } from "./worlds";
import { borrowGate, loadAgentKya } from "./kya";
import type { BorrowBlocker } from "../domain/kya";
import {
  checkAgentMandate,
  currentMandateRow,
  mandateLimits,
  mandateSummary,
  principalExposure,
  type MandateRow,
  type MandateSummary,
  type TierReason,
} from "./mandates";
import type { MandateReason } from "../domain/mandate";

/** The plan's single per-world note series name — see `services/worlds.ts`. */
const MANDATE_POOL_A_NAME = "Mandate Pool A";

const DAY_MS = 86_400_000;
/** An offer is valid for one simulated day (plan, Fixed P1 pricing). */
const OFFER_TTL_MS = DAY_MS;

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

function retryArgs(offer: OfferRow): EligibilityArgs {
  return { amount_cents: Number(offer.principalCents), term_days: offer.termDays };
}

function addDays(at: Date, days: number): Date {
  return new Date(at.getTime() + days * DAY_MS);
}

// ---------------------------------------------------------------------
// Underwriting (P3 Task 2): facts → rules pipeline
// ---------------------------------------------------------------------

interface UnderwriteRequest {
  amountCents: bigint;
  termDays: number;
  purpose: string;
  /** Mandate collateral rule kind; `null` skips it (check_eligibility without a kind). */
  collateral: MandateCollateral | null;
  /** The invoice face backing the request; `null` without one. */
  invoiceAmountCents: bigint | null;
}

interface Underwriting {
  decision: ApplicationDecision;
  credit: ScoreResult;
  mandate: MandateRow | null;
  exposureCents: bigint;
  tier: KyaTier;
  availableLiquidityCents: bigint;
}

/**
 * Gathers the application's facts — the agent's score (with the invoice's
 * coverage), tier cap, current mandate and the principal's exposure, the
 * open-loan rule and pool liquidity — and runs the pure rules pipeline
 * (`domain/rules.ts`), which also prices the loan (`domain/pricingV2.ts`).
 * `apply_for_loan` calls it under the note series lock.
 */
async function underwrite(
  db: Db,
  worldId: string,
  agentId: string,
  simNow: Date,
  request: UnderwriteRequest,
  now: Date = new Date(),
): Promise<Underwriting> {
  const { agent, tier } = await loadAgentKya(db, worldId, agentId, now);
  const row = await currentMandateRow(db, worldId, agent.id, agent.principalId);
  const mandate = row && isCurrentMandate(row, agent.principalId, now) ? row : null;
  const exposureCents = mandate ? await principalExposure(db, worldId, mandate.principalId) : 0n;
  const coverageBps =
    request.invoiceAmountCents === null ? null : invoiceCoverageBps(request.invoiceAmountCents, request.amountCents);
  const credit = await scoreAgent(db, worldId, agentId, simNow, {
    now,
    ...(coverageBps === null ? {} : { invoiceCoverageBps: coverageBps }),
  });
  const availableLiquidityCents = await availableLiquidity(db, worldId);

  const decision = evaluateApplication({
    amountCents: request.amountCents,
    termDays: request.termDays,
    purpose: request.purpose,
    credit,
    tierCapCents: BigInt(TIER_MAX_PER_LOAN_CENTS[tier.tier]),
    mandate: mandate ? mandateLimits(mandate) : null,
    exposureCents,
    collateral: request.collateral,
    invoiceCoverageBps: coverageBps,
    sanctions: { name: agent.name, operator: agent.operator, list: sanctionsStubList() },
    // ALA declarations arrive in P3 Task 4; until then they are taken as given.
    declarations: { noOtherDebt: true },
    openLoanExists: await hasOpenLoan(db, worldId, agentId),
    availableLiquidityCents,
  });
  return { decision, credit, mandate, exposureCents, tier: tier.tier, availableLiquidityCents };
}

/** The disclosure's rate components (bps of the principal for the term). */
export interface RateComponents {
  cost_of_funds_bps: number;
  expected_loss_bps: number;
  ops_bps: number;
  capital_bps: number;
  total_bps: number;
}

function rateComponents(price: LoanPrice): RateComponents {
  return {
    cost_of_funds_bps: price.components.costOfFundsBps,
    expected_loss_bps: price.components.expectedLossBps,
    ops_bps: price.components.opsBps,
    capital_bps: price.components.capitalBps,
    total_bps: totalBps(price.components),
  };
}

export const APR_FLAG_TEXT = "APR above 36% may exceed some state caps (CA/NY-style; unverified)";

// ---------------------------------------------------------------------
// check_eligibility
// ---------------------------------------------------------------------

export interface Quote {
  feeCents: bigint;
  aprBps: number;
  totalCents: bigint;
  grade: Grade;
  score: number;
  rateComponents: RateComponents;
  /** `APR_FLAG_TEXT` when the APR is above 36%, else `null`. */
  aprFlag: string | null;
}

export interface Eligibility {
  eligible: boolean;
  /**
   * The rules pipeline's reason codes in its fixed order (`domain/rules.ts`),
   * except `mandate_missing` (the tool's tier gate reports it) and
   * `mandate_collateral` unless a collateral kind is given.
   */
  reasons: ReasonCode[];
  maxPrincipalCents: bigint;
  availableLiquidityCents: bigint;
  /** min(grade limit, tier cap, mandate max_per_loan); 0 without a mandate. */
  effectiveCapCents: bigint;
  /** The v2 price; `null` for grade E (never offered). */
  quote: Quote | null;
  /** The agent's current mandate, its limits and the principal's headroom; `null` without one. */
  mandate: MandateSummary | null;
  /** The score this check used (with the invoice's collateral when one is given). */
  credit: ScoreResult;
}

export interface EligibilityOptions {
  /** Mandate collateral kind to check (`null`: skip that rule). */
  collateral?: MandateCollateral | null;
  /** Invoice face amount backing the request (scores collateral and checks coverage). */
  invoiceAmountCents?: bigint | null;
}

/**
 * Read-only eligibility for `(amount, term)`: the same rules pipeline
 * `apply_for_loan` runs (product range, tier, mandate, sanctions, grade,
 * effective cap, collateral, capacity) and the v2 quote. Advisory only —
 * `apply_for_loan` re-evaluates under the series lock, and `accept_offer`
 * re-checks the mandate, tier, open loan and liquidity.
 */
export async function checkEligibility(
  db: Db,
  worldId: string,
  agentId: string,
  amountCents: bigint,
  termDays: number,
  options: EligibilityOptions = {},
): Promise<Eligibility> {
  const simNow = await getSimNow(db, worldId);
  const { decision, credit, mandate, exposureCents, tier, availableLiquidityCents } = await underwrite(
    db,
    worldId,
    agentId,
    simNow,
    {
      amountCents,
      termDays,
      // Advisory: the purpose and declarations are only known at apply time.
      purpose: "eligibility check",
      collateral: options.collateral ?? null,
      invoiceAmountCents: options.invoiceAmountCents ?? null,
    },
  );
  // A missing mandate is the tier gate's `mandate_missing` blocker (reported by the tool).
  const reasons = decision.reasons.filter((reason) => reason !== "mandate_missing");

  // Below the P1 minimum principal nothing can be lent at all (M2).
  const maxPrincipalCents =
    availableLiquidityCents < PRICING_LIMITS.minPrincipalCents
      ? 0n
      : availableLiquidityCents < PRICING_LIMITS.maxPrincipalCents
        ? availableLiquidityCents
        : PRICING_LIMITS.maxPrincipalCents;

  const price = decision.price;
  return {
    eligible: reasons.length === 0,
    reasons,
    maxPrincipalCents,
    availableLiquidityCents,
    effectiveCapCents: decision.effectiveCapCents,
    quote: price
      ? {
          feeCents: price.feeCents,
          aprBps: price.aprBps,
          totalCents: amountCents + price.feeCents,
          grade: credit.grade,
          score: credit.score,
          rateComponents: rateComponents(price),
          aprFlag: price.aprFlag ? APR_FLAG_TEXT : null,
        }
      : null,
    mandate: mandate ? mandateSummary(mandate, exposureCents, tier) : null,
    credit,
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
  /** The total cost of credit (= the fee; no other charges). */
  total_cost_cents: number;
  term_days: number;
  /** Offer time + term; the real due date is `due_rule` applied to when the funds are sent (Ruling P). */
  estimated_due_date: string;
  due_rule: string;
  prepayment: "No penalty";
  collateral: "Invoice payment link" | "None";
  avoidable_fees: "None";
  /** P2 Task 4: the mandate this offer was made under (accept refuses if it changed). */
  mandate_id: string;
  mandate_version: number;
  /** P3 Task 2: the Agent Credit Score and grade the offer was priced at. */
  credit_score: number;
  credit_grade: Grade;
  /** P3 Task 2: the fee's risk-based components (bps of the principal for the term). */
  rate_components: RateComponents;
  /** Present when the APR is above 36%. */
  apr_flag?: typeof APR_FLAG_TEXT;
  right_to_statement: typeof RIGHT_TO_STATEMENT_TEXT;
}

export const RIGHT_TO_STATEMENT_TEXT =
  "Right to a statement of specific reasons: if your application is declined, you are told the principal reasons.";

export type CreateLoanOfferOutcome =
  | {
      outcome: "declined";
      applicationId: string;
      reasons: ReasonCode[];
      primary: ReasonCode;
      decision: ApplicationDecision;
      credit: ScoreResult;
    }
  | {
      outcome: "offered";
      applicationId: string;
      offerId: string;
      disclosure: Disclosure;
      disclosureHash: string;
      expiresSimAt: Date;
      decision: ApplicationDecision;
      credit: ScoreResult;
    }
  /**
   * M7: the invoice doesn't cover principal + the quoted fee. Nothing is
   * written (no application row) — the tool answers INVALID_REQUEST.
   */
  | { outcome: "invoice_too_small"; minimumInvoiceCents: bigint };

function buildDisclosure(
  amountCents: bigint,
  price: LoanPrice,
  credit: ScoreResult,
  termDays: number,
  dueSimAt: Date,
  hasInvoice: boolean,
  mandate: { id: string; version: number },
): Disclosure {
  const disclosure: Disclosure = {
    funding_provided_cents: Number(amountCents),
    fee_cents: Number(price.feeCents),
    estimated_apr_bps: price.aprBps,
    total_repayment_cents: Number(amountCents + price.feeCents),
    total_cost_cents: Number(price.feeCents),
    term_days: termDays,
    estimated_due_date: dueSimAt.toISOString(),
    due_rule: `${termDays} days after funds are sent`,
    prepayment: "No penalty",
    collateral: hasInvoice ? "Invoice payment link" : "None",
    avoidable_fees: "None",
    mandate_id: mandate.id,
    mandate_version: mandate.version,
    credit_score: credit.score,
    credit_grade: credit.grade,
    rate_components: rateComponents(price),
    right_to_statement: RIGHT_TO_STATEMENT_TEXT,
  };
  if (price.aprFlag) {
    disclosure.apr_flag = APR_FLAG_TEXT;
  }
  return disclosure;
}

/**
 * `apply_for_loan`'s transactional half. Under the note series row lock
 * (Ruling N: a consistent snapshot of exposure and liquidity) it scores the
 * agent and runs the rules pipeline (`underwrite`). An invoice smaller than
 * principal + the quoted fee is refused before anything is written (M7).
 * Otherwise the application is always recorded together with its score
 * (`recordScore`, with the component breakdown). It is `declined` with the
 * pipeline's reason codes, or `offered`: an offer is created with the v2
 * price and the disclosure (grade, score, rate components, APR flag) and
 * its hash, valid for one simulated day. Any of the agent's earlier
 * still-open offers are superseded (expired) first, so an agent has at
 * most one live offer.
 *
 * The offer's terms are fixed here: `accept_offer` re-checks the mandate,
 * tier, open loan and liquidity, not the grade.
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

  const { decision, credit, mandate } = await underwrite(tx, worldId, agentId, simNow, {
    amountCents: input.amountCents,
    termDays: input.termDays,
    purpose: input.purpose,
    collateral: input.invoice ? "invoice_link" : "none",
    invoiceAmountCents: input.invoice ? input.invoice.amountCents : null,
  });

  if (input.invoice) {
    // M7: the bank repays itself from the invoice, so it must cover the
    // whole debt (principal + fee), not just the principal.
    const minimumInvoiceCents = input.amountCents + (decision.price?.feeCents ?? 0n);
    if (input.invoice.amountCents < minimumInvoiceCents) {
      return { outcome: "invoice_too_small", minimumInvoiceCents };
    }
  }

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
    mandateId: mandate?.id ?? null,
    status: toDbStatus("SUBMITTED"),
  });
  if (!application) {
    throw new Error("Expected an applications row to be inserted");
  }
  await recordScore(tx, worldId, agentId, credit, { simNow, applicationId: application.id });

  if (decision.decision === "decline" || !mandate || !decision.price) {
    const reasons = decision.reasons.length > 0 ? decision.reasons : (["mandate_missing"] as ReasonCode[]);
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
      payload: { reasons, primary: reasons[0], approval: decision.approval, score: credit.score, grade: credit.grade },
    });
    return {
      outcome: "declined",
      applicationId: application.id,
      reasons,
      primary: reasons[0]!,
      decision,
      credit,
    };
  }
  const price = decision.price;

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

  const dueSimAt = addDays(simNow, input.termDays);
  const expiresSimAt = new Date(simNow.getTime() + OFFER_TTL_MS);
  const disclosure = buildDisclosure(input.amountCents, price, credit, input.termDays, dueSimAt, !!input.invoice, {
    id: mandate.id,
    version: mandate.version,
  });
  // Round-trip through canonical JSON so what's stored is exactly what was hashed.
  const storedDisclosure = JSON.parse(canonicalJson(disclosure)) as Disclosure;
  const hash = disclosureHash(storedDisclosure);

  const [offer] = await scoped(tx, worldId).insert(offers, {
    applicationId: application.id,
    principalCents: input.amountCents,
    feeCents: price.feeCents,
    aprBps: price.aprBps,
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
    payload: {
      application_id: application.id,
      principal_cents: Number(input.amountCents),
      fee_cents: Number(price.feeCents),
      score: credit.score,
      grade: credit.grade,
    },
  });

  return {
    outcome: "offered",
    applicationId: application.id,
    offerId: offer.id,
    disclosure: storedDisclosure,
    disclosureHash: hash,
    expiresSimAt,
    decision,
    credit,
  };
}

// ---------------------------------------------------------------------
// accept_offer / decline_offer
// ---------------------------------------------------------------------

/** `check_eligibility` arguments for re-trying an offer's amount and term. */
export interface EligibilityArgs {
  amount_cents: number;
  term_days: number;
}

export type AcceptOfferOutcome =
  | { outcome: "not_found" }
  | { outcome: "disclosure_mismatch" }
  | { outcome: "offer_expired" }
  | { outcome: "invalid_transition"; state: LoanState; loanId: string | null }
  | { outcome: "open_loan_exists" }
  | { outcome: "insufficient_liquidity"; availableLiquidityCents: bigint }
  | { outcome: "payout_receiver_missing" }
  /** P2 Task 2: the agent's KYA tier no longer allows borrowing (e.g. the mandate was revoked). */
  | { outcome: "borrow_blocked"; blockers: BorrowBlocker[] }
  /**
   * P2 Task 4: the mandate the offer was made under is no longer current —
   * revoked (or expired) or superseded by a newer signed version.
   */
  | { outcome: "mandate_revoked"; reason: "mandate_revoked" | "mandate_superseded"; retry: EligibilityArgs }
  /** P2 Task 4: the offer no longer fits the mandate (e.g. the principal's exposure rose) or the tier cap. */
  | { outcome: "mandate_limit"; reasons: Array<MandateReason | TierReason>; mandate: MandateSummary; retry: EligibilityArgs }
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

  // P2 Task 2: re-check the KYA tier at acceptance, under the series lock
  // — a mandate can be revoked between offer and acceptance. No claim link:
  // this outcome is stored under the call's idempotency key.
  const gate = await borrowGate(tx, worldId, agentId, { withClaimLink: false });
  if (gate.tier.borrowBlockers.includes("claim_required")) {
    return { outcome: "borrow_blocked", blockers: gate.tier.borrowBlockers };
  }
  if (gate.tier.borrowBlockers.includes("mandate_missing")) {
    return { outcome: "mandate_revoked", reason: "mandate_revoked", retry: retryArgs(offer) };
  }

  // P2 Task 4 (Review Focus 2): re-check the mandate under the series
  // lock. Every acceptance takes that lock first, so the principal's
  // exposure read here includes any loan a concurrent acceptance by
  // another of their agents just created.
  const { agent: kyaAgent, tier } = await loadAgentKya(tx, worldId, agentId);
  const mandateCheck = await checkAgentMandate(tx, worldId, kyaAgent, tier.tier, {
    principalCents: offer.principalCents,
    feeCents: offer.feeCents,
    termDays: offer.termDays,
    collateral: owned.application.invoiceRef ? "invoice_link" : "none",
  });
  if (!mandateCheck.mandate) {
    return { outcome: "mandate_revoked", reason: "mandate_revoked", retry: retryArgs(offer) };
  }
  if (owned.application.mandateId && owned.application.mandateId !== mandateCheck.mandate.id) {
    return { outcome: "mandate_revoked", reason: "mandate_superseded", retry: retryArgs(offer) };
  }
  if (mandateCheck.reasons.length > 0) {
    return {
      outcome: "mandate_limit",
      reasons: mandateCheck.reasons,
      mandate: mandateSummary(mandateCheck.mandate, mandateCheck.exposureCents, tier.tier),
      retry: retryArgs(offer),
    };
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
