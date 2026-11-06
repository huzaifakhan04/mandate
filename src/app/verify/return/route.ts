import { createVerifyReturnHandler } from "@/server/auth/routes";
import { getDb } from "@/server/db/client";

/**
 * `GET /verify/return?token=<orderId>` — PayPal's return URL for the
 * identity order. A Route Handler rather than a page because it must set
 * the `mandate_session` cookie (Server Components can't). Completes
 * verification server-side (never captures), then 303s to `return_to`
 * (default `/dashboard`) or to `/verify/error?reason=…`.
 */
export const maxDuration = 30;

export const GET = createVerifyReturnHandler({ getDb });
