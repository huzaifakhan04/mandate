import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  SESSION_COOKIE_NAME,
  SESSION_TTL_SECONDS,
  createSession,
  createVerifyState,
  readSession,
  readVerifyState,
  sanitizeReturnTo,
  sessionCookieOptions,
  sessionSecret,
} from "@/server/auth/session";

const PRINCIPAL = "8a4f1c3e-2b5d-4e6f-9a1b-0c2d3e4f5a6b";

describe("session cookie", () => {
  beforeEach(() => {
    vi.stubEnv("SESSION_SECRET", "unit-test-session-secret-0123456789abcdef");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is named mandate_session and lasts 7 days", () => {
    expect(SESSION_COOKIE_NAME).toBe("mandate_session");
    expect(SESSION_TTL_SECONDS).toBe(7 * 24 * 60 * 60);
  });

  it("round-trips the principal id", () => {
    const value = createSession(PRINCIPAL);
    expect(readSession(value)).toEqual({ principalId: PRINCIPAL });
  });

  it("returns null for a tampered payload or signature", () => {
    const value = createSession(PRINCIPAL);
    const [version, payload, signature] = value.split(".") as [string, string, string];
    const forged = Buffer.from(
      JSON.stringify({ typ: "session", pid: "00000000-0000-4000-8000-000000000000", exp: 9_999_999_999 }),
    ).toString("base64url");
    expect(readSession(`${version}.${forged}.${signature}`)).toBeNull();
    const flipped = signature.slice(0, -1) + (signature.endsWith("A") ? "B" : "A");
    expect(readSession(`${version}.${payload}.${flipped}`)).toBeNull();
    expect(readSession(`${version}.${payload}.`)).toBeNull();
    expect(readSession(`${version}.${payload}`)).toBeNull();
    expect(readSession("")).toBeNull();
    expect(readSession(null)).toBeNull();
    expect(readSession(undefined)).toBeNull();
    expect(readSession("garbage")).toBeNull();
  });

  it("returns null for a cookie signed with another secret", () => {
    const value = createSession(PRINCIPAL);
    vi.stubEnv("SESSION_SECRET", "a-completely-different-secret-0123456789");
    expect(readSession(value)).toBeNull();
  });

  it("returns null once expired", () => {
    const issued = new Date("2026-11-01T00:00:00Z");
    const value = createSession(PRINCIPAL, { now: issued });
    const justBefore = new Date(issued.getTime() + (SESSION_TTL_SECONDS - 1) * 1000);
    const atExpiry = new Date(issued.getTime() + SESSION_TTL_SECONDS * 1000);
    expect(readSession(value, { now: justBefore })).toEqual({ principalId: PRINCIPAL });
    expect(readSession(value, { now: atExpiry })).toBeNull();
  });

  it("does not accept a verify-state token as a session (and vice versa)", () => {
    const state = createVerifyState({ orderId: "ORDER-1", returnTo: "/dashboard" });
    expect(readSession(state)).toBeNull();
    expect(readVerifyState(createSession(PRINCIPAL))).toBeNull();
    expect(readVerifyState(state)).toEqual({ orderId: "ORDER-1", returnTo: "/dashboard" });
  });

  it("sets HttpOnly, SameSite=Lax, path / and a 7-day max age; Secure only in production", () => {
    expect(sessionCookieOptions()).toMatchObject({
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: SESSION_TTL_SECONDS,
      secure: false,
    });
    vi.stubEnv("NODE_ENV", "production");
    expect(sessionCookieOptions().secure).toBe(true);
  });
});

describe("sessionSecret", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("throws clearly in production when SESSION_SECRET is missing or short", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SESSION_SECRET", "");
    expect(() => sessionSecret()).toThrow(/SESSION_SECRET/);
    vi.stubEnv("SESSION_SECRET", "too-short");
    expect(() => sessionSecret()).toThrow(/SESSION_SECRET/);
  });

  it("falls back to a fixed dev value outside production", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("SESSION_SECRET", "");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const first = sessionSecret();
    expect(first.length).toBeGreaterThanOrEqual(32);
    expect(sessionSecret()).toBe(first);
    warn.mockRestore();
  });
});

describe("sanitizeReturnTo (open-redirect guard)", () => {
  it.each([
    ["/dashboard", "/dashboard"],
    ["/claim/abc?x=1#h", "/claim/abc?x=1#h"],
    ["/", "/"],
  ])("keeps same-origin relative path %s", (input, expected) => {
    expect(sanitizeReturnTo(input)).toBe(expected);
  });

  it.each([
    "//evil.example.com",
    "/\\evil.example.com",
    "\\\\evil.example.com",
    "https://evil.example.com/dashboard",
    "javascript:alert(1)",
    "dashboard",
    "/%0d%0aSet-Cookie:x",
    "/ok\nnext",
    "",
    null,
    undefined,
    42,
  ])("falls back to /dashboard for %s", (input) => {
    expect(sanitizeReturnTo(input)).toBe("/dashboard");
  });
});
