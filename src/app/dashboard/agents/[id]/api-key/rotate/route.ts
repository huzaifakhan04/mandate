import { createOwnerHandlers } from "@/server/auth/ownerRoutes";
import { getDb } from "@/server/db/client";

/**
 * `POST` — the signed-in owner gives agent `id` a new API key; the old
 * one stops working. A browser form 303s to the one-time key page. See
 * `src/server/auth/ownerRoutes.ts`.
 */
const handlers = createOwnerHandlers({ getDb });

type Params = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Params): Promise<Response> {
  return handlers.rotate(request, (await params).id);
}
