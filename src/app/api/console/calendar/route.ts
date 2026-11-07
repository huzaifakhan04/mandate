import { connection } from "next/server";

import { createConsoleHandlers } from "@/server/auth/consoleRoutes";
import { getDb } from "@/server/db/client";

/** `GET` — the console Calendar tab's events. Same world + PII rules as the snapshot; see `src/server/auth/consoleRoutes.ts`. */
const handlers = createConsoleHandlers({ getDb });

export async function GET(request: Request): Promise<Response> {
  await connection();
  return handlers.calendar(request);
}
