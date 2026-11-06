import { getDb } from "@/server/db/client";
import { createCronHandler } from "@/server/jobs/cronHandler";
import { runTick } from "@/server/jobs/tick";

/** Vercel Cron, every minute (vercel.json); requires `Authorization: Bearer ${CRON_SECRET}`. */
export const maxDuration = 60;

export const { GET, POST } = createCronHandler("tick", (db) => runTick(db), { getDb });
