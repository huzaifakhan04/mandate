import { and, eq, gt, isNull } from "drizzle-orm";

import type { Db } from "../db/client";
import { safeErrorMessage } from "../db/errors";
import { jobRuns } from "../db/schema";
import { scoped } from "../db/scoped";

/**
 * Records one cron run for one world in `job_runs` (Task 8): the job
 * name and its JSON-safe output (counts, errors, anomalies). Every-minute
 * jobs leave `sim_day` null (it is only unique for P4's daily jobs).
 * Never throws — a failed bookkeeping write must not fail the run; it is
 * logged instead.
 */
export async function recordJobRun(db: Db, worldId: string, job: string, output: Record<string, unknown>): Promise<void> {
  try {
    await scoped(db, worldId).insert(jobRuns, { job, simDay: null, output, finishedAt: new Date() });
  } catch (err) {
    console.error(`[jobs] could not record ${job} run for world ${worldId}: ${errorMessage(err)}`);
  }
}

export function errorMessage(err: unknown): string {
  // M12: never the query text/params a Drizzle query error carries.
  return safeErrorMessage(err);
}

/** Anomaly count recorded by the world's newest every-minute row of `job`, or 0 when there is none. */
export async function previousAnomalyCount(db: Db, worldId: string, job: string): Promise<number> {
  const row = await scoped(db, worldId).findLatest(
    jobRuns,
    and(eq(jobRuns.job, job), isNull(jobRuns.simDay))!,
    jobRuns.createdAt,
  );
  const anomalies = (row?.output as { anomalies?: unknown } | null | undefined)?.anomalies;
  return Array.isArray(anomalies) ? anomalies.length : 0;
}

/** How long a repeated, identical error set is kept out of `job_runs` (final fix minor c). */
export const REPEATED_ERROR_WINDOW_MS = 60 * 60 * 1000;

/**
 * Final fix (minor c): whether the world already has an every-minute row
 * of `job` finished within the last hour (before `now`) recording exactly
 * these errors — then a run that did nothing but fail the same way again
 * leaves no row (a stuck loan would otherwise write one a minute). Errors
 * compared as a set. A failure to check counts as "not recorded".
 */
export async function errorsRecentlyRecorded(
  db: Db,
  worldId: string,
  job: string,
  errors: string[],
  now: Date,
): Promise<boolean> {
  if (errors.length === 0) {
    return false;
  }
  const key = JSON.stringify([...errors].sort());
  try {
    const rows = await scoped(db, worldId).selectFields(
      jobRuns,
      { output: jobRuns.output },
      and(
        eq(jobRuns.job, job),
        isNull(jobRuns.simDay),
        gt(jobRuns.finishedAt, new Date(now.getTime() - REPEATED_ERROR_WINDOW_MS)),
      )!,
    );
    return rows.some((row) => {
      const recorded = (row.output as { errors?: unknown } | null)?.errors;
      return Array.isArray(recorded) && JSON.stringify([...(recorded as string[])].sort()) === key;
    });
  } catch (err) {
    console.error(`[jobs] could not check ${job} runs for world ${worldId}: ${errorMessage(err)}`);
    return false;
  }
}
