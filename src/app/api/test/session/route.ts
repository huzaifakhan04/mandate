import { randomBytes } from "crypto";

import { connection } from "next/server";

import { SESSION_COOKIE_NAME, createSession, sanitizeReturnTo, sessionCookieOptions } from "@/server/auth/session";
import { getDb as defaultGetDb, type Db } from "@/server/db/client";
import { principals } from "@/server/db/schema";

import { testEndpointsEnabled } from "../ledger/route";

/**
 * TEST-ONLY — `POST /api/test/session` (form or JSON, optional `name`,
 * `return_to`): signs the browser in as a fresh verified principal, the
 * state a completed Verify with PayPal leaves behind, and 303s to
 * `return_to` (default `/dashboard`). The dev server's main world is on
 * the real PayPal rail, so Playwright can't approve a sandbox order; the
 * Verify round trip itself is covered on the sim rail by
 * tests/unit/app/verify.test.ts. A plain 404 unless
 * `MANDATE_TEST_ENDPOINTS=1` outside production (the `/api/test/ledger` gate).
 */
export function createTestSessionHandler({ getDb }: { getDb: () => Promise<Db> }) {
  return {
    async POST(request: Request): Promise<Response> {
      if (!testEndpointsEnabled()) {
        return new Response(JSON.stringify({ ok: false, error: "not_found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }
      let fields: Record<string, unknown> = {};
      try {
        fields = (request.headers.get("content-type") ?? "").includes("application/json")
          ? ((await request.json()) as Record<string, unknown>)
          : Object.fromEntries((await request.formData()).entries());
      } catch {
        fields = {};
      }
      const name = typeof fields.name === "string" && fields.name.trim() ? fields.name.trim().slice(0, 60) : "Test Owner";
      const suffix = randomBytes(6).toString("hex");
      const db = await getDb();
      const [principal] = await db
        .insert(principals)
        .values({
          paypalPayerId: `TESTPAYER${suffix.toUpperCase()}`,
          email: `owner-${suffix}@example.com`,
          name,
          entityType: "individual",
          verifiedAt: new Date(),
        })
        .returning();
      const options = sessionCookieOptions();
      const cookie = [
        `${SESSION_COOKIE_NAME}=${encodeURIComponent(createSession(principal!.id))}`,
        `Path=${options.path}`,
        `Max-Age=${options.maxAge}`,
        "HttpOnly",
        "SameSite=Lax",
      ].join("; ");
      return new Response(null, {
        status: 303,
        headers: {
          location: new URL(sanitizeReturnTo(fields.return_to), request.url).toString(),
          "set-cookie": cookie,
          "cache-control": "no-store",
        },
      });
    },
  };
}

const handler = createTestSessionHandler({ getDb: defaultGetDb });

/** Always request-time, so the env gate is read per request. */
export async function POST(request: Request): Promise<Response> {
  await connection();
  return handler.POST(request);
}
