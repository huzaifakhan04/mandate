import { createOwnerHandlers } from "@/server/auth/ownerRoutes";
import { getDb } from "@/server/db/client";

/** `POST` — P7: the signed-in owner's risk-flag action (review). See `src/server/auth/ownerRoutes.ts`. */
const handlers = createOwnerHandlers({ getDb });

type Params = { params: Promise<{ id: string; flagId: string }> };

export async function POST(request: Request, { params }: Params): Promise<Response> {
  const { id, flagId } = await params;
  return handlers.riskReview(request, id, flagId);
}
