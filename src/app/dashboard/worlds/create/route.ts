import { createWorldHandlers } from "@/server/auth/worldRoutes";
import { getDb } from "@/server/db/client";

/** `POST` — the signed-in owner creates a private sandbox world. See `src/server/auth/worldRoutes.ts`. */
const handlers = createWorldHandlers({ getDb });

// Seeding the bots runs a handful of sim-rail tool calls.
export const maxDuration = 60;

export async function POST(request: Request): Promise<Response> {
  return handlers.create(request);
}
