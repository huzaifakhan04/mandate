import { createOwnerHandlers } from "@/server/auth/ownerRoutes";
import { getDb } from "@/server/db/client";

/** `POST` — the signed-in owner freezes agent `id`. See `src/server/auth/ownerRoutes.ts`. */
const handlers = createOwnerHandlers({ getDb });

type Params = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Params): Promise<Response> {
  return handlers.freeze(request, (await params).id);
}
