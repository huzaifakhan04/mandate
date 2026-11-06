/**
 * The P1 loan lifecycle as a pure state machine. Every status change the
 * lending services make (application, offer, loan rows) goes through
 * `transition`, so an illegal edge throws instead of silently writing a
 * nonsensical status.
 *
 *   SUBMITTED  --OFFER-->            OFFERED
 *   SUBMITTED  --DECLINE-->          DECLINED              (bank declined the application)
 *   OFFERED    --ACCEPT-->           ACCEPTED
 *   OFFERED    --DECLINE_OFFER-->    DECLINED_BY_AGENT
 *   OFFERED    --EXPIRE-->           EXPIRED               (time, or superseded by a newer application)
 *   ACCEPTED   --DISBURSE-->         DISBURSING
 *   DISBURSING --PAYOUT_SUCCEEDED--> ACTIVE
 *   DISBURSING --PAYOUT_FAILED-->    DISBURSEMENT_FAILED
 *   ACTIVE     --REPAY-->            REPAID
 *   ACTIVE     --MARK_LATE-->        LATE                  (P4: due + 1 sim day, still owing)
 *   LATE       --MARK_SUBSTANDARD--> SUBSTANDARD           (P4: due + 7 sim days)
 *   LATE       --REPAY-->            REPAID                (P4: cure — everything owed paid)
 *   SUBSTANDARD --REPAY-->           REPAID                (P4: cure)
 *   SUBSTANDARD --CHARGE_OFF-->      CHARGED_OFF           (P4 Task 2: due + 10 sim days)
 *   CHARGED_OFF --RECOVER-->         RECOVERED             (P4 Task 2: everything written off recovered)
 *
 * States are uppercase (the API vocabulary); rows store them lowercase
 * (Ruling E) — use `toDbStatus`/`fromDbStatus` at the boundary.
 */

export const LOAN_STATES = [
  "SUBMITTED",
  "DECLINED",
  "OFFERED",
  "ACCEPTED",
  "DECLINED_BY_AGENT",
  "EXPIRED",
  "DISBURSING",
  "ACTIVE",
  "DISBURSEMENT_FAILED",
  "REPAID",
  "LATE",
  "SUBSTANDARD",
  "CHARGED_OFF",
  "RECOVERED",
] as const;

export type LoanState = (typeof LOAN_STATES)[number];

export type LoanEvent =
  | "OFFER"
  | "DECLINE"
  | "ACCEPT"
  | "DECLINE_OFFER"
  | "EXPIRE"
  | "DISBURSE"
  | "PAYOUT_SUCCEEDED"
  | "PAYOUT_FAILED"
  | "REPAY"
  | "MARK_LATE"
  | "MARK_SUBSTANDARD"
  | "CHARGE_OFF"
  | "RECOVER";

const EDGES: Partial<Record<LoanState, Partial<Record<LoanEvent, LoanState>>>> = {
  SUBMITTED: { OFFER: "OFFERED", DECLINE: "DECLINED" },
  OFFERED: { ACCEPT: "ACCEPTED", DECLINE_OFFER: "DECLINED_BY_AGENT", EXPIRE: "EXPIRED" },
  ACCEPTED: { DISBURSE: "DISBURSING" },
  DISBURSING: { PAYOUT_SUCCEEDED: "ACTIVE", PAYOUT_FAILED: "DISBURSEMENT_FAILED" },
  ACTIVE: { REPAY: "REPAID", MARK_LATE: "LATE" },
  LATE: { REPAY: "REPAID", MARK_SUBSTANDARD: "SUBSTANDARD" },
  SUBSTANDARD: { REPAY: "REPAID", CHARGE_OFF: "CHARGED_OFF" },
  CHARGED_OFF: { RECOVER: "RECOVERED" },
};

export class InvalidTransitionError extends Error {
  constructor(
    readonly state: LoanState,
    readonly event: LoanEvent,
  ) {
    super(`Invalid loan transition: ${state} --${event}-->`);
    this.name = "InvalidTransitionError";
  }
}

export function canTransition(state: LoanState, event: LoanEvent): boolean {
  return EDGES[state]?.[event] !== undefined;
}

/** The state `event` moves `state` to; throws `InvalidTransitionError` for an illegal edge. */
export function transition(state: LoanState, event: LoanEvent): LoanState {
  const next = EDGES[state]?.[event];
  if (!next) {
    throw new InvalidTransitionError(state, event);
  }
  return next;
}

/** `ACTIVE` → `active` (Ruling E: rows store lowercase). */
export function toDbStatus(state: LoanState): string {
  return state.toLowerCase();
}

/** `active` → `ACTIVE`; throws for a value outside the machine's vocabulary. */
export function fromDbStatus(status: string): LoanState {
  const upper = status.toUpperCase();
  if (!(LOAN_STATES as readonly string[]).includes(upper)) {
    throw new Error(`Unknown loan status: ${status}`);
  }
  return upper as LoanState;
}

/**
 * Loan statuses that count as the agent's one open loan (P1: one per
 * agent). P4: a late or substandard loan is still open. Keep in sync with
 * `loans_one_open_per_agent_idx` (schema.ts).
 */
export const OPEN_LOAN_DB_STATUSES = ["accepted", "disbursing", "active", "late", "substandard"] as const;

/** P4: funded loans that still owe (ACTIVE, or down the delinquency ladder before charge-off). */
export const OWING_LOAN_DB_STATUSES = ["active", "late", "substandard"] as const;

export function isOwingStatus(status: string): boolean {
  return (OWING_LOAN_DB_STATUSES as readonly string[]).includes(status);
}

/**
 * P4 Task 2: loans that keep their agent restricted and their principal's
 * mandate frozen — substandard, or charged off and not yet fully
 * recovered. A cure (→ REPAID) or a full recovery (→ RECOVERED) lifts it.
 */
export const DELINQUENT_LOAN_DB_STATUSES = ["substandard", "charged_off"] as const;
