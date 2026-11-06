import { NextResponse, type NextRequest } from "next/server";

import { REVEAL_COOKIE_NAME, REVEAL_COOKIE_PATH, REVEAL_HEADER_NAME } from "./server/auth/revealCookie";

/**
 * P2 Task 5: the one-time API key page. The proxy hands the page the
 * sealed `mandate_reveal` cookie as a request header (any client-sent
 * copy of that header is dropped first) and clears the cookie on the same
 * response, so the key is shown exactly once — a reload finds nothing.
 * (A cookie the proxy deletes is also hidden from the page's `cookies()`,
 * hence the header.) Runs only on `/dashboard/agents/<id>/api-key`.
 */
export function proxy(request: NextRequest): NextResponse {
  const headers = new Headers(request.headers);
  headers.delete(REVEAL_HEADER_NAME);
  const sealed = request.method === "GET" ? request.cookies.get(REVEAL_COOKIE_NAME)?.value : undefined;
  if (sealed) {
    headers.set(REVEAL_HEADER_NAME, sealed);
  }
  const response = NextResponse.next({ request: { headers } });
  if (sealed) {
    response.cookies.set({
      name: REVEAL_COOKIE_NAME,
      value: "",
      path: REVEAL_COOKIE_PATH,
      maxAge: 0,
      httpOnly: true,
      sameSite: "strict",
      secure: process.env.NODE_ENV === "production",
    });
  }
  response.headers.set("cache-control", "no-store");
  return response;
}

export const config = {
  matcher: "/dashboard/agents/:id/api-key",
};
