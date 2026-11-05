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
  | "REPAY";

const EDGES: Partial<Record<LoanState, Partial<Record<LoanEvent, LoanState>>>> = {
  SUBMITTED: { OFFER: "OFFERED", DECLINE: "DECLINED" },
  OFFERED: { ACCEPT: "ACCEPTED", DECLINE_OFFER: "DECLINED_BY_AGENT", EXPIRE: "EXPIRED" },
  ACCEPTED: { DISBURSE: "DISBURSING" },
  DISBURSING: { PAYOUT_SUCCEEDED: "ACTIVE", PAYOUT_FAILED: "DISBURSEMENT_FAILED" },
  ACTIVE: { REPAY: "REPAID" },
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

/** Loan statuses that count as the agent's one open loan (P1: one per agent). */
export const OPEN_LOAN_DB_STATUSES = ["accepted", "disbursing", "active"] as const;
