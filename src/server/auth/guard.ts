import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { connection } from "next/server";

import { SESSION_COOKIE_NAME, readSession, type SessionData } from "./session";

/**
 * Route guards for owner pages and actions (P2). The session is
 * stateless: a valid signature + unexpired `exp` is the whole check here;
 * ownership of a specific agent/mandate is each route's own check
 * (Review Focus 3).
 */

export class PrincipalRequiredError extends Error {
  readonly status = 401;
  constructor() {
    super("Sign in with PayPal to continue.");
    this.name = "PrincipalRequiredError";
  }
}

/** The value of cookie `name` in a `Cookie` header, or `null`. */
export function cookieFromHeader(header: string | null, name: string): string | null {
  if (!header) {
    return null;
  }
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1 || part.slice(0, index).trim() !== name) {
      continue;
    }
    const raw = part.slice(index + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return null;
}

/** The signed-in principal on `request`, or `null`. */
export function principalFromRequest(request: Request): SessionData | null {
  return readSession(cookieFromHeader(request.headers.get("cookie"), SESSION_COOKIE_NAME));
}

/** The signed-in principal on `request`; throws `PrincipalRequiredError` (401) when there is none. */
export function requirePrincipal(request: Request): SessionData {
  const session = principalFromRequest(request);
  if (!session) {
    throw new PrincipalRequiredError();
  }
  return session;
}

/** `/verify?return_to=…` — where an unauthenticated owner page sends the human. */
export function signInPath(returnTo: string): string {
  return `/verify?return_to=${encodeURIComponent(returnTo)}`;
}

/**
 * Server Components: the signed-in principal from `cookies()`, or `null`.
 * Reading cookies is request-time work (call it inside `<Suspense>`).
 */
export async function getPagePrincipal(): Promise<SessionData | null> {
  // The expiry check reads the clock: request-time work only (Cache Components).
  await connection();
  return readSession((await cookies()).get(SESSION_COOKIE_NAME)?.value);
}

/** Server Components: the signed-in principal, or a redirect to `/verify` returning to `returnTo`. */
export async function requirePagePrincipal(returnTo: string): Promise<SessionData> {
  const session = await getPagePrincipal();
  if (!session) {
    redirect(signInPath(returnTo));
  }
  return session;
}
