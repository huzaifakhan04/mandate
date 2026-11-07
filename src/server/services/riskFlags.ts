import { and, eq, gte, isNull, lt, or } from "drizzle-orm";

import { ownedAgent } from "../auth/ownership";
import { getSimNow } from "../clock/clock";
import type { Db } from "../db/client";
import { agents, events, riskFlags } from "../db/schema";
import { scoped } from "../db/scoped";
import { ownedPrivateWorld } from "./privateWorldAccess";

/**
 * P7 Risk Desk — risk flags (database only; no Elastic, no OpenAI, so the
 * borrowing gate can read them inside `apply_for_loan`'s transaction).
 *
 * - A detector hit (`elastic/detectors.ts`) becomes one `risk_flags` row
 *   per (agent, kind, window); while the agent already has an open flag of
 *   that kind, a new hit only refreshes its evidence.
 * - The effect is deterministic: an agent with an OPEN flag borrows as if
 *   at tier T0 — `apply_for_loan` declines with `risk_review` and
 *   `accept_offer` refuses (next action: get_status). Lending (notes) is
 *   unaffected.
 * - A flag stops counting 7 sim days after its latest evidence and the
 *   tick then clears it (`cleared_by = 'expired'`). An owner may add a
 *   "Request review" note; clearing is an admin action — or the owner's,
 *   in their own private world (they run it).
 */

export const RISK_KINDS = ["self_dealing", "score_farming", "sybil_burst", "probing", "velocity"] as const;
export type RiskKind = (typeof RISK_KINDS)[number];

export const RISK_FLAG_TTL_DAYS = 7;
const DAY_MS = 86_400_000;
const TTL_MS = RISK_FLAG_TTL_DAYS * DAY_MS;

export const RISK_KIND_LABEL: Record<RiskKind, string> = {
  self_dealing: "Self-dealing",
  score_farming: "Score farming",
  sybil_burst: "Sybil burst",
  probing: "Limit probing",
  velocity: "Redemption velocity",
};

export const RISK_KIND_TEXT: Record<RiskKind, string> = {
  self_dealing: "Invoice links were paid by the borrower's own human, or by one payer for several unrelated humans' agents.",
  score_farming: "Three or more borrow-and-repay cycles each shorter than one simulated day.",
  sybil_burst: "Four or more agents registered by the same human within ten minutes.",
  probing: "Three or more declined applications followed by a smaller application within one simulated day.",
  velocity: "Note redemption requests today are more than three times the agent's 7-day median.",
};

/** The fixed text of the `risk_review` decline. */
export const RISK_REVIEW_TEXT =
  "This agent is under risk review: borrowing is limited to tier T0 (no new loans) until the review clears. Lending is unaffected.";

export type RiskFlagRow = typeof riskFlags.$inferSelect;

/** The detection window of a sim time: its sim week. */
export function windowKeyFor(simAt: Date): string {
  return `w${Math.floor(simAt.getTime() / TTL_MS)}`;
}

export interface RiskHit {
  agentId: string;
  kind: RiskKind;
  evidence: Record<string, unknown>;
  /** The sim time of the newest evidence behind the hit. */
  evidenceSimAt: Date;
}

/**
 * Records a detector hit. Returns the new flag's id, or `null` when the
 * agent already had an open flag of this kind (its evidence is refreshed)
 * or a flag for this window already exists (e.g. one the admin cleared —
 * the same window never re-opens).
 */
export async function recordRiskHit(db: Db, worldId: string, hit: RiskHit, simNow: Date): Promise<string | null> {
  const world = scoped(db, worldId);
  const open = await world.findOne(
    riskFlags,
    and(eq(riskFlags.agentId, hit.agentId), eq(riskFlags.kind, hit.kind), eq(riskFlags.status, "open"))!,
  );
  if (open) {
    const newer = hit.evidenceSimAt.getTime() > open.lastEvidenceSimAt.getTime();
    await scoped(db, worldId).update(
      riskFlags,
      { evidence: hit.evidence, ...(newer ? { lastEvidenceSimAt: hit.evidenceSimAt } : {}) },
      eq(riskFlags.id, open.id),
    );
    return null;
  }
  const agent = await world.findOne(agents, eq(agents.id, hit.agentId));
  if (!agent) {
    return null;
  }
  // Evidence older than the TTL can't open a flag (it would expire at once).
  if (simNow.getTime() - hit.evidenceSimAt.getTime() >= TTL_MS) {
    return null;
  }
  const inserted = await world.insertOnConflictDoNothing(riskFlags, {
    agentId: hit.agentId,
    principalId: agent.principalId,
    kind: hit.kind,
    windowKey: windowKeyFor(hit.evidenceSimAt),
    status: "open",
    evidence: hit.evidence,
    firstSimAt: simNow,
    lastEvidenceSimAt: hit.evidenceSimAt,
  }, [riskFlags.worldId, riskFlags.agentId, riskFlags.kind, riskFlags.windowKey]);
  const row = inserted[0];
  if (!row) {
    return null;
  }
  await scoped(db, worldId).insert(events, {
    type: "agent.risk_flagged",
    aggregateType: "agent",
    aggregateId: hit.agentId,
    payload: { kind: hit.kind, flag_id: row.id },
    occurredSimAt: simNow,
  });
  return row.id;
}

/** The agent's flags that currently restrict borrowing (open, evidence within 7 sim days). */
export async function activeRiskFlags(db: Db, worldId: string, agentId: string, simNow: Date): Promise<RiskFlagRow[]> {
  return scoped(db, worldId).select(
    riskFlags,
    and(
      eq(riskFlags.agentId, agentId),
      eq(riskFlags.status, "open"),
      gte(riskFlags.lastEvidenceSimAt, new Date(simNow.getTime() - TTL_MS)),
    )!,
  );
}

export async function hasActiveRiskFlag(db: Db, worldId: string, agentId: string, simNow?: Date): Promise<boolean> {
  const at = simNow ?? (await getSimNow(db, worldId));
  return (await activeRiskFlags(db, worldId, agentId, at)).length > 0;
}

/** Clears open flags whose latest evidence is 7+ sim days old. Returns how many. */
export async function expireStaleRiskFlags(db: Db, worldId: string, simNow: Date, now: Date = new Date()): Promise<number> {
  const expired = await scoped(db, worldId).update(
    riskFlags,
    { status: "cleared", clearedAt: now, clearedBy: "expired" },
    and(eq(riskFlags.status, "open"), lt(riskFlags.lastEvidenceSimAt, new Date(simNow.getTime() - TTL_MS)))!,
  );
  return expired.length;
}

/** Every flag of an agent, newest first (the dashboard drawer). */
export async function agentRiskFlags(db: Db, worldId: string, agentId: string): Promise<RiskFlagRow[]> {
  const rows = await scoped(db, worldId).select(riskFlags, eq(riskFlags.agentId, agentId));
  return rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, 20);
}

/** Open flags not yet investigated (or whose investigation claim went stale), oldest first. */
export async function flagsAwaitingInvestigation(db: Db, worldId: string, now: Date, limit: number): Promise<RiskFlagRow[]> {
  const stale = new Date(now.getTime() - 10 * 60_000);
  const rows = await scoped(db, worldId).select(
    riskFlags,
    and(
      eq(riskFlags.status, "open"),
      isNull(riskFlags.caseFile),
      or(isNull(riskFlags.investigationClaimedAt), lt(riskFlags.investigationClaimedAt, stale)),
    )!,
  );
  return rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).slice(0, limit);
}

/** Claims a flag for investigation (conditional update; at most one investigator). */
export async function claimFlagForInvestigation(db: Db, worldId: string, flagId: string, now: Date): Promise<boolean> {
  const stale = new Date(now.getTime() - 10 * 60_000);
  const claimed = await scoped(db, worldId).update(
    riskFlags,
    { investigationClaimedAt: now },
    and(
      eq(riskFlags.id, flagId),
      isNull(riskFlags.caseFile),
      or(isNull(riskFlags.investigationClaimedAt), lt(riskFlags.investigationClaimedAt, stale)),
    )!,
  );
  return claimed.length === 1;
}

export async function storeCaseFile(
  db: Db,
  worldId: string,
  flagId: string,
  caseFile: Record<string, unknown>,
  aiRunId: string | null,
): Promise<void> {
  await scoped(db, worldId).update(riskFlags, { caseFile, aiRunId }, eq(riskFlags.id, flagId));
}

export const OWNER_NOTE_MAX = 500;

export type RiskReviewOutcome = "not_found" | "not_open" | "requested";

/** The owner's "Request review": a note on one of their agent's open flags. */
export async function requestRiskReview(
  db: Db,
  { principalId, agentId, flagId, note, now = new Date() }: { principalId: string; agentId: string; flagId: string; note: string; now?: Date },
): Promise<RiskReviewOutcome> {
  const agent = await ownedAgent(db, principalId, agentId);
  if (!agent) {
    return "not_found";
  }
  const world = scoped(db, agent.worldId);
  const flag = await world.findOne(riskFlags, and(eq(riskFlags.id, flagId), eq(riskFlags.agentId, agentId))!);
  if (!flag) {
    return "not_found";
  }
  if (flag.status !== "open") {
    return "not_open";
  }
  const text = note.replace(/\s+/g, " ").trim().slice(0, OWNER_NOTE_MAX) || "Review requested.";
  await scoped(db, agent.worldId).update(riskFlags, { ownerNote: text, reviewRequestedAt: now }, eq(riskFlags.id, flagId));
  return "requested";
}

export type ClearOutcome = "not_found" | "not_open" | "forbidden" | "cleared";

/**
 * Clears an open flag. `admin` may clear any flag (ops script); an owner
 * only in their own private world (they are its admin) — in the shared
 * main world an owner can only request a review.
 */
export async function clearRiskFlag(
  db: Db,
  args:
    | { by: "admin"; worldId: string; flagId: string; now?: Date }
    | { by: "owner"; principalId: string; agentId: string; flagId: string; now?: Date },
): Promise<ClearOutcome> {
  const now = args.now ?? new Date();
  let worldId: string;
  if (args.by === "owner") {
    const agent = await ownedAgent(db, args.principalId, args.agentId);
    if (!agent) {
      return "not_found";
    }
    if (!(await ownedPrivateWorld(db, args.principalId, agent.worldId))) {
      return "forbidden";
    }
    worldId = agent.worldId;
  } else {
    worldId = args.worldId;
  }
  const world = scoped(db, worldId);
  const flag = await world.findOne(
    riskFlags,
    args.by === "owner" ? and(eq(riskFlags.id, args.flagId), eq(riskFlags.agentId, args.agentId))! : eq(riskFlags.id, args.flagId),
  );
  if (!flag) {
    return "not_found";
  }
  const cleared = await scoped(db, worldId).update(
    riskFlags,
    { status: "cleared", clearedAt: now, clearedBy: args.by },
    and(eq(riskFlags.id, flag.id), eq(riskFlags.status, "open"))!,
  );
  return cleared.length === 1 ? "cleared" : "not_open";
}

/** Open flag counts by kind (the console's Risk panel). */
export async function openRiskCounts(db: Db, worldId: string): Promise<{ total: number; byKind: Record<RiskKind, number> }> {
  const rows = await scoped(db, worldId).selectFields(riskFlags, { kind: riskFlags.kind }, eq(riskFlags.status, "open"));
  const byKind = Object.fromEntries(RISK_KINDS.map((k) => [k, 0])) as Record<RiskKind, number>;
  for (const row of rows) {
    if ((RISK_KINDS as readonly string[]).includes(row.kind)) {
      byKind[row.kind as RiskKind] += 1;
    }
  }
  return { total: rows.length, byKind };
}
