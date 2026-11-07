import { getDb } from "@/server/db/client";
import { createCronHandler } from "@/server/jobs/cronHandler";
import { runTick } from "@/server/jobs/tick";

/** Every minute via Render Cron Jobs (render.yaml) or Vercel Cron (vercel.json); requires `Authorization: Bearer ${CRON_SECRET}`. */
export const maxDuration = 60;

// P8: the cron creates the public demo world on its first run (idempotent).
export const { GET, POST } = createCronHandler("tick", (db) => runTick(db, { ensureDemo: true }), { getDb });
