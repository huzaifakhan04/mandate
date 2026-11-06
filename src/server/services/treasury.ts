import { and, eq, gte, inArray, lt } from "drizzle-orm";

import { getSimDay } from "../clock/clock";
import type { Db } from "../db/client";
import { agents, economyState, events, loans, noteTransactions, treasuryPolicy } from "../db/schema";
import { scoped } from "../db/scoped";
import { availableLiquidity } from "../domain/liquidity";
import { isOwingStatus, OPEN_LOAN_DB_STATUSES } from "../domain/loanMachine";
import { TREASURY_DEFAULTS, type LoanTreasuryFacts, type TreasuryPolicy } from "../domain/treasury";
import { getCodeBalance } from "../ledger/trialBalance";
import { outstandingParts } from "./collections";

/**
 * P5 Task 3: the treasury policy's facts from the ledger and the loan
 * book (the decisions are pure: `domain/treasury.ts`). Callers that act
 * on them (`apply_for_loan`, `accept_offer`, `redeem_notes`, the tick's
 * redemption queue) hold the note series lock, so the facts are a
 * consistent snapshot and two of them can't jointly breach a gate.
 */

const DAY_MS = 86_400_000;

/**
 * `TREASURY_POLICY_DISABLED=1` turns the gates off for worlds WITHOUT a
 * policy row — set only by the vitest configs, so the pre-P5 suites keep
 * testing what they test (their small pools would otherwise trip the
 * concentration limit). Production never sets it; a world with a row
 * always has its policy enforced.
 */
export function treasuryDefaultsDisabled(): boolean {
  return process.env.TREASURY_POLICY_DISABLED === "1";
}

/**
 * The world's policy row, else `TREASURY_DEFAULTS` — or `null` (no gates)
 * when there is no row and `treasuryDefaultsDisabled()`.
 */
export async function getTreasuryPolicy(db: Db, worldId: string): Promise<TreasuryPolicy | null> {
  const row = await scoped(db, worldId).findOne(treasuryPolicy, eq(treasuryPolicy.worldId, worldId));
  if (!row) {
    return treasuryDefaultsDisabled() ? null : { ...TREASURY_DEFAULTS };
  }
  return {
    reserveFloorBps: row.reserveFloorBps,
    concentrationBps: row.concentrationBps,
    dailyBudgetBps: row.dailyBudgetBps,
  };
}

/** Creates or replaces the world's policy (tests, and the P6 console later). */
export async function setTreasuryPolicy(db: Db, worldId: string, policy: Partial<TreasuryPolicy>): Promise<TreasuryPolicy> {
  const next = { ...((await getTreasuryPolicy(db, worldId)) ?? TREASURY_DEFAULTS), ...policy };
  for (const [key, value] of Object.entries(next)) {
    if (!Number.isInteger(value) || value < 0 || value > 10000) {
      throw new Error(`treasury policy ${key} must be an integer 0..10000 bps, got ${value}`);
    }
  }
  const updated = await scoped(db, worldId).update(
    treasuryPolicy,
    { ...next, updatedAt: new Date() },
    eq(treasuryPolicy.worldId, worldId),
  );
  if (updated.length === 0) {
    await scoped(db, worldId).insertOnConflictDoNothing(treasuryPolicy, next, [treasuryPolicy.worldId]);
  }
  return next;
}

export interface RedemptionTotals {
  /** Σ `pending` redemptions (payout enqueued or in flight; already out of available liquidity). */
  pendingCents: bigint;
  /** Σ `queued` redemptions (gated by the reserve floor; no payout yet). */
  queuedCents: bigint;
  queuedCount: number;
}

export async function redemptionTotals(db: Db, worldId: string): Promise<RedemptionTotals> {
  const rows = await scoped(db, worldId).select(
    noteTransactions,
    and(eq(noteTransactions.kind, "redeem"), inArray(noteTransactions.status, ["pending", "queued"]))!,
  );
  let pendingCents = 0n;
  let queuedCents = 0n;
  let queuedCount = 0;
  for (const row of rows) {
    if (row.status === "pending") {
      pendingCents += row.amountCents;
    } else {
      queuedCents += row.amountCents;
      queuedCount += 1;
    }
  }
  return { pendingCents, queuedCents, queuedCount };
}

/** notes_payable (what the bank owes holders, a credit balance) as a positive number. */
export async function notesPayableCents(db: Db, worldId: string): Promise<bigint> {
  return -(await getCodeBalance(db, worldId, "notes_payable"));
}

/**
 * The principal's outstanding principal across all its agents' open loans
 * (DISBURSING counts its full principal). An agent without a principal
 * counts its own loans only.
 */
export async function principalExposureCents(
  db: Db,
  worldId: string,
  agent: { id: string; principalId: string | null },
): Promise<bigint> {
  const agentIds = agent.principalId
    ? (await scoped(db, worldId).selectFields(agents, { id: agents.id }, eq(agents.principalId, agent.principalId))).map(
        (row) => row.id,
      )
    : [agent.id];
  if (agentIds.length === 0) {
    return 0n;
  }
  const open = await scoped(db, worldId).select(
    loans,
    and(inArray(loans.agentId, agentIds), inArray(loans.status, [...OPEN_LOAN_DB_STATUSES]))!,
  );
  return open.reduce(
    (sum, loan) => sum + (isOwingStatus(loan.status) ? outstandingParts(loan).principalCents : loan.principalCents),
    0n,
  );
}

export interface LendingBudget {
  simDay: number;
  /** The day's starting available liquidity (`economy_state`), `null` before the world's first economy day. */
  dayStartLiquidityCents: bigint | null;
  /** Principal of loans accepted this sim day (a failed disbursement gives its share back). */
  usedCents: bigint;
}

/**
 * Today's lending budget base and use. The base is today's
 * `economy_state.day_start_liquidity_cents`; if the tick hasn't stepped
 * today yet, the latest earlier day's (the budget never lapses just because
 * a step is late); with no economy row at all, `null` (no budget gate).
 */
export async function lendingBudget(db: Db, worldId: string): Promise<LendingBudget> {
  const { anchorSim, day } = await getSimDay(db, worldId);
  const latest = await scoped(db, worldId).findLatest(
    economyState,
    lt(economyState.simDay, day + 1),
    economyState.simDay,
  );
  const dayStart = new Date(anchorSim.getTime() + day * DAY_MS);
  const accepted = await scoped(db, worldId).selectFields(
    events,
    { aggregateId: events.aggregateId },
    and(
      eq(events.type, "loan.accepted"),
      gte(events.occurredSimAt, dayStart),
      lt(events.occurredSimAt, new Date(dayStart.getTime() + DAY_MS)),
    )!,
  );
  let usedCents = 0n;
  if (accepted.length > 0) {
    const rows = await scoped(db, worldId).select(
      loans,
      inArray(
        loans.id,
        accepted.map((row) => row.aggregateId),
      ),
    );
    usedCents = rows
      .filter((loan) => loan.status !== "disbursement_failed")
      .reduce((sum, loan) => sum + loan.principalCents, 0n);
  }
  return { simDay: day, dayStartLiquidityCents: latest?.dayStartLiquidityCents ?? null, usedCents };
}

/** Every fact the loan gates need, for `agent` (its principal's exposure); `null` when the gates are off. */
export async function loanTreasuryFacts(
  db: Db,
  worldId: string,
  agent: { id: string; principalId: string | null },
  availableLiquidityCents?: bigint,
): Promise<LoanTreasuryFacts | null> {
  const policy = await getTreasuryPolicy(db, worldId);
  if (!policy) {
    return null;
  }
  const available = availableLiquidityCents ?? (await availableLiquidity(db, worldId));
  const totals = await redemptionTotals(db, worldId);
  const notes = await notesPayableCents(db, worldId);
  const loansReceivable = await getCodeBalance(db, worldId, "loans_receivable");
  const disbursing = (await scoped(db, worldId).select(loans, eq(loans.status, "disbursing"))).reduce(
    (sum, loan) => sum + loan.principalCents,
    0n,
  );
  const budget = await lendingBudget(db, worldId);
  return {
    policy,
    availableLiquidityCents: available,
    queuedRedemptionCents: totals.queuedCents,
    notesOutstandingCents: notes - totals.pendingCents,
    principalExposureCents: await principalExposureCents(db, worldId, agent),
    totalLoansCents: loansReceivable + disbursing,
    dayStartLiquidityCents: budget.dayStartLiquidityCents,
    budgetUsedCents: budget.usedCents,
  };
}
