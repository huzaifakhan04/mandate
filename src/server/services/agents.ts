import { randomUUID } from "crypto";

import { and, eq, inArray } from "drizzle-orm";

import type { GeneratedApiKey } from "../auth/apiKeys";
import { generateApiKey } from "../auth/apiKeys";
import { getSimNow } from "../clock/clock";
import type { Db } from "../db/client";
import { agents, apiKeys, loans, repaymentLinks } from "../db/schema";
import { scoped } from "../db/scoped";
import { totalDueCents } from "./collections";
import { getAccountBalance } from "../ledger/trialBalance";
import { availableLiquidity } from "../domain/liquidity";
import { OPEN_LOAN_DB_STATUSES } from "../domain/loanMachine";
import type { TierResult } from "../domain/kya";
import { claimLinkForAgent, issueClaimToken, claimUrlForToken, type ClaimLink } from "./claims";
import { tierForAgent } from "./kya";

/** The plan's fixed P1 loan cap — see `limits.max_principal_cents`. */
export const MAX_PRINCIPAL_CENTS = 50000;

export interface RegisterAgentInput {
  name: string;
  operator?: string;
  model?: string;
  /**
   * The payout receiver: exactly one of an email or a PayPal payer ID.
   * Task 10: a payer ID is what real PayPal sandbox needs for accounts
   * whose email is unconfirmed — a payout to that email goes UNCLAIMED
   * (`RECEIVER_UNCONFIRMED`), while one to the same account's payer ID
   * succeeds.
   */
  payoutEmail?: string;
  payoutPaypalId?: string;
}

export interface RegisterAgentResult {
  agentId: string;
  apiKey: string;
  /**
   * Always `"active"`: every self-registered agent is active at KYA tier 0
   * (it may lend; borrowing needs a claim + a signed mandate). The P1
   * `ALLOW_INSTANT_ACTIVATION` switch no longer decides anything and is
   * ignored (P2 Global Constraints, "Agent lifecycle").
   */
  status: "active";
  /** `${PUBLIC_BASE_URL}/claim/<token>` — for the agent's human. */
  claimUrl: string;
  claimExpiresAt: Date;
}

/**
 * Creates a brand-new agent, its API key and its claim token. No dedupe
 * by `name`/`payoutEmail` — the plan explicitly has `register_agent`
 * create a fresh agent (and a fresh key) on every call, even if an
 * identical one already exists (Ruling D: `auth: 'none'` mutating tools
 * skip idempotency entirely, since there's no agent yet to attribute an
 * `idempotency_keys` row to).
 *
 * Must be called with a transactional `tx` (the per-call transaction
 * `runTool` opens for every mutating tool) so the agent row and its API
 * key are committed together.
 */
export async function registerAgent(
  tx: Db,
  worldId: string,
  input: RegisterAgentInput,
  now: Date = new Date(),
): Promise<RegisterAgentResult> {
  if (!input.payoutEmail === !input.payoutPaypalId) {
    // Defensive only: the register_agent input schema enforces this.
    throw new Error("registerAgent needs exactly one of payoutEmail / payoutPaypalId");
  }

  // The id is chosen up front: the claim token is derived from it.
  const agentId = randomUUID();
  const claim = issueClaimToken(agentId, now);

  const [agent] = await scoped(tx, worldId).insert(agents, {
    id: agentId,
    name: input.name,
    operator: input.operator ?? "unknown",
    model: input.model ?? "unknown",
    // No code-manifest verification exists yet (P2); this is a
    // placeholder so the NOT NULL column is satisfiable in P1.
    codeManifestHash: "unverified",
    status: "active",
    payoutReceiver: input.payoutEmail ?? input.payoutPaypalId,
    payoutReceiverType: input.payoutEmail ? "email" : "paypal_id",
    ...claim.columns,
    // P3 Task 1: score tenure counts sim days from here.
    registeredSimAt: await getSimNow(tx, worldId, now),
  });
  if (!agent) {
    throw new Error("Expected an agent row to be inserted");
  }

  const generated: GeneratedApiKey = generateApiKey();
  await scoped(tx, worldId).insert(apiKeys, {
    agentId: agent.id,
    prefix: generated.prefix,
    keyHash: generated.hash,
  });

  return {
    agentId: agent.id,
    apiKey: generated.key,
    status: "active",
    claimUrl: claimUrlForToken(claim.token),
    claimExpiresAt: claim.columns.claimExpiresAt,
  };
}

/**
 * `get_status`'s masked payout receiver: an email as `maskPayoutEmail`; a
 * PayPal payer ID as `PAYPAL_ID:` + its first two characters + `***`.
 */
export function maskPayoutReceiver(receiver: string, receiverType: string | null): string {
  return receiverType === "paypal_id" ? `PAYPAL_ID:${receiver.slice(0, 2)}***` : maskPayoutEmail(receiver);
}

/** First character + `***@` + the domain, e.g. `"m***@example.com"`. */
export function maskPayoutEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) {
    // Defensive only: payout_email is validated as an email by the
    // register_agent input schema, so this should be unreachable.
    return email;
  }
  return `${email[0]}***@${email.slice(at + 1)}`;
}

export interface OpenLoanStatus {
  loanId: string;
  status: string;
  outstandingCents: bigint;
  dueSimAt: Date;
  /** P4: late fees and rate penalty still owed, and everything owed in total. */
  lateFeeOutstandingCents: bigint;
  penaltyOutstandingCents: bigint;
  totalDueCents: bigint;
  /**
   * P4 fix round (M6): a CHARGED_OFF loan is shown too — `totalDueCents` is
   * then what is still recoverable — with the owner's guarantee link.
   */
  guaranteeLink: { url: string | null; amountCents: bigint; status: string } | null;
}

export interface AgentStatus {
  agent: {
    id: string;
    name: string;
    /** Lowercase, as stored — see Ruling E; uppercased at the envelope boundary. */
    status: string;
    payoutEmailMasked: string | null;
  };
  balances: {
    notesCents: bigint;
    payableToYouCents: bigint;
  };
  openLoan: OpenLoanStatus | null;
  limits: {
    maxPrincipalCents: number;
    availableLiquidityCents: bigint;
  };
  kya: {
    tier: TierResult;
    /** The claim link while unclaimed (an expired token is rotated first), else `null`. */
    claimLink: ClaimLink | null;
  };
}

/**
 * Builds `get_status`'s data for one agent. Never creates a ledger
 * account (a brand-new agent that has never touched a note or loan
 * simply has zero balances). Its only write: an unclaimed agent whose
 * claim token has expired gets a fresh one, so the link it shows works.
 */
export async function getAgentStatus(
  db: Db,
  worldId: string,
  agentId: string,
): Promise<AgentStatus> {
  const [agentRow] = await scoped(db, worldId).select(
    agents,
    eq(agents.id, agentId),
  );
  if (!agentRow) {
    throw new Error(`Expected agent ${agentId} to exist in world ${worldId}`);
  }

  const notesPayableCents = await getAccountBalance(
    db,
    worldId,
    "notes_payable",
    agentId,
  );
  const payableToBorrowerCents = await getAccountBalance(
    db,
    worldId,
    "payable_to_borrower",
    agentId,
  );

  const openLoanRows = await scoped(db, worldId).select(
    loans,
    and(eq(loans.agentId, agentId), inArray(loans.status, [...OPEN_LOAN_DB_STATUSES, "charged_off"])),
  );
  // P1 enforces "one open loan per agent" (plan, Fixed P1 pricing), so
  // at most one row is expected; take the most recent defensively.
  const openLoanRow = openLoanRows.sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
  )[0];

  const availableLiquidityCents = await availableLiquidity(db, worldId);
  const tier = await tierForAgent(db, worldId, agentRow);
  const claimLink = tier.claimed ? null : await claimLinkForAgent(db, worldId, agentRow);

  return {
    agent: {
      id: agentRow.id,
      name: agentRow.name,
      status: agentRow.status,
      payoutEmailMasked: agentRow.payoutReceiver
        ? maskPayoutReceiver(agentRow.payoutReceiver, agentRow.payoutReceiverType)
        : null,
    },
    balances: {
      // Credit balances are stored negative (liability account); shown
      // to the agent as a positive amount owed to them.
      notesCents: -notesPayableCents,
      payableToYouCents: -payableToBorrowerCents,
    },
    openLoan: openLoanRow
      ? {
          loanId: openLoanRow.id,
          status: openLoanRow.status,
          outstandingCents: openLoanRow.outstandingCents,
          dueSimAt: openLoanRow.dueSimAt,
          lateFeeOutstandingCents: openLoanRow.lateFeeOutstandingCents,
          penaltyOutstandingCents: openLoanRow.penaltyOutstandingCents,
          totalDueCents: totalDueCents(openLoanRow),
          guaranteeLink: await guaranteeLinkFor(db, worldId, openLoanRow),
        }
      : null,
    limits: {
      maxPrincipalCents: MAX_PRINCIPAL_CENTS,
      availableLiquidityCents,
    },
    kya: { tier, claimLink },
  };
}

async function guaranteeLinkFor(
  db: Db,
  worldId: string,
  loan: typeof loans.$inferSelect,
): Promise<OpenLoanStatus["guaranteeLink"]> {
  if (loan.status !== "charged_off") {
    return null;
  }
  const link = await scoped(db, worldId).findOne(
    repaymentLinks,
    and(eq(repaymentLinks.loanId, loan.id), eq(repaymentLinks.kind, "guarantee"))!,
  );
  return link ? { url: link.approveUrl, amountCents: link.amountCents, status: link.status } : null;
}
