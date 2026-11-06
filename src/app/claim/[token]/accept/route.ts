import { createClaimHandler } from "@/server/auth/claimRoutes";
import { getDb } from "@/server/db/client";

/**
 * `POST /claim/<token>/accept` — the claim page's "Claim agent" form.
 * See `src/server/auth/claimRoutes.ts`.
 */
const handler = createClaimHandler({ getDb });

export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }): Promise<Response> {
  return handler(request, (await params).token);
}
