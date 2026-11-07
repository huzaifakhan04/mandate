import { getSimNow } from "../clock/clock";
import type { Db } from "../db/client";
import { elasticErrorMessage } from "../elastic/client";
import { elasticConfigured } from "../elastic/config";
import { runDetectors } from "../elastic/detectors";
import { readCursor, shipWorld, writeCursor } from "../elastic/ship";
import { investigatePendingFlags } from "./riskInvestigation";
import { expireStaleRiskFlags } from "./riskFlags";

/**
 * P7 — the Risk Desk's step in the tick, per world, AFTER the world's own
 * work has committed (an after-commit module: plain `db`, no transaction;
 * Elastic and OpenAI are only called from here and the modules it uses).
 *
 *   1. expire flags with no new evidence for 7 sim days (DB only — runs
 *      even without Elastic)
 *   2. ship new rows to Elastic (≤ 500 per world)
 *   3. once an hour (real time): run the ES|QL detectors → risk_flags
 *   4. investigate new flags (≤ 2 per world per tick; template-only in
 *      private worlds)
 *
 * Without Elastic (`ELASTIC_URL` unset) only step 1 runs. Failures are
 * reported, never thrown: the bank never waits on its Risk Desk.
 */

export const DETECTOR_INTERVAL_MS = 60 * 60_000;
export const DETECTOR_STREAM = "detectors";

export interface RiskDeskReport {
  expired: number;
  shipped: number;
  detectorsRan: boolean;
  newFlags: number;
  investigated: number;
  errors: string[];
}

export async function runRiskDesk(
  db: Db,
  worldId: string,
  { now = new Date(), signal, forceDetectors = false }: { now?: Date; signal?: AbortSignal; forceDetectors?: boolean } = {},
): Promise<RiskDeskReport> {
  const report: RiskDeskReport = { expired: 0, shipped: 0, detectorsRan: false, newFlags: 0, investigated: 0, errors: [] };
  const simNow = await getSimNow(db, worldId, now);
  report.expired = await expireStaleRiskFlags(db, worldId, simNow, now);
  if (!elasticConfigured()) {
    return report;
  }
  try {
    const shipped = await shipWorld(db, worldId, { now });
    report.shipped = shipped?.total ?? 0;
    report.errors.push(...(shipped?.errors ?? []));
  } catch (err) {
    report.errors.push(`ship: ${elasticErrorMessage(err)}`);
  }
  if (signal?.aborted) {
    return report;
  }
  const last = await readCursor(db, worldId, DETECTOR_STREAM);
  if (forceDetectors || !last.at || now.getTime() - last.at.getTime() >= DETECTOR_INTERVAL_MS) {
    // Claim the hour first, so a slow or failing cluster isn't hammered every minute.
    await writeCursor(db, worldId, DETECTOR_STREAM, { at: now, id: null });
    try {
      const detected = await runDetectors(db, { worldId, simNow, now });
      report.detectorsRan = true;
      report.newFlags = detected.newFlagIds.length;
      report.errors.push(...detected.errors.map((e) => `detector ${e}`));
      await writeCursor(db, worldId, DETECTOR_STREAM, { lastError: detected.errors[0] ?? null });
    } catch (err) {
      report.errors.push(`detectors: ${elasticErrorMessage(err)}`);
    }
  }
  if (!signal?.aborted) {
    const outcomes = await investigatePendingFlags(db, worldId, { now, ...(signal ? { signal } : {}) });
    report.investigated = outcomes.filter((o) => o.investigated).length;
    report.errors.push(...outcomes.filter((o) => o.error).map((o) => `investigate ${o.flagId}: ${o.error}`));
  }
  return report;
}
