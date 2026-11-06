import { createOwnerHandlers } from "@/server/auth/ownerRoutes";
import { getDb } from "@/server/db/client";

/** `POST` — the signed-in owner unfreezes agent `id`. See `src/server/auth/ownerRoutes.ts`. */
const handlers = createOwnerHandlers({ getDb });

type Params = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Params): Promise<Response> {
  return handlers.unfreeze(request, (await params).id);
}
