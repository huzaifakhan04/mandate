import { createMandateHandlers } from "@/server/auth/mandateRoutes";
import { getDb } from "@/server/db/client";

/** `POST` — the signed-in owner revokes agent `id`'s current mandate. See `src/server/auth/mandateRoutes.ts`. */
const handlers = createMandateHandlers({ getDb });

type Params = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Params): Promise<Response> {
  return handlers.revoke(request, (await params).id);
}
