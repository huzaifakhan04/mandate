import { and, eq, inArray, isNotNull } from "drizzle-orm";

import type { Db } from "../db/client";
import { loans, noteTransactions, repaymentLinks, repayments } from "../db/schema";
import { scoped } from "../db/scoped";
import {
  deriveOperationId,
  executeOperation,
  getOperation,
  latestPayoutGetForSend,
  listDueOperations,
  orderPollTimes,
  type OperationRecord,
  type OrderCreateResult,
  type PayoutSendResult,
} from "../paypal/operations";
import { settleCheckoutByOrderId } from "../services/checkouts";
import { dispatchPayoutOutcome, pollPayoutStatus } from "../services/payoutPolling";
import { isPollDue } from "../services/pollThrottle";
import {
  loanIdFromInvoiceSourceId,
  refreshDirectRepayment,
  refreshRepaymentLink,
  reissueInvoiceLink,
} from "../services/repayments";
import { listActiveWorldIds } from "../services/worlds";
import { errorMessage, previousAnomalyCount, recordJobRun } from "./jobRuns";

/**
 * Task 8 — the reconcile cron (every minute): what settles money when no
 * agent is online, and what makes the system self-healing. One run, across
 * all worlds, touches at most `limit` (50) items — an item being one
 * piece of work that may call PayPal — and stops starting new items once
 * `deadlineMs` of real time has passed. Each item runs in its own
 * try/catch, so one failure never stops the rest; errors are reported.
 *
 * 1. Operations: (re-)execute money-moving operations that are due
 *    (`queued` older than 30 s, `queued`/`failed_retryable` past
 *    `next_attempt_at`, stale `in_flight`), then push each one's effect
 *    along (payout → its applier; link create → copy the approve URL;
 *    capture → settle the checkout).
 * 2. Payouts: `pollPayoutStatus` for every unsettled payout source —
 *    loans DISBURSING, redemptions pending, remainders pending (it is
 *    throttled by the send's age; throttled skips cost no budget).
 * 3. Checkouts: `settleCheckoutByOrderId` for every open checkout order —
 *    pending note buys, open invoice/direct repayment links — no sooner
 *    than 30 s after the order was created, then throttled by its age
 *    (1 m / 5 m / 30 m / 6 h, `isPollDue`).
 * 4. Anomalies, listed (not fixed): note txs and repayment links in
 *    `review` (captured cash not journaled), UNCLAIMED payouts whose cancel
 *    failed terminally (liquidity stays reserved), failed/held remainder
 *    payouts (still owed in `payable_to_borrower`). One auto-fix: a failed
 *    invoice link on an ACTIVE loan is re-issued (`reissueInvoiceLink`);
 *    once its issues are used up it is listed instead.
 *
 * A world gets a `job_runs` row (counts, errors, anomalies) for a run
 * that did something there or changed its anomaly count (M2). Every step is idempotent, so a run racing a webhook, an
 * agent call or another run applies each effect once.
 */

const DEFAULT_LIMIT = 50;
const DEFAULT_DEADLINE_MS = 45_000;
/** A queued operation younger than this belongs to the request that is about to execute it. */
const QUEUED_MIN_AGE_MS = 30_000;
/** A checkout younger than this is still in the hands of whoever created it. */
const CHECKOUT_MIN_AGE_MS = 30_000;

export type AnomalyType =
  | "note_tx_review"
  | "repayment_link_review"
  | "unclaimed_cancel_failed"
  | "remainder_unpaid"
  | "invoice_link_failed";

export interface Anomaly {
  type: AnomalyType;
  worldId: string;
  sourceId: string;
  detail: Record<string, string | number | null>;
}

export interface ReconcileError {
  worldId: string | null;
  item: string;
  message: string;
}

interface Counts {
  executed: number;
  payoutsPolled: number;
  checkoutsChecked: number;
  checkoutsSettled: number;
  linksReissued: number;
  throttled: number;
}

export interface ReconcileReport extends Counts {
  /** Items that used the run's budget. */
  items: number;
  worlds: number;
  /** True when the run stopped early (item limit or deadline). */
  truncated: boolean;
  errors: ReconcileError[];
  anomalies: Anomaly[];
}

export interface ReconcileOptions {
  /** Real "now" (injectable for tests); compared with rows' `created_at`. */
  now?: Date;
  limit?: number;
  deadlineMs?: number;
}

function emptyCounts(): Counts {
  return { executed: 0, payoutsPolled: 0, checkoutsChecked: 0, checkoutsSettled: 0, linksReissued: 0, throttled: 0 };
}

interface WorldState {
  counts: Counts;
  errors: ReconcileError[];
  anomalies: Anomaly[];
}

class Run {
  used = 0;
  truncated = false;
  readonly worlds = new Map<string, WorldState>();
  private readonly deadlineAt: number;

  constructor(
    readonly db: Db,
    readonly now: Date,
    private readonly limit: number,
    deadlineMs: number,
  ) {
    this.deadlineAt = Date.now() + deadlineMs;
  }

  remaining(): number {
    return Math.max(this.limit - this.used, 0);
  }

  /** Whether another item may start; marks the run truncated when not. */
  canStart(): boolean {
    if (this.used >= this.limit || Date.now() >= this.deadlineAt) {
      this.truncated = true;
      return false;
    }
    return true;
  }

  world(worldId: string): WorldState {
    let state = this.worlds.get(worldId);
    if (!state) {
      state = { counts: emptyCounts(), errors: [], anomalies: [] };
      this.worlds.set(worldId, state);
    }
    return state;
  }

  /** Runs one item, isolating its failure. */
  async item(worldId: string, label: string, work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch (err) {
      const message = errorMessage(err);
      console.error(`[reconcile] ${label} (world ${worldId}) failed: ${message}`);
      this.world(worldId).errors.push({ worldId, item: label, message });
    }
  }
}

export async function runReconcile(db: Db, options: ReconcileOptions = {}): Promise<ReconcileReport> {
  const run = new Run(db, options.now ?? new Date(), options.limit ?? DEFAULT_LIMIT, options.deadlineMs ?? DEFAULT_DEADLINE_MS);
  const runErrors: ReconcileError[] = [];

  const worldIds = await listActiveWorldIds(db);
  for (const worldId of worldIds) {
    run.world(worldId);
  }

  try {
    await executeDueOperations(run);
  } catch (err) {
    runErrors.push({ worldId: null, item: "list_due_operations", message: errorMessage(err) });
  }

  for (const worldId of worldIds) {
    await run.item(worldId, "payout_sources", () => pollPayouts(run, worldId));
    await run.item(worldId, "checkouts", () => pollCheckouts(run, worldId));
    await run.item(worldId, "invoice_links", () => reissueFailedInvoiceLinks(run, worldId));
    await run.item(worldId, "anomalies", () => listAnomalies(run, worldId));
  }

  const report: ReconcileReport = {
    ...emptyCounts(),
    items: run.used,
    worlds: worldIds.length,
    truncated: run.truncated,
    errors: [...runErrors],
    anomalies: [],
  };
  for (const [worldId, state] of run.worlds) {
    for (const key of Object.keys(state.counts) as (keyof Counts)[]) {
      report[key] += state.counts[key];
    }
    report.errors.push(...state.errors);
    report.anomalies.push(...state.anomalies);
    if (!(await worthRecording(db, worldId, state))) {
      continue;
    }
    await recordJobRun(db, worldId, "reconcile", {
      executed: state.counts.executed,
      payouts_polled: state.counts.payoutsPolled,
      checkouts_checked: state.counts.checkoutsChecked,
      checkouts_settled: state.counts.checkoutsSettled,
      links_reissued: state.counts.linksReissued,
      throttled: state.counts.throttled,
      truncated: run.truncated,
      errors: state.errors,
      anomalies: state.anomalies,
    });
  }
  return report;
}

/**
 * Fix round 1 (M2): a world's `job_runs` row is written only when the run
 * did something there (executed, polled, checked, re-issued, or errored)
 * or its anomaly count differs from the last recorded row — idle minutes
 * leave no rows.
 */
async function worthRecording(db: Db, worldId: string, state: WorldState): Promise<boolean> {
  const c = state.counts;
  if (c.executed + c.payoutsPolled + c.checkoutsChecked + c.linksReissued > 0 || state.errors.length > 0) {
    return true;
  }
  try {
    return (await previousAnomalyCount(db, worldId, "reconcile")) !== state.anomalies.length;
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------------
// 1. Due operations
// ---------------------------------------------------------------------

async function executeDueOperations(run: Run): Promise<void> {
  if (!run.canStart()) {
    return;
  }
  const due = await listDueOperations(run.db, {
    now: run.now,
    limit: run.remaining(),
    minQueuedAgeMs: QUEUED_MIN_AGE_MS,
  });
  for (const op of due) {
    if (!run.canStart()) {
      return;
    }
    run.used += 1;
    await run.item(op.worldId, `operation:${op.operationId}`, async () => {
      await executeOperation(run.db, op.operationId);
      run.world(op.worldId).counts.executed += 1;
      await followUp(run.db, op);
    });
  }
}

/** After (re-)executing an operation, pushes its domain effect along. */
async function followUp(db: Db, op: OperationRecord): Promise<void> {
  if (!op.sourceId) {
    return;
  }
  switch (op.kind) {
    case "payout.send":
      await dispatchPayoutOutcome(db, op.operationId);
      return;
    case "order.create":
      if (op.purpose === "repayment_link") {
        await refreshRepaymentLink(db, op.worldId, loanIdFromInvoiceSourceId(op.sourceId));
      } else if (op.purpose === "repayment_direct") {
        await refreshDirectRepayment(db, op.worldId, op.sourceId);
      }
      return;
    case "order.capture":
      // sourceId = the order id (the capture operation's id is derived from it).
      await settleCheckoutByOrderId(db, op.worldId, op.sourceId);
      return;
    default:
      // payout.cancel_item: the payout poll (step 2) sees the cancel's result.
      return;
  }
}

// ---------------------------------------------------------------------
// 2. Payout sources
// ---------------------------------------------------------------------

interface PayoutSource {
  kind: "loan_disbursement" | "note_redemption" | "remainder_payout";
  sourceId: string;
  sendOperationId: string;
}

async function pendingPayoutSources(db: Db, worldId: string): Promise<PayoutSource[]> {
  const sources: PayoutSource[] = [];
  const disbursing = await scoped(db, worldId).select(loans, eq(loans.status, "disbursing"));
  for (const loan of disbursing) {
    sources.push({
      kind: "loan_disbursement",
      sourceId: loan.id,
      sendOperationId: loan.disbursementOpId ?? deriveOperationId(worldId, "loan_disbursement", loan.id),
    });
  }
  const redemptions = await scoped(db, worldId).select(
    noteTransactions,
    and(eq(noteTransactions.kind, "redeem"), eq(noteTransactions.status, "pending"), isNotNull(noteTransactions.opId))!,
  );
  for (const tx of redemptions) {
    sources.push({ kind: "note_redemption", sourceId: tx.id, sendOperationId: tx.opId! });
  }
  const remainders = await scoped(db, worldId).select(
    repayments,
    and(eq(repayments.remainderStatus, "pending"), isNotNull(repayments.remainderPayoutOpId))!,
  );
  for (const repayment of remainders) {
    sources.push({ kind: "remainder_payout", sourceId: repayment.id, sendOperationId: repayment.remainderPayoutOpId! });
  }
  return sources;
}

async function pollPayouts(run: Run, worldId: string): Promise<void> {
  const counts = run.world(worldId).counts;
  for (const source of await pendingPayoutSources(run.db, worldId)) {
    if (!run.canStart()) {
      return;
    }
    await run.item(worldId, `${source.kind}:${source.sourceId}`, async () => {
      const result = await pollPayoutStatus(run.db, source.sendOperationId, { now: run.now });
      if (result.reason === "throttled") {
        counts.throttled += 1;
      } else if (result.reason === "polled" || result.reason === "send_not_succeeded") {
        run.used += 1;
        counts.payoutsPolled += 1;
      }
    });
  }
}

// ---------------------------------------------------------------------
// 3. Open checkouts
// ---------------------------------------------------------------------

async function openCheckoutOrderIds(db: Db, worldId: string): Promise<string[]> {
  const orderIds: string[] = [];
  const buys = await scoped(db, worldId).select(
    noteTransactions,
    and(eq(noteTransactions.kind, "buy"), eq(noteTransactions.status, "pending"), isNotNull(noteTransactions.opId))!,
  );
  for (const buy of buys) {
    const create = await getOperation(db, buy.opId!);
    if (create?.status === "succeeded" && create.kind === "order.create") {
      orderIds.push((create.body as OrderCreateResult).orderId);
    }
  }
  const links = await scoped(db, worldId).select(
    repaymentLinks,
    and(inArray(repaymentLinks.status, ["pending", "open"]), isNotNull(repaymentLinks.paypalOrderId))!,
  );
  for (const link of links) {
    orderIds.push(link.paypalOrderId!);
  }
  return orderIds;
}

async function pollCheckouts(run: Run, worldId: string): Promise<void> {
  const counts = run.world(worldId).counts;
  for (const orderId of await openCheckoutOrderIds(run.db, worldId)) {
    if (!run.canStart()) {
      return;
    }
    await run.item(worldId, `checkout:${orderId}`, async () => {
      const times = await orderPollTimes(run.db, worldId, orderId);
      if (!times) {
        return;
      }
      const due = isPollDue({
        createdAt: times.createdAt,
        lastReadAt: times.lastReadCreatedAt,
        now: run.now,
        minAgeMs: CHECKOUT_MIN_AGE_MS,
      });
      if (!due) {
        counts.throttled += 1;
        return;
      }
      run.used += 1;
      counts.checkoutsChecked += 1;
      const result = await settleCheckoutByOrderId(run.db, worldId, orderId);
      if (result.status === "COMPLETED") {
        counts.checkoutsSettled += 1;
      }
    });
  }
}

// ---------------------------------------------------------------------
// 4. Failed invoice links (the one auto-fix) and anomalies
// ---------------------------------------------------------------------

async function reissueFailedInvoiceLinks(run: Run, worldId: string): Promise<void> {
  const state = run.world(worldId);
  const failed = await scoped(run.db, worldId).select(
    repaymentLinks,
    and(eq(repaymentLinks.kind, "invoice"), eq(repaymentLinks.status, "failed"))!,
  );
  for (const link of failed) {
    const loan = await scoped(run.db, worldId).findOne(loans, eq(loans.id, link.loanId));
    if (loan?.status !== "active") {
      continue; // Nothing left to collect through it.
    }
    if (!run.canStart()) {
      state.anomalies.push(invoiceLinkAnomaly(worldId, link.id, link.loanId, "not_reissued_this_run"));
      continue;
    }
    run.used += 1;
    await run.item(worldId, `reissue_link:${link.id}`, async () => {
      const result = await reissueInvoiceLink(run.db, worldId, link.id);
      if (result.outcome === "reissued") {
        state.counts.linksReissued += 1;
      } else if (result.outcome === "exhausted") {
        state.anomalies.push(invoiceLinkAnomaly(worldId, link.id, link.loanId, `reissue_exhausted:${result.issues}`));
      }
    });
  }
}

function invoiceLinkAnomaly(worldId: string, linkId: string, loanId: string, reason: string): Anomaly {
  return { type: "invoice_link_failed", worldId, sourceId: linkId, detail: { loan_id: loanId, reason } };
}

async function listAnomalies(run: Run, worldId: string): Promise<void> {
  const db = run.db;
  const anomalies = run.world(worldId).anomalies;

  const reviewTxs = await scoped(db, worldId).select(noteTransactions, eq(noteTransactions.status, "review"));
  for (const tx of reviewTxs) {
    anomalies.push({
      type: "note_tx_review",
      worldId,
      sourceId: tx.id,
      detail: { kind: tx.kind, amount_cents: Number(tx.amountCents), reason: "captured_cash_unjournaled" },
    });
  }

  const reviewLinks = await scoped(db, worldId).select(repaymentLinks, eq(repaymentLinks.status, "review"));
  for (const link of reviewLinks) {
    anomalies.push({
      type: "repayment_link_review",
      worldId,
      sourceId: link.id,
      detail: {
        loan_id: link.loanId,
        order_id: link.paypalOrderId,
        amount_cents: Number(link.amountCents),
        reason: "captured_cash_unjournaled",
      },
    });
  }

  const unpaid = await scoped(db, worldId).select(repayments, inArray(repayments.remainderStatus, ["failed", "held"]));
  for (const repayment of unpaid) {
    anomalies.push({
      type: "remainder_unpaid",
      worldId,
      sourceId: repayment.id,
      detail: {
        loan_id: repayment.loanId,
        status: repayment.remainderStatus,
        remainder_cents: Number(repayment.remainderCents),
        reason: repayment.remainderFailureReason ?? (repayment.remainderStatus === "held" ? "payout_receiver_missing" : null),
      },
    });
  }

  for (const source of await pendingPayoutSources(db, worldId)) {
    const itemId = await unclaimedItemWithFailedCancel(db, worldId, source.sendOperationId);
    if (itemId) {
      anomalies.push({
        type: "unclaimed_cancel_failed",
        worldId,
        sourceId: source.sourceId,
        detail: { kind: source.kind, payout_item_id: itemId, reason: "liquidity_reserved_until_resolved" },
      });
    }
  }
}

/** The payout item id when the send's item is UNCLAIMED and its cancel failed terminally, else `null`. */
async function unclaimedItemWithFailedCancel(db: Db, worldId: string, sendOperationId: string): Promise<string | null> {
  const send = await getOperation(db, sendOperationId);
  if (!send || send.status !== "succeeded") {
    return null;
  }
  const latest = await latestPayoutGetForSend(db, sendOperationId);
  const item = latest?.items[0] ?? (send.body as PayoutSendResult).item ?? null;
  if (!item?.itemId || item.transactionStatus !== "UNCLAIMED") {
    return null;
  }
  const cancel = await getOperation(db, deriveOperationId(worldId, "payout_cancel", item.itemId));
  return cancel?.status === "failed_terminal" ? item.itemId : null;
}
