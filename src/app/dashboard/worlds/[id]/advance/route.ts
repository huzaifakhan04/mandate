import { createWorldHandlers } from "@/server/auth/worldRoutes";
import { getDb } from "@/server/db/client";

/** `POST` — move the owner's sandbox world clock +1 or +7 days (the bots act each day). See `src/server/auth/worldRoutes.ts`. */
const handlers = createWorldHandlers({ getDb });

// Up to 7 simulated days of bot activity run synchronously.
export const maxDuration = 60;

type Params = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Params): Promise<Response> {
  return handlers.advance(request, (await params).id);
}
