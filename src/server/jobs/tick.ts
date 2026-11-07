import { getSimNow } from "../clock/clock";
import type { Db } from "../db/client";
import { runBotsCatchUp } from "../bots/runner";
import { processDue } from "../services/collections";
import { stepEconomyToNow } from "../services/economy";
import { replanWorldInstallments } from "../services/installments";
import { expireStaleOffers } from "../services/loans";
import { processRedemptionQueue } from "../services/notes";
import { runRiskDesk } from "../services/riskDesk";
import { writeDailyTreasuryMemo } from "../services/treasuryMemo";
import { listActivePrivateWorldIds, listActiveWorldsForTick } from "../services/worlds";
import { errorMessage, errorsRecentlyRecorded, recordJobRun } from "./jobRuns";

/**
 * Task 8 — the tick cron (every minute), P1's `processDue` stub: for every
 * world, expires offers whose `expires_sim_at` has passed on that world's
 * simulated clock (OFFERED → EXPIRED through the loan machine; a
 * conditional update, so idempotent and safe against a concurrent
 * `accept_offer`); then (P4 Task 1) runs the delinquency ladder
 * (`processDue`: late → penalty → substandard → charged_off, each step exactly once,
 * plus the daily penalty accrual). A `job_runs` row per world only for a
 * run that did something (or failed — the same errors again within the
 * hour leave no new row); one world failing doesn't stop the others. Final
 * fix I1: a private world whose clock is frozen (speed 0) is skipped by the
 * ladder here — its owner's advance runs it — and an idle late loan takes
 * no locks (`processDue`'s unlocked pre-check).
 *
 * P5 Task 1: first of all, each world's economy is stepped to its current
 * simulated day (`stepEconomyToNow`: one `economy_state` row per day,
 * catching up in order; the main world runs at speed 1, so once a real
 * day). A frozen private world's day doesn't move here — its advance steps it.
 *
 * P5 Task 3 / final review I1: the world's queued redemptions are paid in
 * FIFO order while cash allows (`processRedemptionQueue`), for EVERY active
 * world, independent of the ladder gate above — it takes the note series
 * lock, keeps FIFO and never reads the simulated clock, so a frozen private
 * world (speed 0) still gets cash that arrives (e.g. a note purchase) paid
 * out to its queue every minute, even though its delinquency ladder waits
 * for the owner's advance. The owner's advance also calls it on its own
 * (so a world the owner is actively driving pays the queue right away
 * too); calling it again here moments later is a harmless no-op. Last,
 * after all of that has committed, the day's treasury memo
 * (`writeDailyTreasuryMemo`: once per world per sim day; templates only in
 * private worlds).
 *
 * P7: last for each world, the Risk Desk (`runRiskDesk`, after commit):
 * stale risk flags expire; with Elastic configured, new rows ship to
 * Elastic, the ES|QL detectors run hourly and new flags get a case file.
 * Bounded by `RISK_DESK_BUDGET_MS` of the tick's 60 s.
 *
 * P7: after the ladder, every open repayment plan is re-planned from the
 * loan's payment events (`replanWorldInstallments`: paid early / partial,
 * missed → notice (+ one auto-move if opted in), failed / refunded
 * captures) — same clock gate as the ladder (a frozen private world
 * re-plans on its owner's advance). Guidance only; no journal.
 *
 * P2 Task 6: then, for every active private world, the bots act for each
 * simulated day the world's clock has passed since they last acted (at
 * most 7 per tick; a frozen clock → nothing, however often this runs).
 */

export interface TickReport {
  worlds: number;
  expired: number;
  /** P4: delinquency ladder steps applied across all worlds. */
  ladderSteps: number;
  /** P5 Task 3: queued redemptions paid (promoted to a payout) across all worlds. */
  queuedRedemptionsPaid: number;
  /** P5 Task 3: treasury memos written. */
  treasuryMemos: number;
  /** P7: installments re-planned (paid / missed / moved / failed) across all worlds. */
  installmentsReplanned: number;
  botDays: number;
  /** P7: documents shipped to Elastic, risk flags opened, case files written. */
  riskShipped: number;
  riskFlags: number;
  riskInvestigated: number;
  errors: { worldId: string; message: string }[];
}

/** P7: the Risk Desk stops starting new work this long after the tick began. */
export const RISK_DESK_BUDGET_MS = 40_000;

export async function runTick(db: Db, { now = new Date() }: { now?: Date } = {}): Promise<TickReport> {
  const riskDeadline = AbortSignal.timeout(RISK_DESK_BUDGET_MS);
  const report: TickReport = {
    worlds: 0,
    expired: 0,
    ladderSteps: 0,
    queuedRedemptionsPaid: 0,
    treasuryMemos: 0,
    installmentsReplanned: 0,
    botDays: 0,
    riskShipped: 0,
    riskFlags: 0,
    riskInvestigated: 0,
    errors: [],
  };
  for (const { id: worldId, ladderOnTick } of await listActiveWorldsForTick(db)) {
    report.worlds += 1;
    let expired = 0;
    let steps = { late: 0, penalty: 0, substandard: 0, charged_off: 0 };
    let accrued = 0;
    let queuePaid = 0;
    let replanned = 0;
    const errors: string[] = [];
    try {
      // P5 Task 1: the world's economy for each sim day passed (idempotent; a no-op within a day).
      await stepEconomyToNow(db, worldId, now);
      const simNow = await getSimNow(db, worldId, now);
      expired = await expireStaleOffers(db, worldId, simNow);
      // Final fix I1: a frozen-clock private world's ladder runs on its advance, not here.
      if (ladderOnTick) {
        const due = await processDue(db, worldId, simNow);
        steps = due.steps;
        accrued = due.accrued;
        for (const failure of due.errors) {
          const message = `loan ${failure.loanId}: ${failure.message}`;
          errors.push(message);
          report.errors.push({ worldId, message });
        }
        // P7: re-plan agent repayment schedules from the day's payment events.
        const plans = await replanWorldInstallments(db, worldId, simNow);
        replanned = plans.changed;
        for (const failure of plans.errors) {
          const message = `installments for loan ${failure.loanId}: ${failure.message}`;
          errors.push(message);
          report.errors.push({ worldId, message });
        }
      }
      // Final review I1: the redemption queue is clock-independent (FIFO,
      // series-lock-gated), so it runs every minute for every active world —
      // including a frozen private world the ladder above just skipped.
      const queue = await processRedemptionQueue(db, worldId);
      queuePaid = queue.paid + queue.failed;
    } catch (err) {
      const message = errorMessage(err);
      console.error(`[tick] world ${worldId} failed: ${message}`);
      errors.push(message);
      report.errors.push({ worldId, message });
    }
    // P5 Task 3: the day's treasury memo, after everything above committed (once per sim day).
    let memo = false;
    try {
      memo = (await writeDailyTreasuryMemo(db, worldId, { now })).written;
    } catch (err) {
      const message = `treasury memo: ${errorMessage(err)}`;
      console.error(`[tick] world ${worldId} ${message}`);
      errors.push(message);
      report.errors.push({ worldId, message });
    }
    // P7: the Risk Desk, after the world's work above committed.
    let risk = { shipped: 0, newFlags: 0, investigated: 0, expired: 0 };
    try {
      const desk = await runRiskDesk(db, worldId, { now, signal: riskDeadline });
      risk = desk;
      for (const message of desk.errors) {
        const text = `risk desk: ${message}`;
        errors.push(text);
        report.errors.push({ worldId, message: text });
      }
    } catch (err) {
      const message = `risk desk: ${errorMessage(err)}`;
      console.error(`[tick] world ${worldId} ${message}`);
      errors.push(message);
      report.errors.push({ worldId, message });
    }
    report.riskShipped += risk.shipped;
    report.riskFlags += risk.newFlags;
    report.riskInvestigated += risk.investigated;
    report.expired += expired;
    report.queuedRedemptionsPaid += queuePaid;
    report.treasuryMemos += memo ? 1 : 0;
    report.installmentsReplanned += replanned;
    const stepCount = steps.late + steps.penalty + steps.substandard + steps.charged_off;
    report.ladderSteps += stepCount;
    // The memo lives on economy_state (and ai_runs); on its own it leaves no job_runs row.
    const didWork = expired > 0 || stepCount > 0 || accrued > 0 || queuePaid > 0 || replanned > 0 || risk.newFlags > 0 || risk.expired > 0;
    // Final fix (minor c): the same errors again within the hour, and nothing else → no row.
    const record = didWork || (errors.length > 0 && !(await errorsRecentlyRecorded(db, worldId, "tick", errors, now)));
    if (record) {
      // Fix round 1 (M2): idle ticks leave no rows.
      await recordJobRun(db, worldId, "tick", {
        expired_offers: expired,
        ...(stepCount > 0 || accrued > 0 ? { ladder_steps: steps, penalty_accruals: accrued } : {}),
        ...(queuePaid > 0 ? { queued_redemptions_settled: queuePaid } : {}),
        ...(memo ? { treasury_memo: true } : {}),
        ...(risk.newFlags > 0 || risk.expired > 0 || risk.investigated > 0
          ? { risk_flags_opened: risk.newFlags, risk_flags_expired: risk.expired, risk_case_files: risk.investigated }
          : {}),
        ...(replanned > 0 ? { installments_replanned: replanned } : {}),
        errors,
      });
    }
  }
  for (const worldId of await listActivePrivateWorldIds(db)) {
    try {
      const days = await runBotsCatchUp(db, worldId, { now });
      report.botDays += days;
      if (days > 0) {
        await recordJobRun(db, worldId, "tick", { bot_days: days, errors: [] });
      }
    } catch (err) {
      const message = errorMessage(err);
      console.error(`[tick] bots in world ${worldId} failed: ${message}`);
      report.errors.push({ worldId, message });
      if (!(await errorsRecentlyRecorded(db, worldId, "tick", [message], now))) {
        await recordJobRun(db, worldId, "tick", { bot_days: 0, errors: [message] });
      }
    }
  }
  return report;
}
