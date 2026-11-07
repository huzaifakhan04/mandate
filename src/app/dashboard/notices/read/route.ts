import { isUuid } from "@/server/auth/ownership";
import { failure, gate, json, readFields, seeOther, wantsHtml } from "@/server/auth/ownerRoutes";
import { getDb } from "@/server/db/client";
import { markOwnerNoticesRead } from "@/server/services/dashboard";

/**
 * `POST /dashboard/notices/read` — P4 Task 4: the signed-in owner marks
 * their notices read (`notice_id` for one, otherwise every unread one in
 * the view; `world` = the private world the dashboard shows, if any).
 * Owner read state only — the agent's own `ack_notices` is separate.
 * A browser form gets a 303 back to the notices panel; anything else JSON.
 */
export async function POST(request: Request): Promise<Response> {
  const back = { path: "/dashboard#notices", returnTo: "/dashboard" };
  const gated = await gate(request, back, getDb);
  if (gated instanceof Response) {
    return gated;
  }
  const fields = (await readFields(gated.request)) ?? {};
  const world = typeof fields.world === "string" && isUuid(fields.world) ? fields.world : undefined;
  const noticeId = typeof fields.notice_id === "string" && fields.notice_id ? fields.notice_id : undefined;
  if (noticeId !== undefined && !isUuid(noticeId)) {
    return failure(request, 404, "not_found", "Notice not found.", null);
  }
  try {
    const marked = await markOwnerNoticesRead(await getDb(), gated.principalId, { worldId: world, noticeId });
    return wantsHtml(request)
      ? seeOther(request, `/dashboard${world ? `?world=${world}` : ""}#notices`)
      : json(200, { ok: true, marked });
  } catch (err) {
    console.error(`[owner] mark notices read failed: ${err instanceof Error ? err.name : "unknown error"}`);
    return failure(request, 500, "error", "Something went wrong.", back);
  }
}
