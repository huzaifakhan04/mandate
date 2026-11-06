import { createOwnerHandlers } from "@/server/auth/ownerRoutes";
import { getDb } from "@/server/db/client";

/**
 * `POST` — path B: the signed-in owner registers an agent (already claimed
 * by them). A browser form 303s to the one-time API key page. See
 * `src/server/auth/ownerRoutes.ts`.
 */
const handlers = createOwnerHandlers({ getDb });

export async function POST(request: Request): Promise<Response> {
  return handlers.register(request);
}
