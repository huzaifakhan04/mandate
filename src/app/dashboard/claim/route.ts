import { createOwnerHandlers } from "@/server/auth/ownerRoutes";
import { getDb } from "@/server/db/client";

/**
 * `POST` — "Paste claim link": `claim_link` (the full link or the bare
 * token) → 303 to `/claim/<token>`. See `src/server/auth/ownerRoutes.ts`.
 */
const handlers = createOwnerHandlers({ getDb });

export async function POST(request: Request): Promise<Response> {
  return handlers.pasteClaim(request);
}
