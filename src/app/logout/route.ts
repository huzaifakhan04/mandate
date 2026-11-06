import { createLogoutHandler } from "@/server/auth/routes";

/** `POST /logout`: clears `mandate_session` and 303s to `/`. */
export const POST = createLogoutHandler();
