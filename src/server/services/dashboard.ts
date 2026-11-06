import { createHash } from "crypto";

import { and, desc, eq, inArray, isNull } from "drizzle-orm";

import { activeAgentKey } from "../auth/agentKeys";
import { ownedAgent, ownedAgents, type OwnedAgent } from "../auth/ownership";
import { getSimNow } from "../clock/clock";
import type { Db } from "../db/client";
import {
  apiKeys,
  applications,
  events,
  kyaDocuments,
  loans,
  mandates,
  noteSeries,
  notePositions,
  offers,
  repaymentLinks,
  worlds,
} from "../db/schema";
import { scoped } from "../db/scoped";
import { TIER_MAX_PER_LOAN_CENTS, isCurrentMandate, type TierResult } from "../domain/kya";
import { effectivePerLoanCap } from "../domain/mandate";
import { OPEN_LOAN_DB_STATUSES } from "../domain/loanMachine";
import { maskPayoutReceiver } from "./agents";
import type { ScoreResult } from "../domain/scorecard";
import { scoreAgent } from "./credit";
import { tierForAgent } from "./kya";
import { currentMandateRow, mandateLimits, principalExposure, type MandateRow } from "./mandates";

/**
 * The owner dashboard's read model (P2 Task 5). Everything is for ONE
 * principal: the agents they claimed (`ownedAgents` / `ownedAgent` —
 * another principal's agent is simply absent, Review Focus 3), and every
 * query after that is `scoped()` to the agent's own world. Money stays in
 * bigint cents; the page formats it.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** How the dashboard shows an agent's state (pill colour follows). */
export type AgentDisplayStatus = "active" | "pending" | "restricted" | "frozen" | "revoked";

export function displayStatus(agentStatus: string, tier: TierResult): AgentDisplayStatus {
  if (agentStatus === "frozen" || agentStatus === "revoked" || agentStatus === "restricted") {
    return agentStatus;
  }
  if (agentStatus === "active" && tier.hasCurrentMandate) {
    return "active";
  }
  return "pending";
}

export interface LoanSummary {
  id: string;
  status: string;
  principalCents: bigint;
  feeCents: bigint;
  lateFeesCents: bigint;
  outstandingCents: bigint;
  /** principal + fee + late fees. */
  totalDueCents: bigint;
  termDays: number | null;
  aprBps: number | null;
  /** Days since disbursement (sim time), clamped to [0, term]; `null` before disbursement. */
  dayOfTerm: number | null;
  dueSimAt: Date;
  disbursedSimAt: Date | null;
  collateral: "invoice_link" | "none";
  /** The open repayment checkout, if any (status + approve URL). */
  repaymentLink: { status: string; approveUrl: string | null } | null;
  createdAt: Date;
}

export interface AgentCardView {
  id: string;
  worldId: string;
  name: string;
  operator: string;
  model: string;
  status: string;
  display: AgentDisplayStatus;
  tier: TierResult;
  /** P3 Task 1: the Agent Credit Score now (no application → no collateral points). */
  credit: ScoreResult;
  mandate: { version: number; maxPerLoanCents: bigint; maxTotalOwedCents: bigint } | null;
  /** min(tier cap, mandate max per loan); 0 when the agent can't borrow. */
  perLoanCapCents: bigint;
  hasApprovedDocument: boolean;
  hasSigningKey: boolean;
  openLoan: LoanSummary | null;
}

export interface DashboardSummary {
  /** What the principal owes on their agents' open loans, summed over worlds. */
  owedCents: bigint;
  /**
   * The highest `max_total_owed` among the agents' current mandates. Each
   * one caps the principal's whole exposure (Ruling P2-C), so they don't
   * add up; `null` when no agent has a mandate.
   */
  mandateCeilingCents: bigint | null;
  /** Agents with status `active` and a current mandate (they may borrow). */
  activeAgents: number;
  totalAgents: number;
}

export interface OwnerDashboard {
  summary: DashboardSummary;
  agents: AgentCardView[];
}

function dayOfTerm(loan: { disbursedSimAt: Date | null }, termDays: number | null, simNow: Date): number | null {
  if (!loan.disbursedSimAt || termDays === null) {
    return null;
  }
  const elapsed = Math.floor((simNow.getTime() - loan.disbursedSimAt.getTime()) / DAY_MS);
  return Math.min(Math.max(elapsed, 0), termDays);
}

async function loanSummaries(db: Db, worldId: string, agentId: string, simNow: Date): Promise<LoanSummary[]> {
  const rows = await scoped(db, worldId).select(loans, eq(loans.agentId, agentId));
  if (rows.length === 0) {
    return [];
  }
  const offerRows = await scoped(db, worldId).select(
    offers,
    inArray(
      offers.id,
      rows.map((loan) => loan.offerId),
    ),
  );
  const offerById = new Map(offerRows.map((offer) => [offer.id, offer]));
  const appRows = offerRows.length
    ? await scoped(db, worldId).select(
        applications,
        inArray(
          applications.id,
          offerRows.map((offer) => offer.applicationId),
        ),
      )
    : [];
  const appById = new Map(appRows.map((app) => [app.id, app]));
  const links = await scoped(db, worldId).select(
    repaymentLinks,
    inArray(
      repaymentLinks.loanId,
      rows.map((loan) => loan.id),
    ),
  );

  return rows
    .map((loan) => {
      const offer = offerById.get(loan.offerId);
      const app = offer ? appById.get(offer.applicationId) : undefined;
      const link = links
        .filter((l) => l.loanId === loan.id && (l.status === "open" || l.status === "pending"))
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
      const termDays = offer?.termDays ?? null;
      return {
        id: loan.id,
        status: loan.status,
        principalCents: loan.principalCents,
        feeCents: loan.feeCents,
        lateFeesCents: loan.lateFeesCents,
        outstandingCents: loan.outstandingCents,
        totalDueCents: loan.principalCents + loan.feeCents + loan.lateFeesCents,
        termDays,
        aprBps: offer?.aprBps ?? null,
        dayOfTerm: dayOfTerm(loan, termDays, simNow),
        dueSimAt: loan.dueSimAt,
        disbursedSimAt: loan.disbursedSimAt,
        collateral: app?.invoiceRef ? ("invoice_link" as const) : ("none" as const),
        repaymentLink: link ? { status: link.status, approveUrl: link.approveUrl } : null,
        createdAt: loan.createdAt,
      };
    })
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

async function cardFor(db: Db, agent: OwnedAgent, now: Date): Promise<{ card: AgentCardView; mandate: MandateRow | null }> {
  const tier = await tierForAgent(db, agent.worldId, agent, now);
  const row = await currentMandateRow(db, agent.worldId, agent.id, agent.principalId);
  const mandate = row && isCurrentMandate(row, agent.principalId, now) ? row : null;
  const approved = await scoped(db, agent.worldId).selectFields(
    kyaDocuments,
    { id: kyaDocuments.id },
    and(eq(kyaDocuments.agentId, agent.id), eq(kyaDocuments.reviewStatus, "approved")),
  );
  const key = await activeAgentKey(db, agent.worldId, agent.id);
  const simNow = await getSimNow(db, agent.worldId, now);
  const credit = await scoreAgent(db, agent.worldId, agent.id, simNow, { now });
  const open = (await loanSummaries(db, agent.worldId, agent.id, simNow)).find((loan) =>
    (OPEN_LOAN_DB_STATUSES as readonly string[]).includes(loan.status),
  );
  return {
    mandate,
    card: {
      id: agent.id,
      worldId: agent.worldId,
      name: agent.name,
      operator: agent.operator,
      model: agent.model,
      status: agent.status,
      display: displayStatus(agent.status, tier),
      tier,
      credit,
      mandate: mandate
        ? { version: mandate.version, maxPerLoanCents: mandate.maxPerLoanCents, maxTotalOwedCents: mandate.maxTotalOwedCents }
        : null,
      perLoanCapCents: tier.borrowBlockers.length === 0 && mandate
        ? effectivePerLoanCap(TIER_MAX_PER_LOAN_CENTS[tier.tier], mandateLimits(mandate))
        : 0n,
      hasApprovedDocument: approved.length > 0,
      hasSigningKey: Boolean(key),
      openLoan: open ?? null,
    },
  };
}

/**
 * P2 Task 6 (Review Focus 5): the agents one dashboard view shows —
 * those in `worldId` when a private world is selected, otherwise those
 * in non-private worlds only (the main view never shows a private
 * world's agents).
 */
async function agentsInView(db: Db, principalId: string, worldId: string | undefined): Promise<OwnedAgent[]> {
  const owned = await ownedAgents(db, principalId);
  if (worldId) {
    return owned.filter((agent) => agent.worldId === worldId);
  }
  const worldIds = [...new Set(owned.map((agent) => agent.worldId))];
  if (worldIds.length === 0) {
    return [];
  }
  const privateIds = new Set(
    (
      await db
        .select({ id: worlds.id })
        .from(worlds)
        .where(and(inArray(worlds.id, worldIds), eq(worlds.kind, "private")))
    ).map((row) => row.id),
  );
  return owned.filter((agent) => !privateIds.has(agent.worldId));
}

/**
 * The principal's agents as cards, plus the summary strip — for one
 * private world (`options.worldId`) or, by default, the main view.
 */
export async function ownerDashboard(
  db: Db,
  principalId: string,
  now: Date = new Date(),
  options: { worldId?: string } = {},
): Promise<OwnerDashboard> {
  const owned = await agentsInView(db, principalId, options.worldId);
  const results = [];
  for (const agent of owned) {
    results.push(await cardFor(db, agent, now));
  }
  let owedCents = 0n;
  for (const worldId of new Set(owned.map((agent) => agent.worldId))) {
    owedCents += await principalExposure(db, worldId, principalId);
  }
  const ceilings = results.flatMap((r) => (r.mandate ? [r.mandate.maxTotalOwedCents] : []));
  return {
    summary: {
      owedCents,
      mandateCeilingCents: ceilings.length ? ceilings.reduce((a, b) => (b > a ? b : a)) : null,
      activeAgents: results.filter((r) => r.card.display === "active").length,
      totalAgents: results.length,
    },
    agents: results.map((r) => r.card),
  };
}

// ---------------------------------------------------------------------
// The drawer
// ---------------------------------------------------------------------

export interface NotePositionView {
  id: string;
  seriesName: string;
  units: bigint;
  costCents: bigint;
  accruedCents: bigint;
  status: string;
}

export interface AgentEventView {
  id: string;
  type: string;
  occurredSimAt: Date;
  payload: Record<string, unknown> | null;
}

export interface SigningKeyView {
  /** The first 16 hex chars of sha256(raw 32-byte key) — the same `fingerprint` `register_public_key` returns. */
  fingerprint: string;
  createdAt: Date;
}

export interface AgentDetailView extends AgentCardView {
  codeManifestHash: string;
  payoutMasked: string | null;
  claimedAt: Date | null;
  createdAt: Date;
  currentMandate: MandateRow | null;
  mandateHistory: MandateRow[];
  documents: Array<{
    id: string;
    kind: string;
    fileName: string | null;
    contentType: string | null;
    sizeBytes: number | null;
    reviewStatus: string;
    /** P3 Task 4: the KYA desk's advisory verdict and findings (`null` until it has run). */
    aiVerdict: string | null;
    aiFindings: unknown;
    createdAt: Date;
  }>;
  /** P3 Task 4: the latest declined applications with their adverse-action notice (newest first). */
  declines: DeclineView[];
  signingKey: SigningKeyView | null;
  apiKey: { prefix: string; createdAt: Date; lastUsedAt: Date | null } | null;
  loans: LoanSummary[];
  notes: NotePositionView[];
  events: AgentEventView[];
  simNow: Date;
}

export const DRAWER_EVENT_LIMIT = 40;
export const DRAWER_DECLINE_LIMIT = 3;

export interface DeclineView {
  id: string;
  amountCents: bigint;
  termDays: number;
  createdAt: Date;
  reasons: Array<{ code: string; text: string }>;
  score: number | null;
  grade: string | null;
  /** The explanation's summary (loan officer or template); `null` if none was stored. */
  explanation: string | null;
}

function declineView(row: {
  id: string;
  amountCents: bigint;
  termDays: number;
  createdAt: Date;
  adverseAction: unknown;
}): DeclineView {
  const adverse = (row.adverseAction ?? {}) as {
    reasons?: Array<{ code: string; text: string }>;
    score?: number;
    grade?: string;
    explanation?: { summary?: string };
  };
  return {
    id: row.id,
    amountCents: row.amountCents,
    termDays: row.termDays,
    createdAt: row.createdAt,
    reasons: Array.isArray(adverse.reasons) ? adverse.reasons : [],
    score: typeof adverse.score === "number" ? adverse.score : null,
    grade: typeof adverse.grade === "string" ? adverse.grade : null,
    explanation: typeof adverse.explanation?.summary === "string" ? adverse.explanation.summary : null,
  };
}

/** The fingerprint of a raw base64 Ed25519 public key, as `register_public_key` reports it. */
export function keyFingerprint(publicKeyB64: string): string {
  return createHash("sha256").update(Buffer.from(publicKeyB64, "base64")).digest("hex").slice(0, 16);
}

/** Everything the drawer shows for one of the principal's agents; `null` if it isn't theirs. */
export async function agentDetail(
  db: Db,
  principalId: string,
  agentId: string,
  now: Date = new Date(),
): Promise<AgentDetailView | null> {
  const agent = await ownedAgent(db, principalId, agentId);
  if (!agent) {
    return null;
  }
  const world = scoped(db, agent.worldId);
  const { card, mandate } = await cardFor(db, agent, now);
  const simNow = await getSimNow(db, agent.worldId, now);

  const history = (await world.select(mandates, eq(mandates.agentId, agent.id))).sort((a, b) => b.version - a.version);

  const documents = await world.selectFields(
    kyaDocuments,
    {
      id: kyaDocuments.id,
      kind: kyaDocuments.kind,
      fileName: kyaDocuments.fileName,
      contentType: kyaDocuments.contentType,
      sizeBytes: kyaDocuments.sizeBytes,
      reviewStatus: kyaDocuments.reviewStatus,
      aiVerdict: kyaDocuments.aiVerdict,
      aiFindings: kyaDocuments.aiFindings,
      createdAt: kyaDocuments.createdAt,
    },
    and(eq(kyaDocuments.agentId, agent.id), eq(kyaDocuments.principalId, principalId)),
    desc(kyaDocuments.createdAt),
  );

  const declineRows = await world.selectFields(
    applications,
    {
      id: applications.id,
      amountCents: applications.amountCents,
      termDays: applications.termDays,
      createdAt: applications.createdAt,
      adverseAction: applications.adverseAction,
    },
    and(eq(applications.agentId, agent.id), eq(applications.decision, "declined"))!,
    desc(applications.createdAt),
    DRAWER_DECLINE_LIMIT,
  );

  const key = await activeAgentKey(db, agent.worldId, agent.id);
  const apiKey = await world.findLatest(
    apiKeys,
    and(eq(apiKeys.agentId, agent.id), isNull(apiKeys.revokedAt))!,
    apiKeys.createdAt,
  );

  const loanRows = await loanSummaries(db, agent.worldId, agent.id, simNow);

  const positions = await world.select(notePositions, eq(notePositions.agentId, agent.id));
  const series = positions.length
    ? await world.select(
        noteSeries,
        inArray(
          noteSeries.id,
          positions.map((p) => p.seriesId),
        ),
      )
    : [];
  const seriesName = new Map(series.map((s) => [s.id, s.name]));

  // The agent's own events, its mandates', and its loans' (with their offers and applications).
  const offerIds = loanRows.length
    ? (
        await world.selectFields(
          loans,
          { offerId: loans.offerId },
          inArray(
            loans.id,
            loanRows.map((l) => l.id),
          ),
        )
      ).map((row) => row.offerId)
    : [];
  const appIds = (await world.selectFields(applications, { id: applications.id }, eq(applications.agentId, agent.id))).map(
    (row) => row.id,
  );
  const aggregateIds = [
    agent.id,
    ...history.map((m) => m.id),
    ...loanRows.map((l) => l.id),
    ...offerIds,
    ...appIds,
  ];
  const eventRows = await world.selectFields(
    events,
    { id: events.id, type: events.type, occurredSimAt: events.occurredSimAt, payload: events.payload, seq: events.seq },
    inArray(events.aggregateId, aggregateIds),
    desc(events.seq),
  );

  return {
    ...card,
    codeManifestHash: agent.codeManifestHash,
    payoutMasked: agent.payoutReceiver ? maskPayoutReceiver(agent.payoutReceiver, agent.payoutReceiverType) : null,
    claimedAt: agent.claimedAt,
    createdAt: agent.createdAt,
    currentMandate: mandate,
    mandateHistory: history,
    documents,
    declines: declineRows.map(declineView),
    signingKey: key ? { fingerprint: keyFingerprint(key.publicKey), createdAt: key.createdAt } : null,
    apiKey: apiKey ? { prefix: apiKey.prefix, createdAt: apiKey.createdAt, lastUsedAt: apiKey.lastUsedAt } : null,
    loans: loanRows,
    notes: positions.map((p) => ({
      id: p.id,
      seriesName: seriesName.get(p.seriesId) ?? "Notes",
      units: p.units,
      costCents: p.costCents,
      accruedCents: p.accruedCents,
      status: p.status,
    })),
    events: eventRows.slice(0, DRAWER_EVENT_LIMIT).map((row) => ({
      id: row.id,
      type: row.type,
      occurredSimAt: row.occurredSimAt,
      payload: (row.payload as Record<string, unknown> | null) ?? null,
    })),
    simNow,
  };
}
