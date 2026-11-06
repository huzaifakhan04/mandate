import { createDocumentHandlers } from "@/server/auth/documentRoutes";
import { getDb } from "@/server/db/client";

/**
 * Deletes one of the signed-in owner's KYA documents: `DELETE`, or a
 * same-origin form `POST` (HTML forms can't send DELETE).
 * See `src/server/auth/documentRoutes.ts`.
 */
const handlers = createDocumentHandlers({ getDb });

type Params = { params: Promise<{ id: string; docId: string }> };

async function remove(request: Request, { params }: Params): Promise<Response> {
  const { id, docId } = await params;
  return handlers.remove(request, id, docId);
}

export { remove as DELETE, remove as POST };
