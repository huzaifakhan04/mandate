import { connection } from "next/server";

import { createTimelineHandler } from "@/server/auth/timelineRoutes";
import { getDb } from "@/server/db/client";

/** `GET` — the owner's Timeline tab data. Owner-only; see `src/server/auth/timelineRoutes.ts`. */
const handler = createTimelineHandler({ getDb });

export async function GET(request: Request): Promise<Response> {
  await connection();
  return handler(request);
}
