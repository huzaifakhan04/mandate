import type { Db } from "../db/client";
import { absoluteUrl } from "../http/publicUrl";
import { VerificationError, completeVerification, startVerification } from "../services/principals";
import { HOUR_MS, takeDbRateLimits } from "../http/dbRateLimit";
import { clientKey } from "../http/rateLimit";
import { cookieFromHeader } from "./guard";
import {
  type CookieOptions,
  SESSION_COOKIE_NAME,
  VERIFY_COOKIE_NAME,
  createSession,
  createVerifyState,
  readVerifyState,
  sessionCookieOptions,
  verifyCookieOptions,
} from "./session";

/**
 * Route handlers for Verify with PayPal and logout (P2 Task 1), built as
 * factories over `getDb` (like the webhook handler) so tests drive them
 * with a PGlite db:
 *
 * - `POST /verify/start` (form, optional `return_to`): creates the $0.01
 *   order, sets the signed 30-minute `mandate_verify` cookie binding this
 *   browser to that order (and the sanitized `return_to`), and 303s to
 *   PayPal's approve URL.
 * - `GET /verify/return?token=<orderId>`: PayPal's return. The order id
 *   must match the `mandate_verify` cookie — an order id alone (e.g. one
 *   leaked from a URL) never signs anyone in. Completes verification,
 *   sets `mandate_session`, clears `mandate_verify` and 303s to
 *   `return_to`; any failure 303s to `/verify/error?reason=…`.
 * - `POST /logout`: clears `mandate_session`, 303s to `/`.
 */

export type VerifyErrorReason =
  | VerificationError["code"]
  | "session_mismatch"
  | "cancelled"
  | "rate_limited"
  | "error";

/** P8: each `POST /verify/start` creates a real PayPal order — at most 10 per client IP per hour. */
export const VERIFY_START_PER_IP_PER_HOUR = 10;

function serializeCookie(name: string, value: string, options: CookieOptions): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${options.path}`,
    `Max-Age=${options.maxAge}`,
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (options.maxAge === 0) {
    parts.push("Expires=Thu, 01 Jan 1970 00:00:00 GMT");
  }
  if (options.secure) {
    parts.push("Secure");
  }
  return parts.join("; ");
}

function clearCookie(name: string): string {
  return serializeCookie(name, "", { ...sessionCookieOptions(), maxAge: 0 });
}

function redirect(location: string, cookies: string[] = []): Response {
  const headers = new Headers({ location, "cache-control": "no-store" });
  for (const cookie of cookies) {
    headers.append("set-cookie", cookie);
  }
  return new Response(null, { status: 303, headers });
}

function errorRedirect(request: Request, reason: VerifyErrorReason, cookies: string[] = []): Response {
  return redirect(absoluteUrl(`/verify/error?reason=${reason}`, request), cookies);
}

/**
 * CSRF guard for form POSTs: a present `Origin` must be this deployment's
 * (the request's own origin or `PUBLIC_BASE_URL`'s); without `Origin`,
 * `Sec-Fetch-Site` must be `same-origin` or `none`. With neither header the
 * request is refused (fail closed — browsers send at least one on a POST).
 *
 * `Origin: null` counts as absent, and then `Sec-Fetch-Site` (set by the
 * browser, never by page scripts) decides. Browsers send `Origin: null`
 * for a form POST from a page with `Referrer-Policy: no-referrer` — found
 * by the real-browser sandbox e2e (P2 Task 7), when the claim page used
 * that policy and its Verify / Claim buttons were refused. The claim page
 * is now `same-origin` (M1), so it sends a real Origin; the relaxation
 * stays because a user agent or privacy extension can still force
 * `no-referrer` (or strip Origin) on any of our pages, and Sec-Fetch-Site
 * is an equally unforgeable same-origin signal for those requests. A
 * cross-site POST with `Origin: null` still fails: its Sec-Fetch-Site is
 * `cross-site`.
 */
export function isSameOriginPost(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (origin && origin !== "null") {
    const allowed = new Set([new URL(request.url).origin]);
    const base = process.env.PUBLIC_BASE_URL;
    if (base) {
      try {
        allowed.add(new URL(base).origin);
      } catch {
        // A malformed PUBLIC_BASE_URL adds nothing.
      }
    }
    return allowed.has(origin);
  }
  const site = request.headers.get("sec-fetch-site");
  return site === "same-origin" || site === "none";
}

function forbidden(): Response {
  return new Response("Forbidden", { status: 403, headers: { "content-type": "text/plain" } });
}

async function formField(request: Request, name: string): Promise<string | null> {
  try {
    const value = (await request.formData()).get(name);
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

export function createVerifyStartHandler({ getDb }: { getDb: () => Promise<Db> }) {
  return async function POST(request: Request): Promise<Response> {
    if (!isSameOriginPost(request)) {
      return forbidden();
    }
    const requested = await formField(request, "return_to");
    try {
      const db = await getDb();
      const limited = await takeDbRateLimits(db, [
        { key: `verify_start:ip:${clientKey(request)}`, limit: VERIFY_START_PER_IP_PER_HOUR, windowMs: HOUR_MS },
      ]);
      if (!limited.allowed) {
        const wantsHtml = (request.headers.get("accept") ?? "").includes("text/html");
        if (wantsHtml) {
          return errorRedirect(request, "rate_limited");
        }
        return new Response(
          JSON.stringify({ error: "rate_limited", message: "Too many verification attempts; try again later.", retry_after_seconds: limited.retryAfterSeconds }),
          {
            status: 429,
            headers: { "content-type": "application/json", "cache-control": "no-store", "retry-after": String(limited.retryAfterSeconds) },
          },
        );
      }
      const { approveUrl, orderId, returnTo } = await startVerification(db, { returnTo: requested });
      return redirect(approveUrl, [
        serializeCookie(VERIFY_COOKIE_NAME, createVerifyState({ orderId, returnTo }), verifyCookieOptions()),
      ]);
    } catch (err) {
      const reason = err instanceof VerificationError ? err.code : "error";
      if (reason === "error") {
        console.error(`[verify] start failed: ${err instanceof Error ? err.name : "unknown error"}`);
      }
      return errorRedirect(request, reason);
    }
  };
}

export function createVerifyReturnHandler({ getDb }: { getDb: () => Promise<Db> }) {
  return async function GET(request: Request): Promise<Response> {
    const orderId = new URL(request.url).searchParams.get("token");
    const state = readVerifyState(cookieFromHeader(request.headers.get("cookie"), VERIFY_COOKIE_NAME));
    if (!orderId || !state || state.orderId !== orderId) {
      return errorRedirect(request, "session_mismatch");
    }
    try {
      const db = await getDb();
      const principal = await completeVerification(db, orderId);
      return redirect(absoluteUrl(state.returnTo, request), [
        serializeCookie(SESSION_COOKIE_NAME, createSession(principal.id), sessionCookieOptions()),
        clearCookie(VERIFY_COOKIE_NAME),
      ]);
    } catch (err) {
      const reason = err instanceof VerificationError ? err.code : "error";
      if (reason === "error") {
        console.error(`[verify] return failed: ${err instanceof Error ? err.name : "unknown error"}`);
      }
      return errorRedirect(request, reason);
    }
  };
}

export function createLogoutHandler() {
  return async function POST(request: Request): Promise<Response> {
    if (!isSameOriginPost(request)) {
      return forbidden();
    }
    return redirect(absoluteUrl("/", request), [clearCookie(SESSION_COOKIE_NAME)]);
  };
}
