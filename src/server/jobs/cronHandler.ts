import { timingSafeEqual } from "crypto";

import { NextResponse } from "next/server";

import type { Db } from "../db/client";
import { errorMessage } from "./jobRuns";

/**
 * Whether a cron request carries `Authorization: Bearer ${CRON_SECRET}`
 * (what Vercel Cron and scripts/ops/render-cron.mjs send). Fails closed: with `CRON_SECRET` unset no
 * request is authorized. Constant-time comparison.
 */
export function isAuthorizedCron(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return false;
  }
  const presented = Buffer.from(req.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

/**
 * GET (Vercel Cron) and POST (Render cron script) handlers for one cron job, with the database
 * resolver injected so tests can pass a PGlite test db. 401 without the
 * cron secret; 500 (logged) if the run itself throws; otherwise 200 with
 * the run's report.
 */
export function createCronHandler(
  job: string,
  run: (db: Db) => Promise<unknown>,
  { getDb }: { getDb: () => Promise<Db> },
) {
  async function handle(req: Request): Promise<NextResponse> {
    if (!isAuthorizedCron(req)) {
      return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
    }
    try {
      const report = await run(await getDb());
      return NextResponse.json({ ok: true, job, report });
    } catch (err) {
      console.error(`[cron] ${job} failed: ${errorMessage(err)}`);
      return NextResponse.json({ ok: false, job, error: "job_failed" }, { status: 500 });
    }
  }
  return { GET: handle, POST: handle };
}
