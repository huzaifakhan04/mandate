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
