import { createWorldHandlers } from "@/server/auth/worldRoutes";
import { getDb } from "@/server/db/client";

/** `POST` — archive the owner's sandbox world and open a fresh one. See `src/server/auth/worldRoutes.ts`. */
const handlers = createWorldHandlers({ getDb });

export const maxDuration = 60;

type Params = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Params): Promise<Response> {
  return handlers.reset(request, (await params).id);
}
