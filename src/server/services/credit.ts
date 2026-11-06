import { and, eq, inArray } from "drizzle-orm";

import { activeAgentKey } from "../auth/agentKeys";
import type { Db } from "../db/client";
import { agents, creditScores, events, kyaDocuments, loans, scoreHistory } from "../db/schema";
import { scoped } from "../db/scoped";
import { isCurrentMandate } from "../domain/kya";
import { HISTORY_MIN_PRINCIPAL_CENTS, computeScore, type ScoreFacts, type ScoreResult } from "../domain/scorecard";
import { tierForAgent } from "./kya";
import { currentMandateRow, principalExposure } from "./mandates";

/**
 * The Agent Credit Score from DB facts (P3 Task 1). `computeScore`
 * (domain/scorecard.ts) is the pure rule; this file only gathers facts
 * and persists results.
 *
 * Two clocks, as in P2 (Ruling P2-D): the claim/mandate checks use REAL
 * time (`opts.now`, default now — mandate expiry is a human legal date);
 * tenure and repayment timing use the world's SIM time (`simNow`).
 */

const DAY_MS = 86_400_000;

export interface ScoreOptions {
  /** Invoice face ÷ principal in bps for the application being scored. Omitted → no collateral points. */
  invoiceCoverageBps?: number;
  /** Real time for the claim/mandate checks (default: now). */
  now?: Date;
}

/** Invoice coverage in bps: floor(invoice × 10000 ÷ principal). */
export function invoiceCoverageBps(invoiceCents: bigint, principalCents: bigint): number {
  if (principalCents <= 0n) {
    return 0;
  }
  return Number((invoiceCents * 10000n) / principalCents);
}

/**
 * Repayment history facts for one agent's loans.
 *
 * - on time: status `repaid`, principal ≥ 1000 cents (Review Focus 3), and
 *   its `loan.repaid` event's sim time ≤ `due_sim_at`.
 * - late: status `repaid` with the `loan.repaid` event after `due_sim_at`.
 * - charged off: `charged_off_at` set or status `charged_off`.
 *
 * Late is derived from the repayment's sim time, so it already applies to
 * P1 loans repaid after their due date. P4 (collections) adds the flows
 * that write `charged_off_at` / `charged_off`; until then no loan reaches
 * that state and the charge-off penalty stays 0.
 * Self-dealing (an agent paying its own invoice link) still counts as on
 * time — accepted for P3 (Review Focus 3).
 */
async function historyFacts(
  db: Db,
  worldId: string,
  agentId: string,
): Promise<Pick<ScoreFacts, "onTimeRepaidLoans" | "lateRepayments" | "everChargedOff">> {
  const rows = await scoped(db, worldId).select(loans, eq(loans.agentId, agentId));
  const repaid = rows.filter((loan) => loan.status === "repaid");
  const repaidAt = new Map<string, Date>();
  if (repaid.length > 0) {
    const repaidEvents = await scoped(db, worldId).selectFields(
      events,
      { aggregateId: events.aggregateId, occurredSimAt: events.occurredSimAt },
      and(
        eq(events.type, "loan.repaid"),
        inArray(
          events.aggregateId,
          repaid.map((loan) => loan.id),
        ),
      ),
    );
    for (const event of repaidEvents) {
      const seen = repaidAt.get(event.aggregateId);
      if (!seen || event.occurredSimAt < seen) {
        repaidAt.set(event.aggregateId, event.occurredSimAt);
      }
    }
  }

  let onTimeRepaidLoans = 0;
  let lateRepayments = 0;
  for (const loan of repaid) {
    const at = repaidAt.get(loan.id);
    if (!at) {
      continue;
    }
    if (at.getTime() > loan.dueSimAt.getTime()) {
      lateRepayments += 1;
    } else if (loan.principalCents >= HISTORY_MIN_PRINCIPAL_CENTS) {
      onTimeRepaidLoans += 1;
    }
  }
  const everChargedOff = rows.some((loan) => loan.chargedOffAt !== null || loan.status === "charged_off");
  return { onTimeRepaidLoans, lateRepayments, everChargedOff };
}

/** Gathers every `ScoreFacts` field for `agentId`. Throws if the agent isn't in `worldId`. */
export async function scoreFacts(
  db: Db,
  worldId: string,
  agentId: string,
  simNow: Date,
  opts: ScoreOptions = {},
): Promise<ScoreFacts> {
  const now = opts.now ?? new Date();
  const agent = await scoped(db, worldId).findOne(agents, eq(agents.id, agentId));
  if (!agent) {
    throw new Error(`Expected agent ${agentId} to exist in world ${worldId}`);
  }
  const tier = await tierForAgent(db, worldId, agent, now);
  const approved = agent.principalId
    ? await scoped(db, worldId).selectFields(
        kyaDocuments,
        { id: kyaDocuments.id },
        and(
          eq(kyaDocuments.agentId, agent.id),
          eq(kyaDocuments.principalId, agent.principalId),
          eq(kyaDocuments.reviewStatus, "approved"),
        ),
      )
    : [];
  const key = await activeAgentKey(db, worldId, agent.id);

  const row = await currentMandateRow(db, worldId, agent.id, agent.principalId);
  const mandate = row && isCurrentMandate(row, agent.principalId, now) ? row : null;
  const exposureCents = mandate ? await principalExposure(db, worldId, mandate.principalId) : 0n;

  const registeredAt = agent.registeredSimAt ?? agent.createdAt;
  const tenureDays = Math.max(Math.floor((simNow.getTime() - registeredAt.getTime()) / DAY_MS), 0);

  return {
    claimed: tier.claimed,
    hasSigningKey: Boolean(key),
    hasApprovedDocument: approved.length > 0,
    ...(await historyFacts(db, worldId, agent.id)),
    tenureDays,
    exposureCents,
    maxTotalOwedCents: mandate ? mandate.maxTotalOwedCents : null,
    ...testFactsOverrides.get(agent.id),
    invoiceCoverageBps: opts.invoiceCoverageBps ?? null,
  };
}

/**
 * TEST-ONLY: per-agent fact overrides (P3 Task 2). Lending suites that
 * test something other than underwriting (repayment, ledger, mandates…)
 * give their borrower an established credit file this way, so the grade
 * gate doesn't decline every application of a fresh test agent
 * (`tests/helpers/kya.ts`). In-memory, per process; refused in production.
 * The application's invoice coverage is never overridden.
 */
const testFactsOverrides = new Map<string, Partial<Omit<ScoreFacts, "invoiceCoverageBps">>>();

export function __setScoreFactsOverrideForTests(
  agentId: string,
  facts: Partial<Omit<ScoreFacts, "invoiceCoverageBps">> | null,
): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error("__setScoreFactsOverrideForTests is test-only");
  }
  if (facts) {
    testFactsOverrides.set(agentId, facts);
  } else {
    testFactsOverrides.delete(agentId);
  }
}

/**
 * The agent's score now (read-only: `get_status`, `check_eligibility` and
 * the dashboard compute it on demand; `recordScore` persists it on each
 * application).
 */
export async function scoreAgent(
  db: Db,
  worldId: string,
  agentId: string,
  simNow: Date,
  opts: ScoreOptions = {},
): Promise<ScoreResult> {
  return computeScore(await scoreFacts(db, worldId, agentId, simNow, opts));
}

export interface RecordScoreOptions {
  simNow: Date;
  /** The application this score decided (Task 4). */
  applicationId?: string;
  /** `score_history.reason_code` (default `application`). */
  reasonCode?: string;
}

/**
 * Persists `result` for `agentId`: upserts the one current
 * `credit_scores` row (score, grade, limit, components, factors) and
 * appends a `score_history` row with the delta from the previous score.
 * Call inside the application's transaction (Task 4 runs it under the
 * note series lock, so one agent's applications never race here; the
 * unique `credit_scores_subject_idx` is the backstop).
 */
export async function recordScore(
  tx: Db,
  worldId: string,
  agentId: string,
  result: ScoreResult,
  opts: RecordScoreOptions,
): Promise<void> {
  const subject = and(eq(creditScores.subjectType, "agent"), eq(creditScores.subjectId, agentId))!;
  const previous = await scoped(tx, worldId).findOne(creditScores, subject);
  const values = {
    score: result.score,
    grade: result.grade,
    limitCents: BigInt(result.limitCents),
    components: result.components,
    factors: result.factors,
    updatedSimAt: opts.simNow,
  };
  if (previous) {
    await scoped(tx, worldId).update(creditScores, values, eq(creditScores.id, previous.id));
  } else {
    await scoped(tx, worldId).insert(creditScores, { subjectType: "agent", subjectId: agentId, ...values });
  }
  await scoped(tx, worldId).insert(scoreHistory, {
    subjectType: "agent",
    subjectId: agentId,
    delta: result.score - (previous?.score ?? 0),
    reasonCode: opts.reasonCode ?? "application",
    score: result.score,
    grade: result.grade,
    components: result.components,
    applicationId: opts.applicationId ?? null,
    simAt: opts.simNow,
  });
}
