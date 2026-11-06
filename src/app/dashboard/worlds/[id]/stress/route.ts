import { createWorldHandlers } from "@/server/auth/worldRoutes";
import { getDb } from "@/server/db/client";

/** `POST` — P5 Task 4: trigger a stress scenario in the owner's sandbox world. See `src/server/auth/worldRoutes.ts`. */
const handlers = createWorldHandlers({ getDb });

// A note run makes every lender bot's redemption request synchronously.
export const maxDuration = 60;

type Params = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Params): Promise<Response> {
  return handlers.stress(request, (await params).id);
}
