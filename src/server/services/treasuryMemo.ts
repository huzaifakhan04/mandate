import { and, eq, inArray, isNull, lt, or } from "drizzle-orm";

import { runRole } from "../ai/run";
import type { TreasuryOfficerInput, TreasuryOfficerOutput } from "../ai/schemas";
import { treasuryOfficerTemplate } from "../ai/templates";
import { getSimDay } from "../clock/clock";
import type { Db } from "../db/client";
import { economyState, loans, worlds } from "../db/schema";
import { scoped } from "../db/scoped";
import { utilizationPremiumBps } from "../domain/economy";
import { availableLiquidity } from "../domain/liquidity";
import { OPEN_LOAN_DB_STATUSES } from "../domain/loanMachine";
import { reserveFloorCents, shareOfCents, TREASURY_DEFAULTS } from "../domain/treasury";
import { allowanceBalance } from "./cecl";
import { liveUtilization } from "./economy";
import { getTreasuryPolicy, lendingBudget, notesPayableCents, redemptionTotals } from "./treasury";

/**
 * P5 Task 3: the daily AI treasury memo — an AFTER-COMMIT module (listed in
 * `AI_CALLERS`, tests/unit/ai/noTransactionCalls.test.ts). It takes a plain
 * `db`, is called by the tick after each world's work has committed, and
 * never opens a transaction.
 *
 * At most one memo per world per simulated day: the day's `economy_state`
 * row is claimed with a conditional update (`treasury_memo IS NULL` and no
 * fresh claim) before any model call, so concurrent ticks never pay for
 * two. A claim older than `MEMO_CLAIM_STALE_MS` with no memo (a crashed
 * tick) may be taken again. The input is the economy's numbers only
 * (`treasuryOfficerInputSchema`); the memo is advisory text
 * `{headline, observations, risks}` stored on the row for the console.
 * Private worlds (bots: simulated volume) always use the template — no
 * model call, no `ai_runs` row. Any model failure falls back to the
 * template inside `runRole`.
 */

export const MEMO_CLAIM_STALE_MS = 10 * 60_000;

export interface StoredTreasuryMemo extends TreasuryOfficerOutput {
  sim_day: number;
  source: "ai" | "template" | "fallback";
}

export type TreasuryMemoResult =
  | { written: false; reason: "no_economy_row" | "already_written" | "claimed" }
  | { written: true; simDay: number; memo: StoredTreasuryMemo; aiRunId: string | null };

/** The memo's input from the world's latest economy row and the live ledger. */
export async function treasuryMemoInput(db: Db, worldId: string, simDay: number): Promise<TreasuryOfficerInput | null> {
  const row = await scoped(db, worldId).findOne(economyState, eq(economyState.simDay, simDay));
  if (!row) {
    return null;
  }
  const policy = (await getTreasuryPolicy(db, worldId)) ?? { ...TREASURY_DEFAULTS, reserveFloorBps: 0 };
  const live = await liveUtilization(db, worldId);
  const available = await availableLiquidity(db, worldId);
  const totals = await redemptionTotals(db, worldId);
  const notes = await notesPayableCents(db, worldId);
  const budget = await lendingBudget(db, worldId);
  const openLoans = await scoped(db, worldId).selectFields(
    loans,
    { id: loans.id },
    inArray(loans.status, [...OPEN_LOAN_DB_STATUSES]),
  );
  return {
    simDay,
    baseRateBps: row.baseRateBps,
    inflationRateBps: row.inflationRateBps,
    inflationIndexBp: row.inflationIndexBp,
    utilizationBps: live.utilizationBps,
    utilizationPremiumBps: utilizationPremiumBps(live.utilizationBps),
    reserveRatioBps: notes > 0n ? Math.min(1_000_000, Number((live.cashCents * 10000n) / notes)) : 0,
    reserveFloorBps: policy.reserveFloorBps,
    reserveFloorCents: Number(reserveFloorCents(notes - totals.pendingCents, policy.reserveFloorBps)),
    cashCents: Number(live.cashCents),
    availableLiquidityCents: Number(available),
    loansReceivableCents: Number(live.loansReceivableCents),
    openLoans: openLoans.length,
    notesPayableCents: Number(notes),
    allowanceCents: Number(await allowanceBalance(db, worldId)),
    dailyBudgetCents:
      budget.dayStartLiquidityCents === null
        ? null
        : Number(shareOfCents(budget.dayStartLiquidityCents, policy.dailyBudgetBps)),
    budgetUsedCents: Number(budget.usedCents),
    queuedRedemptions: totals.queuedCount,
    queuedRedemptionCents: Number(totals.queuedCents),
  };
}

/**
 * Writes today's treasury memo for the world if it has none yet. Never
 * throws for a model failure (the template stands); a read failure
 * propagates to the tick, which records it and retries after the claim
 * goes stale.
 */
export async function writeDailyTreasuryMemo(
  db: Db,
  worldId: string,
  { now = new Date() }: { now?: Date } = {},
): Promise<TreasuryMemoResult> {
  const { day } = await getSimDay(db, worldId, now);
  const row = await scoped(db, worldId).findOne(economyState, eq(economyState.simDay, day));
  if (!row) {
    return { written: false, reason: "no_economy_row" };
  }
  if (row.treasuryMemo !== null) {
    return { written: false, reason: "already_written" };
  }
  const claimed = await scoped(db, worldId).update(
    economyState,
    { treasuryMemoClaimedAt: now },
    and(
      eq(economyState.id, row.id),
      isNull(economyState.treasuryMemo),
      or(
        isNull(economyState.treasuryMemoClaimedAt),
        lt(economyState.treasuryMemoClaimedAt, new Date(now.getTime() - MEMO_CLAIM_STALE_MS)),
      ),
    )!,
  );
  if (claimed.length !== 1) {
    return { written: false, reason: "claimed" };
  }

  const input = await treasuryMemoInput(db, worldId, day);
  if (!input) {
    return { written: false, reason: "no_economy_row" };
  }
  const [world] = await db.select({ kind: worlds.kind }).from(worlds).where(eq(worlds.id, worldId)).limit(1);
  let output: TreasuryOfficerOutput;
  let source: StoredTreasuryMemo["source"];
  let aiRunId: string | null = null;
  if (world?.kind === "private") {
    output = treasuryOfficerTemplate(input);
    source = "template";
  } else {
    const run = await runRole(db, worldId, "treasury_officer", input, { subject: `treasury_memo:${day}` });
    output = run.output;
    source = run.fallbackUsed ? "fallback" : "ai";
    aiRunId = run.aiRunId;
  }
  const memo: StoredTreasuryMemo = { ...output, sim_day: day, source };
  await scoped(db, worldId).update(
    economyState,
    { treasuryMemo: memo, treasuryMemoAiRunId: aiRunId },
    and(eq(economyState.id, row.id), isNull(economyState.treasuryMemo))!,
  );
  return { written: true, simDay: day, memo, aiRunId };
}
