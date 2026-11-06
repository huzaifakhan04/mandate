import { getSimNow } from "../clock/clock";
import type { Db } from "../db/client";
import { runBotsCatchUp } from "../bots/runner";
import { processDue } from "../services/collections";
import { expireStaleOffers } from "../services/loans";
import { listActivePrivateWorldIds, listActiveWorldIds } from "../services/worlds";
import { errorMessage, recordJobRun } from "./jobRuns";

/**
 * Task 8 — the tick cron (every minute), P1's `processDue` stub: for every
 * world, expires offers whose `expires_sim_at` has passed on that world's
 * simulated clock (OFFERED → EXPIRED through the loan machine; a
 * conditional update, so idempotent and safe against a concurrent
 * `accept_offer`); then (P4 Task 1) runs the delinquency ladder
 * (`processDue`: late → penalty → substandard → charged_off, each step exactly once,
 * plus the daily penalty accrual). A `job_runs` row per world only for a
 * run that did something (or failed); one world failing doesn't stop the others.
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
  botDays: number;
  errors: { worldId: string; message: string }[];
}

export async function runTick(db: Db, { now = new Date() }: { now?: Date } = {}): Promise<TickReport> {
  const report: TickReport = { worlds: 0, expired: 0, ladderSteps: 0, botDays: 0, errors: [] };
  for (const worldId of await listActiveWorldIds(db)) {
    report.worlds += 1;
    let expired = 0;
    let steps = { late: 0, penalty: 0, substandard: 0, charged_off: 0 };
    let accrued = 0;
    const errors: string[] = [];
    try {
      const simNow = await getSimNow(db, worldId, now);
      expired = await expireStaleOffers(db, worldId, simNow);
      const due = await processDue(db, worldId, simNow);
      steps = due.steps;
      accrued = due.accrued;
      for (const failure of due.errors) {
        const message = `loan ${failure.loanId}: ${failure.message}`;
        errors.push(message);
        report.errors.push({ worldId, message });
      }
    } catch (err) {
      const message = errorMessage(err);
      console.error(`[tick] world ${worldId} failed: ${message}`);
      errors.push(message);
      report.errors.push({ worldId, message });
    }
    report.expired += expired;
    const stepCount = steps.late + steps.penalty + steps.substandard + steps.charged_off;
    report.ladderSteps += stepCount;
    if (expired > 0 || stepCount > 0 || accrued > 0 || errors.length > 0) {
      // Fix round 1 (M2): idle ticks leave no rows.
      await recordJobRun(db, worldId, "tick", {
        expired_offers: expired,
        ...(stepCount > 0 || accrued > 0 ? { ladder_steps: steps, penalty_accruals: accrued } : {}),
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
      await recordJobRun(db, worldId, "tick", { bot_days: 0, errors: [message] });
    }
  }
  return report;
}
