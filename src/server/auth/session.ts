import { createHmac, timingSafeEqual } from "crypto";

/**
 * Stateless owner sessions (P2 Global Constraints, "Session"): the
 * `mandate_session` cookie holds `v1.<payload>.<signature>` where
 * `payload` is base64url JSON `{ typ: "session", pid, exp }` and
 * `signature` is base64url HMAC-SHA256 over `v1.<payload>` keyed by
 * `SESSION_SECRET`. Nothing is stored server-side; logout clears the
 * cookie. The same signing is used for the short-lived `mandate_verify`
 * cookie that binds a Verify-with-PayPal round trip to the browser that
 * started it — a distinct `typ` keeps one from being accepted as the other.
 */

export const SESSION_COOKIE_NAME = "mandate_session";
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

export const VERIFY_COOKIE_NAME = "mandate_verify";
/** How long the browser has to approve the $0.01 order and come back. */
export const VERIFY_TTL_SECONDS = 30 * 60;

export const DEFAULT_RETURN_TO = "/dashboard";

const VERSION = "v1";
const MIN_SECRET_LENGTH = 32;
/** Dev/test only — never used when NODE_ENV is production. */
const DEV_SESSION_SECRET = "mandate-dev-only-session-secret-not-for-production";

let warnedDevSecret = false;

/**
 * `SESSION_SECRET`. In production a missing or short (< 32 chars) secret
 * throws; elsewhere a fixed dev value is used with a one-time warning.
 */
export function sessionSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (process.env.NODE_ENV === "production") {
    if (!secret || secret.length < MIN_SECRET_LENGTH) {
      throw new Error(
        `SESSION_SECRET must be set to at least ${MIN_SECRET_LENGTH} characters in production ` +
          "(it signs the mandate_session cookie). Generate one with `openssl rand -base64 48`.",
      );
    }
    return secret;
  }
  if (secret) {
    return secret;
  }
  if (!warnedDevSecret) {
    warnedDevSecret = true;
    console.warn("[session] SESSION_SECRET is not set; using a fixed development secret (never in production).");
  }
  return DEV_SESSION_SECRET;
}

function sign(data: string): Buffer {
  return createHmac("sha256", sessionSecret()).update(data).digest();
}

function encode(payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signed = `${VERSION}.${body}`;
  return `${signed}.${sign(signed).toString("base64url")}`;
}

const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

/** The verified payload of `value` with the given `typ`, unexpired at `now`; otherwise `null`. */
function decode(value: unknown, typ: string, now: Date): Record<string, unknown> | null {
  if (typeof value !== "string" || value.length > 4096) {
    return null;
  }
  const parts = value.split(".");
  if (parts.length !== 3) {
    return null;
  }
  const [version, body, signature] = parts as [string, string, string];
  if (version !== VERSION || !BASE64URL_RE.test(body) || !BASE64URL_RE.test(signature)) {
    return null;
  }
  const expected = sign(`${version}.${body}`);
  const given = Buffer.from(signature, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return null;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  if (record.typ !== typ || typeof record.exp !== "number" || record.exp * 1000 <= now.getTime()) {
    return null;
  }
  return record;
}

function expiresAt(now: Date, ttlSeconds: number): number {
  return Math.floor(now.getTime() / 1000) + ttlSeconds;
}

export interface SessionData {
  principalId: string;
}

/** A signed `mandate_session` cookie value for `principalId`, valid for 7 days from `now`. */
export function createSession(principalId: string, options: { now?: Date } = {}): string {
  const now = options.now ?? new Date();
  return encode({ typ: "session", pid: principalId, exp: expiresAt(now, SESSION_TTL_SECONDS) });
}

/**
 * The session in a `mandate_session` cookie value, or `null` when it's
 * missing, malformed, signed with another key (constant-time compare) or
 * expired.
 */
export function readSession(value: string | null | undefined, options: { now?: Date } = {}): SessionData | null {
  const payload = decode(value, "session", options.now ?? new Date());
  if (!payload || typeof payload.pid !== "string" || payload.pid.length === 0) {
    return null;
  }
  return { principalId: payload.pid };
}

export interface VerifyState {
  orderId: string;
  returnTo: string;
}

/** The signed `mandate_verify` cookie value: which order this browser started, and where to go after. */
export function createVerifyState(state: VerifyState, options: { now?: Date } = {}): string {
  const now = options.now ?? new Date();
  return encode({
    typ: "verify",
    oid: state.orderId,
    rt: sanitizeReturnTo(state.returnTo),
    exp: expiresAt(now, VERIFY_TTL_SECONDS),
  });
}

export function readVerifyState(value: string | null | undefined, options: { now?: Date } = {}): VerifyState | null {
  const payload = decode(value, "verify", options.now ?? new Date());
  if (!payload || typeof payload.oid !== "string" || typeof payload.rt !== "string") {
    return null;
  }
  return { orderId: payload.oid, returnTo: sanitizeReturnTo(payload.rt) };
}

export interface CookieOptions {
  httpOnly: true;
  secure: boolean;
  sameSite: "lax";
  path: "/";
  maxAge: number;
}

/** `mandate_session`: HttpOnly, SameSite=Lax, path `/`, 7 days; Secure in production. */
export function sessionCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  };
}

/** `mandate_verify`: like the session cookie, but 30 minutes. */
export function verifyCookieOptions(): CookieOptions {
  return { ...sessionCookieOptions(), maxAge: VERIFY_TTL_SECONDS };
}

const UNSAFE_RETURN_TO_RE = /[\\\u0000-\u001f\u007f]/;

/**
 * Open-redirect guard: `value` if it is a same-origin relative path
 * (`/…`, not `//…`, no backslashes or control characters, nothing that
 * resolves to another origin), else `/dashboard`.
 */
export function sanitizeReturnTo(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) {
    return DEFAULT_RETURN_TO;
  }
  if (!value.startsWith("/") || value.startsWith("//") || UNSAFE_RETURN_TO_RE.test(value)) {
    return DEFAULT_RETURN_TO;
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return DEFAULT_RETURN_TO;
  }
  if (decoded.startsWith("//") || UNSAFE_RETURN_TO_RE.test(decoded)) {
    return DEFAULT_RETURN_TO;
  }
  const base = "http://return-to.invalid";
  let url: URL;
  try {
    url = new URL(value, base);
  } catch {
    return DEFAULT_RETURN_TO;
  }
  if (url.origin !== base) {
    return DEFAULT_RETURN_TO;
  }
  return `${url.pathname}${url.search}${url.hash}`;
}
