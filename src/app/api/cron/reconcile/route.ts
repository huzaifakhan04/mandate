import { getDb } from "@/server/db/client";
import { createCronHandler } from "@/server/jobs/cronHandler";
import { runReconcile } from "@/server/jobs/reconcile";

/** Vercel Cron, every minute (vercel.json); requires `Authorization: Bearer ${CRON_SECRET}`. */
export const maxDuration = 60;

export const { GET, POST } = createCronHandler("reconcile", (db) => runReconcile(db), { getDb });
