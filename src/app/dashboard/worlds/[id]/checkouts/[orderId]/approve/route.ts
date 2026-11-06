import { createSimApproveHandlers } from "@/server/auth/simApproveRoutes";
import { getDb } from "@/server/db/client";

/**
 * `GET` — the owner's approval page for a simulated checkout in their
 * private world; `POST` — approve it. See `src/server/auth/simApproveRoutes.ts`.
 */
const handlers = createSimApproveHandlers({ getDb });

type Params = { params: Promise<{ id: string; orderId: string }> };

export async function GET(request: Request, { params }: Params): Promise<Response> {
  const { id, orderId } = await params;
  return handlers.show(request, id, orderId);
}

export async function POST(request: Request, { params }: Params): Promise<Response> {
  const { id, orderId } = await params;
  return handlers.approve(request, id, orderId);
}
