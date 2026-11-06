import { after } from "next/server";

import { createDocumentHandlers } from "@/server/auth/documentRoutes";
import { getDb } from "@/server/db/client";

/**
 * `GET`  — the signed-in owner's KYA documents for agent `id` (metadata only).
 * `POST` — upload one (multipart: `kind`, `file`; pdf/png/jpg ≤ 2 MB); the
 *          advisory KYA desk review runs after the response (`after()`).
 * See `src/server/auth/documentRoutes.ts`.
 */
const handlers = createDocumentHandlers({ getDb, afterResponse: (task) => after(task) });

type Params = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Params): Promise<Response> {
  return handlers.list(request, (await params).id);
}

export async function POST(request: Request, { params }: Params): Promise<Response> {
  return handlers.upload(request, (await params).id);
}
