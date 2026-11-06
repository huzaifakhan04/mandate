import { createVerifyStartHandler } from "@/server/auth/routes";
import { getDb } from "@/server/db/client";

/**
 * `POST /verify/start` (form, optional `return_to`): creates the $0.01
 * "Verify with PayPal" order and 303s to PayPal's approve page. See
 * `src/server/auth/routes.ts`.
 */
export const maxDuration = 30;

export const POST = createVerifyStartHandler({ getDb });
