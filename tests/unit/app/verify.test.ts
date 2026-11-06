import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  PrincipalRequiredError,
  principalFromRequest,
  requirePrincipal,
} from "@/server/auth/guard";
import {
  createLogoutHandler,
  createVerifyReturnHandler,
  createVerifyStartHandler,
} from "@/server/auth/routes";
import { SESSION_COOKIE_NAME, VERIFY_COOKIE_NAME, createSession, readSession } from "@/server/auth/session";
import type { Db } from "@/server/db/client";
import { paypalOperations, principals, worlds } from "@/server/db/schema";
import { createTestDb } from "@/server/db/testing";
import { simApprove } from "@/server/rail/simHandler";
import { ensureMainWorldOnce } from "@/server/services/worlds";

const ORIGIN = "https://mandate.test";
const OWNER = { payerId: "OWNERPAYER123", email: "owner@example.com" };

/** `name=value` of the Set-Cookie header for `name`, plus its attributes. */
function setCookie(response: Response, name: string): { value: string; header: string } | null {
  const header = response.headers.getSetCookie().find((h) => h.startsWith(`${name}=`));
  if (!header) {
    return null;
  }
  const value = decodeURIComponent(header.slice(name.length + 1).split(";")[0]!);
  return { value, header };
}

function startRequest(fields: Record<string, string>, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}/verify/start`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, ...headers },
    body: new URLSearchParams(fields).toString(),
  });
}

function returnRequest(search: string, cookie?: string): Request {
  return new Request(`${ORIGIN}/verify/return${search}`, {
    headers: cookie ? { cookie } : {},
  });
}

describe("/verify/start → PayPal → /verify/return (sim rail)", () => {
  let db: Db;
  let start: (request: Request) => Promise<Response>;
  let finish: (request: Request) => Promise<Response>;

  beforeEach(async () => {
    vi.stubEnv("SESSION_SECRET", "unit-test-session-secret-0123456789abcdef");
    vi.stubEnv("PUBLIC_BASE_URL", ORIGIN);
    db = await createTestDb();
    const { worldId } = await ensureMainWorldOnce(db);
    await db.update(worlds).set({ railMode: "sim" }).where(eq(worlds.id, worldId));
    start = createVerifyStartHandler({ getDb: async () => db });
    finish = createVerifyReturnHandler({ getDb: async () => db });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function begin(returnTo?: string) {
    const response = await start(startRequest(returnTo === undefined ? {} : { return_to: returnTo }));
    expect(response.status).toBe(303);
    const approveUrl = response.headers.get("location")!;
    const orderId = new URL(approveUrl).searchParams.get("token")!;
    const state = setCookie(response, VERIFY_COOKIE_NAME);
    expect(state).not.toBeNull();
    expect(state!.header).toMatch(/HttpOnly/i);
    expect(state!.header).toMatch(/SameSite=lax/i);
    return { orderId, verifyCookie: `${VERIFY_COOKIE_NAME}=${encodeURIComponent(state!.value)}` };
  }

  it("redirects to PayPal, then signs the principal in and returns to return_to", async () => {
    const { orderId, verifyCookie } = await begin("/claim/abc?x=1");
    await simApprove(db, orderId, OWNER);

    const response = await finish(returnRequest(`?token=${orderId}&PayerID=${OWNER.payerId}`, verifyCookie));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${ORIGIN}/claim/abc?x=1`);

    const session = setCookie(response, SESSION_COOKIE_NAME);
    expect(session).not.toBeNull();
    expect(session!.header).toMatch(/HttpOnly/i);
    expect(session!.header).toMatch(/SameSite=lax/i);
    expect(session!.header).toMatch(/Max-Age=604800/i);
    const [principal] = await db.select().from(principals);
    expect(readSession(session!.value)).toEqual({ principalId: principal!.id });

    // The one-shot verify cookie is cleared.
    expect(setCookie(response, VERIFY_COOKIE_NAME)?.header).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/i);
  });

  it("defaults to /dashboard and refuses open redirects", async () => {
    for (const evil of ["//evil.example.com/x", "https://evil.example.com", "/\\evil.example.com"]) {
      const { orderId, verifyCookie } = await begin(evil);
      await simApprove(db, orderId, OWNER);
      const response = await finish(returnRequest(`?token=${orderId}`, verifyCookie));
      expect(response.headers.get("location")).toBe(`${ORIGIN}/dashboard`);
    }
    const { orderId, verifyCookie } = await begin();
    await simApprove(db, orderId, OWNER);
    const response = await finish(returnRequest(`?token=${orderId}`, verifyCookie));
    expect(response.headers.get("location")).toBe(`${ORIGIN}/dashboard`);
  });

  it("refuses a return without the browser's verify cookie (order id alone is not enough)", async () => {
    const { orderId } = await begin();
    await simApprove(db, orderId, OWNER);

    const response = await finish(returnRequest(`?token=${orderId}`));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${ORIGIN}/verify/error?reason=session_mismatch`);
    expect(setCookie(response, SESSION_COOKIE_NAME)).toBeNull();
    expect(await db.select().from(principals)).toHaveLength(0);
  });

  it("refuses a verify cookie issued for a different order", async () => {
    const first = await begin();
    const second = await begin();
    await simApprove(db, second.orderId, OWNER);

    const response = await finish(returnRequest(`?token=${second.orderId}`, first.verifyCookie));
    expect(response.headers.get("location")).toBe(`${ORIGIN}/verify/error?reason=session_mismatch`);
    expect(setCookie(response, SESSION_COOKIE_NAME)).toBeNull();
  });

  it("shows an error page for an order that was not approved", async () => {
    const { orderId, verifyCookie } = await begin();
    const response = await finish(returnRequest(`?token=${orderId}`, verifyCookie));
    expect(response.headers.get("location")).toBe(`${ORIGIN}/verify/error?reason=not_approved`);
    expect(setCookie(response, SESSION_COOKIE_NAME)).toBeNull();
  });

  it("never captures the order", async () => {
    const { orderId, verifyCookie } = await begin();
    await simApprove(db, orderId, OWNER);
    await finish(returnRequest(`?token=${orderId}`, verifyCookie));
    const ops = await db.select().from(paypalOperations);
    expect(ops.filter((op) => op.kind === "order.capture")).toHaveLength(0);
  });

  it("rejects a cross-origin POST to /verify/start", async () => {
    const response = await start(startRequest({}, { origin: "https://evil.example.com" }));
    expect(response.status).toBe(403);
    expect(await db.select().from(paypalOperations)).toHaveLength(0);
  });
});

describe("/logout", () => {
  it("clears the session cookie and redirects home", async () => {
    vi.stubEnv("SESSION_SECRET", "unit-test-session-secret-0123456789abcdef");
    const logout = createLogoutHandler();
    const response = await logout(
      new Request(`${ORIGIN}/logout`, { method: "POST", headers: { origin: ORIGIN } }),
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${ORIGIN}/`);
    expect(setCookie(response, SESSION_COOKIE_NAME)?.header).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/i);
    vi.unstubAllEnvs();
  });
});

describe("requirePrincipal", () => {
  beforeEach(() => {
    vi.stubEnv("SESSION_SECRET", "unit-test-session-secret-0123456789abcdef");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const id = "8a4f1c3e-2b5d-4e6f-9a1b-0c2d3e4f5a6b";

  it("returns the principal for a valid session cookie", () => {
    const request = new Request(`${ORIGIN}/dashboard`, {
      headers: { cookie: `other=1; ${SESSION_COOKIE_NAME}=${encodeURIComponent(createSession(id))}` },
    });
    expect(principalFromRequest(request)).toEqual({ principalId: id });
    expect(requirePrincipal(request)).toEqual({ principalId: id });
  });

  it("throws PrincipalRequiredError (401) without a valid session", () => {
    const tampered = createSession(id).replace(/.$/, "x");
    for (const cookie of [undefined, `${SESSION_COOKIE_NAME}=${tampered}`]) {
      const request = new Request(`${ORIGIN}/dashboard`, { headers: cookie ? { cookie } : {} });
      expect(principalFromRequest(request)).toBeNull();
      expect(() => requirePrincipal(request)).toThrow(PrincipalRequiredError);
    }
  });
});
