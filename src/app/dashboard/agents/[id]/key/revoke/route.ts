import { createOwnerHandlers } from "@/server/auth/ownerRoutes";
import { getDb } from "@/server/db/client";

/**
 * `POST` — the signed-in owner revokes agent `id`'s Ed25519 signing key
 * (the agent drops to T1). See `src/server/auth/ownerRoutes.ts`.
 */
const handlers = createOwnerHandlers({ getDb });

type Params = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Params): Promise<Response> {
  return handlers.revokeKey(request, (await params).id);
}
