import { NextResponse, type NextRequest } from "next/server";

import { REVEAL_COOKIE_NAME, REVEAL_COOKIE_PATH, REVEAL_HEADER_NAME } from "./server/auth/revealCookie";

/** The one-time API key page (P2 Task 5) — the only path the reveal cookie is read on. */
const API_KEY_PAGE_RE = /^\/dashboard\/agents\/[^/]+\/api-key\/?$/;

/**
 * Runs on the owner dashboard, claim, verify and checkout pages, and the
 * console (P6: it can show a signed-in owner's private world):
 *
 * - **Caching (P2 final review, I-2):** every response gets
 *   `cache-control: private, no-store`, so no CDN or shared cache keeps a
 *   signed-in page, a claim page (its URL is a bearer token) or a
 *   checkout return (its `?token=`).
 * - **One-time API key page (P2 Task 5):** on
 *   `/dashboard/agents/<id>/api-key` only, the proxy hands the page the
 *   sealed `mandate_reveal` cookie as a request header and clears the
 *   cookie on the same response, so the key is shown exactly once — a
 *   reload finds nothing. (A cookie the proxy deletes is also hidden from
 *   the page's `cookies()`, hence the header.) Any client-sent copy of
 *   that header is dropped on every path.
 */
export function proxy(request: NextRequest): NextResponse {
  const headers = new Headers(request.headers);
  headers.delete(REVEAL_HEADER_NAME);
  const isApiKeyPage = API_KEY_PAGE_RE.test(request.nextUrl.pathname);
  const sealed =
    isApiKeyPage && request.method === "GET" ? request.cookies.get(REVEAL_COOKIE_NAME)?.value : undefined;
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
  response.headers.set("cache-control", "private, no-store");
  return response;
}

export const config = {
  matcher: ["/dashboard/:path*", "/claim/:path*", "/verify/:path*", "/checkout/:path*", "/console"],
};
