import { connection } from "next/server";

import { createConsoleHandlers } from "@/server/auth/consoleRoutes";
import { getDb } from "@/server/db/client";

/** `GET` — the public bank console's live snapshot. See `src/server/auth/consoleRoutes.ts`. */
const handlers = createConsoleHandlers({ getDb });

export async function GET(request: Request): Promise<Response> {
  await connection();
  return handlers.snapshot(request);
}
