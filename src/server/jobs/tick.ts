import { getSimNow } from "../clock/clock";
import type { Db } from "../db/client";
import { runBotsCatchUp } from "../bots/runner";
import { expireStaleOffers } from "../services/loans";
import { listActivePrivateWorldIds, listActiveWorldIds } from "../services/worlds";
import { errorMessage, recordJobRun } from "./jobRuns";

/**
 * Task 8 — the tick cron (every minute), P1's `processDue` stub: for every
 * world, expires offers whose `expires_sim_at` has passed on that world's
 * simulated clock (OFFERED → EXPIRED through the loan machine; a
 * conditional update, so idempotent and safe against a concurrent
 * `accept_offer`). Delinquency and the rest arrive in P4. A `job_runs`
 * row per world only for a run that expired something (or failed); one world failing doesn't stop the others.
 *
 * P2 Task 6: then, for every active private world, the bots act for each
 * simulated day the world's clock has passed since they last acted (at
 * most 7 per tick; a frozen clock → nothing, however often this runs).
 */

export interface TickReport {
  worlds: number;
  expired: number;
  botDays: number;
  errors: { worldId: string; message: string }[];
}

export async function runTick(db: Db, { now = new Date() }: { now?: Date } = {}): Promise<TickReport> {
  const report: TickReport = { worlds: 0, expired: 0, botDays: 0, errors: [] };
  for (const worldId of await listActiveWorldIds(db)) {
    report.worlds += 1;
    let expired = 0;
    const errors: string[] = [];
    try {
      const simNow = await getSimNow(db, worldId, now);
      expired = await expireStaleOffers(db, worldId, simNow);
    } catch (err) {
      const message = errorMessage(err);
      console.error(`[tick] world ${worldId} failed: ${message}`);
      errors.push(message);
      report.errors.push({ worldId, message });
    }
    report.expired += expired;
    if (expired > 0 || errors.length > 0) {
      // Fix round 1 (M2): idle ticks leave no rows.
      await recordJobRun(db, worldId, "tick", { expired_offers: expired, errors });
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
