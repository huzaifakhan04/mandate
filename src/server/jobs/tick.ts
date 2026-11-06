import { getSimNow } from "../clock/clock";
import type { Db } from "../db/client";
import { runBotsCatchUp } from "../bots/runner";
import { processDue } from "../services/collections";
import { stepEconomyToNow } from "../services/economy";
import { expireStaleOffers } from "../services/loans";
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
  for (const { id: worldId, ladderOnTick } of await listActiveWorldsForTick(db)) {
    report.worlds += 1;
    let expired = 0;
    let steps = { late: 0, penalty: 0, substandard: 0, charged_off: 0 };
    let accrued = 0;
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
    const didWork = expired > 0 || stepCount > 0 || accrued > 0;
    // Final fix (minor c): the same errors again within the hour, and nothing else → no row.
    const record = didWork || (errors.length > 0 && !(await errorsRecentlyRecorded(db, worldId, "tick", errors, now)));
    if (record) {
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
      if (!(await errorsRecentlyRecorded(db, worldId, "tick", [message], now))) {
        await recordJobRun(db, worldId, "tick", { bot_days: 0, errors: [message] });
      }
    }
  }
  return report;
}
