import { createMandateHandlers } from "@/server/auth/mandateRoutes";
import { getDb } from "@/server/db/client";

/**
 * `POST` — the signed-in owner signs a new mandate version for agent `id`
 * (JSON or form; fields + `typed_name` + `agree`). See
 * `src/server/auth/mandateRoutes.ts`.
 */
const handlers = createMandateHandlers({ getDb });

type Params = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Params): Promise<Response> {
  return handlers.sign(request, (await params).id);
}
