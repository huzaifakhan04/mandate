import { and, eq, isNull } from "drizzle-orm";

import type { Db } from "../db/client";
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
  return err instanceof Error ? err.message : String(err);
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
